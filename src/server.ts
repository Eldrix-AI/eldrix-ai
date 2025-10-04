// src/server.ts
import express, { Request, Response } from "express";
import dotenv from "dotenv";
import Twilio from "twilio";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { put } from "@vercel/blob";
import { createWriteStream } from "fs";
import { promisify } from "util";
import { pipeline } from "stream";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

dotenv.config();
const {
  PORT = "3000",
  FORWARD_NUMBER = "+17206122979", // Default forward number
  TWILIO_PHONE_NUMBER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  // Admin phone number for notifications (default to forward number)
  ADMIN_PHONE = FORWARD_NUMBER,

  // Database configuration from .env
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT,
  DATABASE_URL,

  // Vercel Blob configuration
  BLOB_READ_WRITE_TOKEN,

  // Stripe configuration
  STRIPE_SECRET_KEY,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  throw new Error(
    "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER in .env"
  );
}

// Check for required database environment variables
if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
  console.warn(
    "Missing database credentials in .env file. Database features will not work properly."
  );
}

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { VoiceResponse, MessagingResponse } = Twilio.twiml;
const app = express();

// Vercel Blob is configured via environment variable

// Create database connection pool using DATABASE_URL or individual parameters
let dbPool: Pool;
try {
  if (DATABASE_URL) {
    // Use connection string if available
    console.log("Connecting to database using DATABASE_URL");
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    });
  } else if (DB_HOST && DB_USER && DB_PASSWORD && DB_NAME) {
    // Use individual parameters
    console.log("Connecting to database using individual credentials");
    dbPool = new Pool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT ? parseInt(DB_PORT, 10) : 5432,
      ssl: {
        rejectUnauthorized: false,
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  } else {
    // Create a placeholder pool that will throw errors when used
    console.error(
      "No database credentials provided. Database functionality will be unavailable."
    );
    dbPool = {} as Pool;
  }
} catch (error) {
  console.error("Error creating database pool:", error);
  dbPool = {} as Pool;
}

// Helper function to clean phone numbers (remove +1, dashes, parentheses, etc.)
function cleanPhoneNumber(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

// Define User type
interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  [key: string]: any; // For other fields we may not use directly
}

// Function to find user by phone number with Stripe subscription data
async function findUserByPhone(phone: string): Promise<User | null> {
  const cleanedPhone = cleanPhoneNumber(phone);
  console.log(`🔍 Looking up user with phone: ${cleanedPhone}`);

  try {
    console.log(
      `⚠️ DEBUG - Database query: "SELECT * FROM User WHERE phone LIKE '%${cleanedPhone}%'"`
    );

    // Check if dbPool is properly initialized
    if (!dbPool || !dbPool.query) {
      console.error("⚠️ ERROR - Database pool is not properly initialized!");
      return null;
    }

    const result = await dbPool.query(
      'SELECT * FROM "User" WHERE phone LIKE $1',
      [`%${cleanedPhone}%`]
    );
    const rows = result.rows;

    if (Array.isArray(rows) && rows.length > 0) {
      const user = rows[0] as User;
      console.log(`✅ User found: ${user.name}`);

      // Log Stripe subscription info for debugging
      console.log(
        `💳 Stripe info - Customer ID: ${user.stripeCustomerId}, Subscription ID: ${user.stripeSubscriptionId}, Usage ID: ${user.stripeUsageId}`
      );

      return user;
    } else {
      console.log("❌ No user found with that phone number");
      return null;
    }
  } catch (error) {
    console.error("Database error:", error);
    return null;
  }
}

// Function to get user's subscription type and session limits
async function getUserSubscriptionInfo(userId: string): Promise<{
  subscriptionType: "free" | "pay-as-you-go" | "subscription";
  sessionLimit: number;
  hasUnlimitedSessions: boolean;
  freeSessionsRemaining: number;
}> {
  try {
    // Get user's Stripe data
    const userResult = await dbPool.query(
      'SELECT "stripeSubscriptionId", "stripeUsageId", "stripeCustomerId" FROM "User" WHERE id = $1',
      [userId]
    );
    const userRows = userResult.rows;

    if (!Array.isArray(userRows) || userRows.length === 0) {
      // No user found - treat as free
      return {
        subscriptionType: "free",
        sessionLimit: 3,
        hasUnlimitedSessions: false,
        freeSessionsRemaining: 3,
      };
    }

    const userData = userRows[0];

    if (userData.stripeSubscriptionId) {
      // Monthly/Yearly subscription - unlimited sessions
      return {
        subscriptionType: "subscription",
        sessionLimit: -1, // -1 means unlimited
        hasUnlimitedSessions: true,
        freeSessionsRemaining: -1,
      };
    } else if (userData.stripeUsageId) {
      // Pay-as-you-go - 3 free sessions, then billing
      const sessionCount = await countUserSessions(userId);
      const freeSessionsRemaining = Math.max(0, 3 - sessionCount);

      return {
        subscriptionType: "pay-as-you-go",
        sessionLimit: -1, // Unlimited after free sessions
        hasUnlimitedSessions: true,
        freeSessionsRemaining: freeSessionsRemaining,
      };
    } else {
      // Free plan - 3 sessions per month
      const sessionCount = await countUserSessions(userId);
      const freeSessionsRemaining = Math.max(0, 3 - sessionCount);

      return {
        subscriptionType: "free",
        sessionLimit: 3,
        hasUnlimitedSessions: false,
        freeSessionsRemaining: freeSessionsRemaining,
      };
    }
  } catch (error) {
    console.error("Error getting user subscription info:", error);
    // Default to free plan on error
    return {
      subscriptionType: "free",
      sessionLimit: 3,
      hasUnlimitedSessions: false,
      freeSessionsRemaining: 3,
    };
  }
}

// Function to count user's help sessions for the current month
async function countUserSessions(userId: string) {
  try {
    // Get first and last day of the current month
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Format dates for MySQL (YYYY-MM-DD)
    const firstDayFormatted = firstDayOfMonth.toISOString().slice(0, 10);
    const nextMonthFormatted = nextMonth.toISOString().slice(0, 10);

    console.log(
      `⚠️ DEBUG - Counting sessions for user ${userId} between ${firstDayFormatted} and ${nextMonthFormatted}`
    );

    // Query that only counts COMPLETED sessions from the current month
    // Exclude active sessions (completed = false) since they don't count against the limit
    const result = await dbPool.query(
      'SELECT COUNT(*) as count FROM "HelpSession" WHERE "userId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3 AND completed = true',
      [userId, firstDayFormatted, nextMonthFormatted]
    );
    const rows = result.rows;

    if (Array.isArray(rows) && rows.length > 0) {
      const count = (rows[0] as any).count;
      console.log(
        `📊 User has ${count} completed help sessions this month (${now.toLocaleString(
          "default",
          { month: "long" }
        )})`
      );
      return count;
    }
    return 0;
  } catch (error) {
    console.error("Database error counting sessions:", error);
    console.error(error);
    return 0;
  }
}

// Function to check if phone number has already used a free trial
async function hasUsedFreeTrial(phone: string): Promise<boolean> {
  const cleanedPhone = cleanPhoneNumber(phone);
  console.log(`🔍 Checking if phone ${cleanedPhone} has used free trial`);

  try {
    const result = await dbPool.query(
      'SELECT * FROM "FreeTrial" WHERE phone LIKE $1',
      [`%${cleanedPhone}%`]
    );
    const rows = result.rows;

    const hasUsed = Array.isArray(rows) && rows.length > 0;
    console.log(
      hasUsed
        ? `⛔ Phone ${cleanedPhone} has already used a free trial on ${new Date(
            (rows[0] as any).createdAt
          ).toLocaleDateString()}`
        : `✅ Phone ${cleanedPhone} has not used a free trial yet`
    );

    return hasUsed;
  } catch (error) {
    console.error("Database error checking free trial:", error);
    return false; // In case of error, allow the free trial (fail open)
  }
}

// Function to record a free trial usage
async function recordFreeTrial(phone: string): Promise<boolean> {
  const cleanedPhone = cleanPhoneNumber(phone);
  console.log(`📝 Recording free trial for phone ${cleanedPhone}`);

  try {
    await dbPool.query(
      'INSERT INTO "FreeTrial" (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING',
      [cleanedPhone]
    );

    console.log(`✅ Successfully recorded free trial for ${cleanedPhone}`);
    return true;
  } catch (error) {
    console.error("Database error recording free trial:", error);
    return false;
  }
}

// Function to report usage to Stripe for pay-as-you-go users (only after 3 free sessions)
async function reportStripeUsage(
  userId: string,
  sessionId: string
): Promise<boolean> {
  console.log(
    `💳 Reporting Stripe usage for user ${userId}, session ${sessionId}`
  );

  try {
    // Get user's subscription info to check if they should be billed
    const subscriptionInfo = await getUserSubscriptionInfo(userId);

    // Only bill pay-as-you-go users who have used their 3 free sessions
    if (subscriptionInfo.subscriptionType !== "pay-as-you-go") {
      console.log(
        `ℹ️ User ${userId} is not on pay-as-you-go plan - skipping usage reporting`
      );
      return true; // Not an error, just not applicable
    }

    // Check if user still has free sessions remaining
    if (subscriptionInfo.freeSessionsRemaining > 0) {
      console.log(
        `ℹ️ User ${userId} still has ${subscriptionInfo.freeSessionsRemaining} free sessions remaining - skipping billing`
      );
      return true; // Not an error, just not applicable
    }

    // Get user's Stripe data
    const userResult = await dbPool.query(
      'SELECT "stripeCustomerId", "stripeUsageId", "stripeSubscriptionId" FROM "User" WHERE id = $1',
      [userId]
    );
    const userRows = userResult.rows;

    if (!Array.isArray(userRows) || userRows.length === 0) {
      console.log(`❌ No user found with ID ${userId}`);
      return false;
    }

    const userData = userRows[0];

    if (!userData.stripeUsageId) {
      console.log(
        `ℹ️ User ${userId} has no usage ID - skipping usage reporting`
      );
      return true; // Not an error, just not applicable
    }

    if (!userData.stripeCustomerId) {
      console.error(`❌ User ${userId} has usage ID but no customer ID`);
      return false;
    }

    console.log(
      `💳 Processing usage-based billing for pay-as-you-go user ${userId} (after free sessions)`
    );

    // Report usage to Stripe using the meter events API
    const response = await fetch(
      `https://api.stripe.com/v1/billing/meter_events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          event_name: "api_requests", // The meter name configured in Stripe
          "payload[value]": "1", // The value to increment by
          "payload[stripe_customer_id]": userData.stripeCustomerId, // Customer ID is required
        }).toString(),
      }
    );

    const result = await response.json();

    if (response.ok) {
      console.log(
        `✅ Successfully reported usage to Stripe for user ${userId}:`,
        result
      );

      // Store usage record in StripeUsage table
      try {
        const usageId = uuidv4();
        await dbPool.query(
          'INSERT INTO "StripeUsage" (id, "userId", "stripeUsageId", "stripeCustomerId", "sessionId", "usageType", quantity, "unitPrice", "totalAmount", status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT ("stripeUsageId") DO NOTHING',
          [
            usageId,
            userId,
            userData.stripeUsageId,
            userData.stripeCustomerId,
            sessionId,
            "help_session",
            1, // quantity
            0.0, // unitPrice - will be set by Stripe
            0.0, // totalAmount - will be set by Stripe
            "pending",
          ]
        );
        console.log(`✅ Stored usage record in database: ${usageId}`);
      } catch (dbError) {
        console.error("Error storing usage record in database:", dbError);
        // Don't fail the whole operation if we can't store the record
      }

      return true;
    } else {
      console.error(`❌ Failed to report usage to Stripe:`, result);
      return false;
    }
  } catch (error) {
    console.error("Error reporting usage to Stripe:", error);
    return false;
  }
}

// Function to create a help session record when a user connects to representative
async function createHelpSession(
  userId: string,
  callType: string = "phone",
  initialMessage: string = ""
): Promise<string | null> {
  console.log(`📝 Creating help session for user ${userId}, type: ${callType}`);

  try {
    const now = new Date(); // Use JavaScript Date object directly, matching the external system

    // Generate a UUID for the session
    const sessionId = uuidv4();

    // Set appropriate title based on type
    const title =
      callType === "sms"
        ? `Text Message Support - ${new Date().toLocaleDateString()}`
        : `Phone Support - ${new Date().toLocaleDateString()}`;

    // Set lastMessage if provided
    const lastMessageValue = initialMessage ? initialMessage : null;

    // Get user data to check subscription status for priority setting
    let priority = "medium"; // Default priority
    try {
      const subscriptionInfo = await getUserSubscriptionInfo(userId);

      // Set priority based on subscription status
      if (subscriptionInfo.subscriptionType === "subscription") {
        priority = "high";
        console.log(
          `💳 User ${userId} has active subscription - setting priority to HIGH`
        );
      } else if (subscriptionInfo.subscriptionType === "pay-as-you-go") {
        // Pay-as-you-go users get medium priority
        priority = "medium";
        console.log(
          `💳 User ${userId} is on pay-as-you-go plan - setting priority to MEDIUM`
        );
      } else {
        // Free users get low priority
        priority = "low";
        console.log(
          `💳 User ${userId} is a free user - setting priority to LOW`
        );
      }
    } catch (userError) {
      console.error("Error fetching user subscription data:", userError);
      // Keep default medium priority if we can't fetch user data
    }

    // Insert a new help session record with priority based on subscription status
    await dbPool.query(
      'INSERT INTO "HelpSession" (id, "userId", type, title, status, priority, "createdAt", "updatedAt", "lastMessage") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        sessionId,
        userId,
        callType,
        title,
        "ongoing",
        priority, // Set priority based on subscription status
        now,
        now,
        lastMessageValue,
      ]
    );

    console.log(
      `✅ Successfully created help session ${sessionId} for user ${userId} with priority: ${priority}`
    );

    // Report usage to Stripe for pay-as-you-go users (only for new sessions)
    try {
      await reportStripeUsage(userId, sessionId);
    } catch (usageError) {
      console.error("Error reporting usage to Stripe:", usageError);
      // Don't fail the session creation if usage reporting fails
    }

    // Return the session ID so we can add messages to it
    return sessionId;
  } catch (error) {
    console.error("Database error creating help session:", error);
    console.error(error);
    return null;
  }
}

// Function to create a message record in the Message table
async function createMessage(
  helpSessionId: string,
  content: string,
  isAdmin: boolean = false
): Promise<boolean> {
  console.log(`📝 Creating message for help session ${helpSessionId}`);

  try {
    // Generate a UUID for the message
    const messageId = uuidv4();
    const now = new Date(); // Use JavaScript Date object directly, matching the external system

    // Insert the message record
    await dbPool.query(
      'INSERT INTO "Message" (id, content, "isAdmin", "helpSessionId", "createdAt", read) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        messageId,
        content,
        isAdmin,
        helpSessionId,
        now, // PostgreSQL can accept JavaScript Date objects
        false, // not read initially
      ]
    );

    // Update the lastMessage field in the HelpSession table
    await dbPool.query(
      'UPDATE "HelpSession" SET "lastMessage" = $1, "updatedAt" = $2 WHERE id = $3',
      [content, now, helpSessionId]
    );

    console.log(
      `✅ Successfully created message ${messageId} in help session ${helpSessionId}`
    );
    return true;
  } catch (error) {
    console.error("Database error creating message:", error);
    console.error(error);
    return false;
  }
}

// Function to send SMS notifications
async function sendSmsNotification(
  reason: string,
  callerNumber: string,
  details: string = ""
): Promise<boolean> {
  try {
    // Format the phone number for display
    const formattedPhone = callerNumber.replace(/^\+1/, "");

    // Create message for admin
    const adminMessage = `ELDRIX IVR ALERT: ${formattedPhone} tried to call but was ${reason}. ${details}`;

    console.log(`📲 SENDING SMS NOTIFICATION: ${adminMessage}`);

    // Only send if we have valid Twilio credentials and phone numbers
    if (
      TWILIO_ACCOUNT_SID &&
      TWILIO_AUTH_TOKEN &&
      TWILIO_PHONE_NUMBER &&
      ADMIN_PHONE
    ) {
      // Send to admin/representative
      await client.messages.create({
        body: adminMessage,
        from: TWILIO_PHONE_NUMBER,
        to: ADMIN_PHONE,
      });

      console.log(`✅ SMS notification sent to admin (${ADMIN_PHONE})`);
      return true;
    } else {
      console.warn(
        "⚠️ SMS notification not sent - missing Twilio credentials or phone numbers"
      );
      return false;
    }
  } catch (error) {
    console.error("Error sending SMS notification:", error);
    return false;
  }
}

// Twilio posts form‑encoded data
app.use(express.urlencoded({ extended: false }));

// Add JSON parser for API endpoints
app.use(express.json());

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

// Debug endpoint to check phone number configuration
app.get("/api/debug/phone", (_req, res) => {
  res.json({
    forwardNumber: FORWARD_NUMBER,
    adminPhone: ADMIN_PHONE,
    twilioPhoneNumber: TWILIO_PHONE_NUMBER,
    forwardNumberLength: FORWARD_NUMBER.length,
    expectedLength: 12, // +1 + 10 digits
    timestamp: new Date().toISOString(),
  });
});

// Test endpoint to make a direct call (for debugging)
app.post("/api/test-call", (req: Request, res: Response): void => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    res.status(400).json({ error: "phoneNumber is required" });
    return;
  }

  (async () => {
    try {
      console.log(`🧪 TEST CALL: Attempting to call ${phoneNumber}`);

      const call = await client.calls.create({
        to: phoneNumber,
        from: TWILIO_PHONE_NUMBER,
        url: `${
          process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : `https://${req.get("host")}`
        }/twilio/test-voice`,
      });

      res.json({
        success: true,
        callSid: call.sid,
        to: phoneNumber,
        from: TWILIO_PHONE_NUMBER,
      });
    } catch (error) {
      console.error("Test call error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })();

  return; // Explicit return to satisfy TypeScript
});

// Test voice endpoint for direct calls
app.post("/twilio/test-voice", (req: Request, res: Response) => {
  const resp = new VoiceResponse();
  resp.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    "<speak>This is a test call from Eldrix. If you can hear this, your phone number is working correctly!</speak>"
  );
  resp.hangup();
  res.type("text/xml").send(resp.toString());
});

// Simple test endpoint to generate TwiML for dialing
app.get("/api/test-dial", (req: Request, res: Response) => {
  const resp = new VoiceResponse();

  console.log(`🧪 TEST DIAL: Creating simple dial to ${FORWARD_NUMBER}`);

  const dial = resp.dial({
    timeout: 30,
    action: `${
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `https://${req.get("host")}`
    }/twilio/no-answer`,
    method: "POST",
  });

  dial.number(FORWARD_NUMBER);

  console.log(`🧪 TEST DIAL: Generated TwiML:`, resp.toString());

  res.type("text/xml").send(resp.toString());
});

// 1) Inbound call: IVR menu
app.post("/twilio/voice", (req: Request, res: Response) => {
  console.log("📞 INCOMING CALL", {
    from: req.body.From,
    to: req.body.To,
    callSid: req.body.CallSid,
    digits: req.body.Digits,
    status: req.body.CallStatus,
    timestamp: new Date().toISOString(),
  });

  const digits = req.body.Digits;
  // Force HTTPS for all deployments (especially Vercel)
  const host = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : req.get("host")?.includes("ngrok")
    ? `https://${req.get("host")}`
    : `${req.protocol}://${req.get("host")}`;
  const resp = new VoiceResponse();

  // Check if this is a response to the gather with digits
  if (digits) {
    console.log(`🔢 CALLER PRESSED: ${digits}`);

    // Process the input here directly
    if (digits === "1") {
      // Option 1: Connect account - Look up by phone number
      console.log("🔄 OPTION 1 SELECTED: Account Lookup");

      // Make the response async to handle database operations
      (async () => {
        try {
          const callerNumber = req.body.From || "";
          console.log("⚠️ DEBUG - Option 1: Caller number:", callerNumber);

          console.log("⚠️ DEBUG - Option 1: Trying to find user in database");
          const user = await findUserByPhone(callerNumber);
          console.log("⚠️ DEBUG - Option 1: After findUserByPhone call");

          if (user) {
            // User found - get their subscription info
            const subscriptionInfo = await getUserSubscriptionInfo(user.id);

            console.log(
              `⚠️ DEBUG - User ${user.name} has ${subscriptionInfo.subscriptionType} plan with ${subscriptionInfo.freeSessionsRemaining} free sessions remaining`
            );

            // Prepare additional user info for the greeting
            const techUsage = user.techUsage || "not specified";
            const experienceLevel = user.experienceLevel || "beginner";
            const accessibilityNeeds = user.accessibilityNeeds || "none";

            console.log(
              `⚠️ DEBUG - User profile: Tech usage: ${techUsage}, Experience: ${experienceLevel}, Accessibility: ${accessibilityNeeds}`
            );

            // Check if user can make more sessions
            if (
              subscriptionInfo.subscriptionType === "free" &&
              subscriptionInfo.freeSessionsRemaining <= 0
            ) {
              // Free user has used all sessions
              console.log(
                "⚠️ DEBUG - Free user has reached session limit in Option 1"
              );

              // Prepare the full response
              let responseText = `<speak>Hello ${user.name}! <break time='200ms'/> `;
              responseText += `Your account email is ${user.email}. <break time='200ms'/> `;
              responseText += `Your tech usage is ${techUsage} with ${experienceLevel} experience level. <break time='300ms'/> `;
              responseText += `You have used all 3 of your help sessions for this month. <break time='300ms'/> `;
              responseText += `Please check back next month for more available sessions. <break time='300ms'/> Goodbye!</speak>`;

              resp.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                responseText
              );

              resp.hangup();
            } else {
              // User can make more sessions - provide options to press 2
              console.log(
                "⚠️ DEBUG - User has sessions remaining, presenting option to press 2"
              );

              // Use gather to allow pressing 2 after the info is given
              const gather = resp.gather({
                numDigits: 1,
                action: `${host}/twilio/voice`,
                method: "POST",
              });

              // Prepare the gather message based on subscription type
              let gatherText = `<speak>Hello ${user.name}! <break time='200ms'/> `;
              gatherText += `Your account email is ${user.email}. <break time='200ms'/> `;
              gatherText += `Your tech usage is ${techUsage} with ${experienceLevel} experience level. <break time='300ms'/> `;

              if (subscriptionInfo.subscriptionType === "subscription") {
                gatherText += `You have unlimited help sessions with your subscription. <break time='300ms'/> `;
              } else if (
                subscriptionInfo.subscriptionType === "pay-as-you-go"
              ) {
                if (subscriptionInfo.freeSessionsRemaining > 0) {
                  gatherText += `You have ${
                    subscriptionInfo.freeSessionsRemaining
                  } free help ${
                    subscriptionInfo.freeSessionsRemaining === 1
                      ? "session"
                      : "sessions"
                  } remaining this month. <break time='300ms'/> `;
                } else {
                  gatherText += `You have unlimited help sessions with pay-as-you-go billing. <break time='300ms'/> `;
                }
              } else {
                gatherText += `You have ${
                  subscriptionInfo.freeSessionsRemaining
                } help ${
                  subscriptionInfo.freeSessionsRemaining === 1
                    ? "session"
                    : "sessions"
                } remaining this month. <break time='300ms'/> `;
              }

              gatherText += `To schedule a new session, please press 2 now to talk to a representative.</speak>`;

              gather.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                gatherText
              );

              // If no input received after timeout
              resp.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                "<speak>We didn't receive any input. <break time='200ms'/> Goodbye!</speak>"
              );
              resp.hangup();
            }
          } else {
            // No user found - gather to allow them to press 2
            console.log(
              "⚠️ DEBUG - No user found, presenting option to press 2"
            );

            // Use gather to allow pressing 2
            const gather = resp.gather({
              numDigits: 1,
              action: `${host}/twilio/voice`,
              method: "POST",
            });

            gather.say(
              {
                voice: "Polly.Joanna",
                language: "en-US",
              },
              "<speak>We couldn't find an account with your phone number. <break time='300ms'/> To create an account, please press 2 now to talk to a representative.</speak>"
            );

            // If no input received
            resp.say(
              {
                voice: "Polly.Joanna",
                language: "en-US",
              },
              "<speak>No input received. <break time='200ms'/> Goodbye!</speak>"
            );
            resp.hangup();
          }
          res.type("text/xml").send(resp.toString());
        } catch (error) {
          console.error("Error in account lookup:", error);
          resp.say(
            {
              voice: "Polly.Joanna",
              language: "en-US",
            },
            "<speak>We're sorry, there was an error connecting to your account. <break time='300ms'/> Please press 2 to talk to a representative who can help you. <break time='300ms'/> Goodbye!</speak>"
          );
          resp.hangup();
          res.type("text/xml").send(resp.toString());
        }
      })();

      // Return early to prevent the default response
      return;
    } else if (digits === "2") {
      // Option 2: Talk to representative - WITH USER LOOKUP
      console.log(
        `👩‍💼 OPTION 2 SELECTED: Looking up user before forwarding to ${FORWARD_NUMBER}`
      );

      // Make this async to handle database operations
      (async () => {
        try {
          // Force HTTPS for all deployments (especially Vercel)
          const host = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : req.get("host")?.includes("ngrok")
            ? `https://${req.get("host")}`
            : `${req.protocol}://${req.get("host")}`;

          // Get caller's number
          const callerNumber = req.body.From || "";
          console.log(`📞 OPTION 2: Caller number: ${callerNumber}`);

          // Look up the user by phone number
          const user = await findUserByPhone(callerNumber);

          // Check for active sessions and session count
          let whisperType = "unknown";
          let whisperName = "";
          let existingSessionId = null;
          let isActiveSession = false;
          let reachedSessionLimit = false;

          if (user) {
            // Registered user found - check their subscription info
            const subscriptionInfo = await getUserSubscriptionInfo(user.id);

            console.log(
              `✅ Found registered user: ${user.name} (${subscriptionInfo.subscriptionType} plan)`
            );

            // Check if user can make more sessions
            if (
              subscriptionInfo.subscriptionType === "free" &&
              subscriptionInfo.freeSessionsRemaining <= 0
            ) {
              // Free user has used all sessions
              console.log(
                `⛔ FREE USER ${user.name} HAS REACHED SESSION LIMIT`
              );
              reachedSessionLimit = true;

              // Prepare response for users who hit their session limit
              resp.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                `<speak>Hello ${user.name}! <break time='200ms'/> You have used all 3 of your help sessions for this month. <break time='300ms'/> Please check back next month for more available sessions. <break time='300ms'/> Goodbye!</speak>`
              );

              resp.hangup();
              res.type("text/xml").send(resp.toString());

              // Send SMS notification to admin
              await sendSmsNotification(
                "denied due to session limit",
                callerNumber,
                `${user.name} tried to call but has used all 3 monthly sessions`
              );

              // Return early - don't forward this call
              return;
            }

            // Check for existing active session
            try {
              const sessionResult = await dbPool.query(
                'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND completed = false ORDER BY "createdAt" DESC LIMIT 1',
                [user.id]
              );
              const sessions = sessionResult.rows;

              // Filter for sessions with active statuses
              const incompleteSessions = Array.isArray(sessions)
                ? sessions.filter(
                    (session) =>
                      session.status === "pending" ||
                      session.status === "active" ||
                      session.status === "ongoing" ||
                      session.status === "open"
                  )
                : [];

              if (incompleteSessions.length > 0) {
                // Found existing active session
                existingSessionId = incompleteSessions[0].id;
                isActiveSession = true;
                console.log(
                  `🔄 Found existing active session ${existingSessionId} for user ${user.name}`
                );
              }
            } catch (sessionError) {
              console.error(
                "Error checking for active sessions:",
                sessionError
              );
            }

            // If we get here, user has sessions remaining
            whisperType = "customer";
            whisperName = user.name;

            // If this isn't an existing active session, check for pay-as-you-go restrictions before creating new one
            if (!isActiveSession) {
              try {
                // Check if user is on pay-as-you-go plan to prevent multiple sessions
                if (subscriptionInfo.subscriptionType === "pay-as-you-go") {
                  // For pay-as-you-go users, check if they have any recent sessions (within last 24 hours)
                  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                  const recentResult = await dbPool.query(
                    'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND "createdAt" > $2 ORDER BY "createdAt" DESC LIMIT 1',
                    [user.id, oneDayAgo]
                  );
                  const recentSessions = recentResult.rows;

                  if (recentSessions.length > 0) {
                    console.log(
                      `⚠️ Pay-as-you-go user ${user.name} has a recent session - preventing new phone session creation`
                    );

                    // Send SMS notification to user explaining they need to wait
                    await client.messages.create({
                      body: `Hello ${user.name}! You already have a recent help session. Please wait 24 hours before starting a new session, or complete your current session first.`,
                      from: TWILIO_PHONE_NUMBER,
                      to: callerNumber,
                    });

                    // Notify admin
                    await sendSmsNotification(
                      "denied due to recent session (pay-as-you-go)",
                      callerNumber,
                      `${user.name} tried to call but has a recent session within 24 hours`
                    );

                    // Return early - don't forward this call
                    return;
                  }
                }

                const helpSessionId = await createHelpSession(user.id, "phone");
                console.log(
                  `📝 Created new help session ${helpSessionId} for phone support with ${user.name}`
                );
              } catch (createError) {
                console.error("Error creating help session:", createError);
              }
            }
          } else {
            // Check if they've used a free trial
            const freeTrialUsed = await hasUsedFreeTrial(callerNumber);
            if (!freeTrialUsed) {
              // Eligible for free trial - record it
              await recordFreeTrial(callerNumber);
              whisperType = "freetrial";
              console.log(`🆓 New user eligible for free trial`);
            } else {
              whisperType = "returning";
              console.log(
                `⚠️ Returning non-registered user (already used free trial)`
              );
            }
          }

          // Set up whisper URL with user info and session status
          const whisperParams = new URLSearchParams({
            type: whisperType,
            name: whisperName,
            activeSession: isActiveSession ? "true" : "false",
            sessionId: existingSessionId || "",
          }).toString();

          const whisperUrl = `${host}/twilio/whisper?${whisperParams}`;
          console.log(`💬 WHISPER URL: ${whisperUrl}`);

          // Pass caller info to no-answer handler
          const callerInfo = JSON.stringify({
            type: whisperType,
            name: whisperName,
          });

          // Build the response with whisper and recording enabled
          // Note: For machine detection, we'll need to use call creation API instead,
          // as TwiML doesn't support all machine detection features

          console.log(`📞 CALL FORWARDING SETUP:`, {
            callerNumber: callerNumber,
            forwardNumber: FORWARD_NUMBER,
            whisperType: whisperType,
            whisperName: whisperName,
            isActiveSession: isActiveSession,
            sessionId: existingSessionId,
            host: host,
            whisperUrl: whisperUrl,
          });

          const dial = resp.dial({
            timeout: 20, // Shorter timeout to avoid long waits
            callerId: TWILIO_PHONE_NUMBER,
            action: `${host}/twilio/no-answer?callerInfo=${encodeURIComponent(
              callerInfo
            )}`,
            method: "POST",
            record: "record-from-answer", // Start recording when the call is answered
            recordingStatusCallback: `${host}/twilio/recording-status?originalCaller=${encodeURIComponent(
              callerNumber
            )}&userId=${encodeURIComponent(user?.id || "")}`,
            recordingStatusCallbackMethod: "POST",
            // Machine detection is handled in the no-answer endpoint
          });

          console.log(`📞 DIAL CONFIGURATION:`, {
            timeout: 20,
            callerId: TWILIO_PHONE_NUMBER,
            action: `${host}/twilio/no-answer?callerInfo=${encodeURIComponent(
              callerInfo
            )}`,
            record: "record-from-answer",
            recordingStatusCallback: `${host}/twilio/recording-status?originalCaller=${encodeURIComponent(
              callerNumber
            )}&userId=${encodeURIComponent(user?.id || "")}`,
          });

          // Use the number with whisper URL
          dial.number(
            {
              statusCallbackEvent: [
                "initiated",
                "ringing",
                "answered",
                "completed",
              ],
              statusCallback: `${host}/twilio/call-status`,
              statusCallbackMethod: "POST",
              url: whisperUrl,
            },
            FORWARD_NUMBER
          );

          console.log(`📞 FORWARDING TO ${FORWARD_NUMBER}:`, {
            statusCallbackEvents: [
              "initiated",
              "ringing",
              "answered",
              "completed",
            ],
            statusCallback: `${host}/twilio/call-status`,
            whisperUrl: whisperUrl,
            targetNumber: FORWARD_NUMBER,
          });

          console.log(
            `🔧 FORWARDING WITH WHISPER: TwiML generated:`,
            resp.toString()
          );
          res.type("text/xml").send(resp.toString());
        } catch (error) {
          console.error("❌ ERROR during user lookup for call forwarding:", {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            callerNumber: req.body.From || "unknown",
            forwardNumber: FORWARD_NUMBER,
            host: host,
            timestamp: new Date().toISOString(),
          });

          // In case of error, fall back to simple forwarding
          console.log(
            `⚠️ FALLBACK FORWARDING: Error during user lookup - using simple forwarding to ${FORWARD_NUMBER}`
          );

          try {
            const dial = resp.dial({
              timeout: 30,
              callerId: TWILIO_PHONE_NUMBER,
              action: `${host}/twilio/no-answer`,
              method: "POST",
            });

            console.log(`📞 FALLBACK DIAL CONFIG:`, {
              timeout: 30,
              callerId: TWILIO_PHONE_NUMBER,
              action: `${host}/twilio/no-answer`,
              targetNumber: FORWARD_NUMBER,
            });

            dial.number(
              {
                statusCallbackEvent: [
                  "initiated",
                  "ringing",
                  "answered",
                  "completed",
                ],
                statusCallback: `${host}/twilio/call-status`,
                statusCallbackMethod: "POST",
              },
              FORWARD_NUMBER
            );

            console.log(
              `📞 FALLBACK FORWARDING: TwiML generated:`,
              resp.toString()
            );
            res.type("text/xml").send(resp.toString());
          } catch (fallbackError) {
            console.error("❌ CRITICAL ERROR in fallback forwarding:", {
              error:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : fallbackError,
              stack:
                fallbackError instanceof Error
                  ? fallbackError.stack
                  : undefined,
              timestamp: new Date().toISOString(),
            });

            // Last resort - send error response
            resp.say(
              {
                voice: "Polly.Joanna",
                language: "en-US",
              },
              "<speak>We're sorry, there was a technical error. Please try again later.</speak>"
            );
            resp.hangup();
            res.type("text/xml").send(resp.toString());
          }
        }
      })();

      // Return early to prevent the default response
      return;
    } else {
      // Invalid option - prompt to try again
      console.log(`❌ INVALID OPTION: ${digits} - Prompting to try again`);

      // Create a new gather to collect input again
      const gather = resp.gather({
        numDigits: 1,
        action: `${host}/twilio/voice`,
        method: "POST",
      });

      // Let them know the option was invalid and prompt to try again
      gather.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>I'm sorry, that's not a valid option. <break time='300ms'/> Please press 1 to connect your account, or press 2 to talk to a representative.</speak>"
      );

      // If still no input
      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>No input received. <break time='200ms'/> Goodbye!</speak>"
      );
      resp.hangup();
    }
  } else {
    // Initial call - present menu
    console.log("🎵 PRESENTING IVR MENU");
    const gather = resp.gather({
      numDigits: 1,
      action: `${host}/twilio/voice`, // Send back to this same endpoint
      method: "POST",
    });

    // Updated welcome message and menu options with friendlier voice and SSML
    gather.say(
      {
        voice: "Polly.Joanna", // Friendlier voice
        language: "en-US",
      },
      "<speak><prosody rate='95%' pitch='+5%'>Welcome to Eldrix, <break time='200ms'/> your real world helper for all your tech needs! <break time='500ms'/> Press 1 to connect your account. <break time='300ms'/> Press 2 to talk to a representative now.</prosody></speak>"
    );

    // If no input received
    resp.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      "<speak>I didn't hear any input. <break time='300ms'/> Goodbye!</speak>"
    );
  }

  res.type("text/xml").send(resp.toString());
});

// 2) Process DTMF input is now handled directly in the /twilio/voice endpoint

// 3) No‑answer handler: play a quick message then hang up
app.get("/twilio/no-answer", (req: Request, res: Response) => {
  console.log("📵 NO ANSWER GET REQUEST (webhook verification)");
  res.status(200).send("OK");
});

app.post("/twilio/no-answer", (req: Request, res: Response) => {
  try {
    const callSid = req.body.CallSid;
    const dialStatus = req.body.DialCallStatus;
    const dialCallSid = req.body.DialCallSid;
    const dialCallDuration = req.body.DialCallDuration;
    const machineDetection = req.body.AnsweringMachineDetection;
    const originalCallerNumber = req.body.From || "";
    const toNumber = req.body.To || "";

    console.log("📵 CALL COMPLETION HANDLER TRIGGERED", {
      callSid: callSid,
      dialStatus: dialStatus,
      dialCallSid: dialCallSid,
      dialCallDuration: dialCallDuration,
      machineDetection: machineDetection,
      originalCaller: originalCallerNumber,
      toNumber: toNumber,
      timestamp: new Date().toISOString(),
    });

    const dialDuration = parseInt(dialCallDuration || "0", 10);
    const resp = new VoiceResponse();

    console.log(`📞 CALL FORWARDING RESULT:`, {
      dialStatus: dialStatus,
      duration: dialDuration,
      machineDetection: machineDetection || "not detected",
      originalCaller: originalCallerNumber,
      forwardedTo: toNumber,
    });

    // Get caller info from original call
    const callerParams = req.query.callerInfo
      ? JSON.parse(decodeURIComponent(req.query.callerInfo as string))
      : {};
    const callerType = callerParams.type || "unknown";
    const callerName = callerParams.name || "";
    const isRegistered = callerType === "customer";
    const isFreeTrial = callerType === "freetrial";
    const isReturning = callerType === "returning";

    // Prepare caller description for admin notification
    let callerDescription = "";
    if (isRegistered) {
      callerDescription = `registered customer ${callerName}`;
    } else if (isFreeTrial) {
      callerDescription = "free trial customer";
    } else if (isReturning) {
      callerDescription =
        "returning customer who already used their free trial";
    } else {
      callerDescription = "unknown caller type";
    }

    // Check for answering machine/voicemail
    if (machineDetection === "machine") {
      // Handle voicemail scenario
      console.log("🤖 VOICEMAIL DETECTED: Leaving a message");

      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>Hello, this is Eldrix calling. We received your call but couldn't reach you. Please call us back during business hours or send us a text message for faster support. Thank you!</speak>"
      );
      resp.hangup();

      // Send follow-up SMS after voicemail
      if (originalCallerNumber && TWILIO_PHONE_NUMBER) {
        try {
          client.messages
            .create({
              body: "We just tried to reach you but got your voicemail. For faster support, reply to this message and we'll assist you right away.",
              from: TWILIO_PHONE_NUMBER,
              to: originalCallerNumber,
            })
            .then((message) => {
              console.log(
                `✅ Follow-up SMS sent after voicemail: ${message.sid}`
              );
            })
            .catch((err) => {
              console.error(
                "Error sending follow-up SMS after voicemail:",
                err
              );
            });
        } catch (error) {
          console.error(
            "Error initiating follow-up SMS after voicemail:",
            error
          );
        }
      }

      // Notify admin about voicemail
      try {
        client.messages
          .create({
            body: `📞 MISSED CALL ALERT: ${originalCallerNumber} (${callerDescription}) called but went to voicemail. A follow-up SMS has been sent to them.`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          })
          .then((message) => {
            console.log(`✅ Admin notified about voicemail: ${message.sid}`);
          })
          .catch((err) => {
            console.error(
              "Error sending admin notification about voicemail:",
              err
            );
          });
      } catch (error) {
        console.error(
          "Error initiating admin notification about voicemail:",
          error
        );
      }
    }
    // Check if the call was actually answered and completed (normal hang up)
    else if (dialStatus === "completed" && dialDuration > 0) {
      // Call was answered and completed normally - thank them
      console.log(
        "✅ CALL COMPLETED NORMALLY: Duration " + dialDuration + " seconds"
      );

      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>Thank you for your call to Eldrix. <break time='300ms'/> Your support session will remain active for 30 minutes in case you need to call back. <break time='200ms'/> Have a great day!</speak>"
      );
    } else {
      // Call was not answered or failed
      console.log("❌ CALL NOT ANSWERED: Status " + dialStatus);

      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>Sorry, we couldn't reach our representative at this time. <break time='300ms'/> We'll call you back as soon as possible. <break time='200ms'/> For faster responses, please try texting us instead. <break time='200ms'/> Thank you for contacting Eldrix!</speak>"
      );

      // Send follow-up SMS after failed call
      if (originalCallerNumber && TWILIO_PHONE_NUMBER) {
        try {
          client.messages
            .create({
              body: "Sorry we missed your call! For immediate support, reply to this message and our team will assist you right away.",
              from: TWILIO_PHONE_NUMBER,
              to: originalCallerNumber,
            })
            .then((message) => {
              console.log(
                `✅ Follow-up SMS sent after missed call: ${message.sid}`
              );
            })
            .catch((err) => {
              console.error(
                "Error sending follow-up SMS after missed call:",
                err
              );
            });
        } catch (error) {
          console.error(
            "Error initiating follow-up SMS after missed call:",
            error
          );
        }
      }

      // Notify admin about missed call
      try {
        client.messages
          .create({
            body: `📞 MISSED CALL ALERT: ${originalCallerNumber} (${callerDescription}) called but the call was not answered (${dialStatus}). A follow-up SMS has been sent to them.`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          })
          .then((message) => {
            console.log(`✅ Admin notified about missed call: ${message.sid}`);
          })
          .catch((err) => {
            console.error(
              "Error sending admin notification about missed call:",
              err
            );
          });
      } catch (error) {
        console.error(
          "Error initiating admin notification about missed call:",
          error
        );
      }
    }

    resp.hangup();
    res.type("text/xml").send(resp.toString());
  } catch (error) {
    console.error("❌ ERROR in no-answer handler:", {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });

    // Send a simple error response
    const errorResp = new VoiceResponse();
    errorResp.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      "<speak>We're sorry, there was a technical error. Please try again later.</speak>"
    );
    errorResp.hangup();
    res.type("text/xml").send(errorResp.toString());
  }
});

// 4) Free trial confirmation handler
app.post("/twilio/free-trial", (req: Request, res: Response) => {
  const digits = req.body.Digits;
  const callerNumber = req.body.From || "";
  // Force HTTPS for all deployments (especially Vercel)
  const host = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : req.get("host")?.includes("ngrok")
    ? `https://${req.get("host")}`
    : `${req.protocol}://${req.get("host")}`;

  console.log("🎁 FREE TRIAL RESPONSE", {
    callSid: req.body.CallSid,
    from: callerNumber,
    digits: digits,
    timestamp: new Date().toISOString(),
  });

  // Make the response async to handle database operations
  (async () => {
    try {
      const resp = new VoiceResponse();

      if (digits === "1") {
        // Double-check if they've already used a free trial
        const freeTrialUsed = await hasUsedFreeTrial(callerNumber);

        if (freeTrialUsed) {
          // Already used free trial - prevent misuse
          console.log("⛔ FREE TRIAL ALREADY USED: Request denied");

          // Send SMS notification to admin
          await sendSmsNotification(
            "denied free trial (confirmation stage)",
            callerNumber,
            "Caller got to the free trial confirmation stage but was denied"
          );

          resp.say(
            {
              voice: "Polly.Joanna",
              language: "en-US",
            },
            "<speak>We notice you've already used a free trial call with us. <break time='300ms'/> To create an account and get regular access, please visit our website at eldrix.com. <break time='300ms'/> Thank you for your interest in our services. <break time='200ms'/> Goodbye!</speak>"
          );
          resp.hangup();
        } else {
          // Record the free trial usage first
          await recordFreeTrial(callerNumber);

          // User confirmed free trial - connect the call
          console.log("🆓 CONNECTING FREE TRIAL CALL");
          console.log(
            `📱 CONNECTING CALL: Free trial user with phone ${callerNumber} to representative at ${FORWARD_NUMBER}`
          );
          console.log(
            `📊 FREE TRIAL: First-time caller using their one-time free trial call`
          );

          // Say a brief message before connecting
          resp.say(
            {
              voice: "Polly.Joanna",
              language: "en-US",
            },
            "<speak>Thank you! <break time='200ms'/> Connecting you to our representative now. <break time='200ms'/> This is a one-time free trial call.</speak>"
          );

          // Use just the phone number for callerId (most compatible with carriers)
          // But add a whisper message that plays before connecting to identify the caller
          const dial = resp.dial({
            // Remove callerId to avoid carrier blocking issues
            timeout: 30,
            action: `${host}/twilio/no-answer`,
            method: "POST",
          });

          // Add a number with a whisper URL that will play a message to you before connecting
          // Temporarily disable whisper to test if that's causing the issue
          dial.number(FORWARD_NUMBER);
        }
      } else if (digits === "2") {
        // User explicitly declined
        console.log("❌ USER DECLINED FREE TRIAL");
        resp.say(
          {
            voice: "Polly.Joanna",
            language: "en-US",
          },
          "<speak>Thank you for your interest in Eldrix. <break time='300ms'/> To learn more about our services, please visit our website. <break time='200ms'/> Goodbye!</speak>"
        );
        resp.hangup();
      } else {
        // Invalid option - prompt to try again
        console.log(
          `❌ INVALID OPTION IN FREE TRIAL: ${digits} - Prompting to try again`
        );

        // Create a new gather to collect input again
        const gather = resp.gather({
          numDigits: 1,
          action: `${host}/twilio/free-trial`,
          method: "POST",
        });

        // Let them know the option was invalid and prompt to try again
        gather.say(
          {
            voice: "Polly.Joanna",
            language: "en-US",
          },
          "<speak>I'm sorry, that's not a valid option. <break time='300ms'/> Press 1 to continue with your free trial call. <break time='200ms'/> Press 2 to end the call.</speak>"
        );

        // If still no input
        resp.say(
          {
            voice: "Polly.Joanna",
            language: "en-US",
          },
          "<speak>No input received. <break time='200ms'/> Goodbye!</speak>"
        );
        resp.hangup();
      }

      res.type("text/xml").send(resp.toString());
    } catch (error) {
      console.error("Error in free trial handler:", error);

      // In case of error, create a basic response
      const resp = new VoiceResponse();
      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        "<speak>We're sorry, there was an error processing your request. <break time='300ms'/> Please try again later. <break time='200ms'/> Goodbye!</speak>"
      );
      resp.hangup();
      res.type("text/xml").send(resp.toString());
    }
  })();
});

// 5) Whisper handler - plays a message to the recipient before connecting the call
app.post("/twilio/whisper", (req: Request, res: Response) => {
  try {
    const type = req.query.type as string;
    const name = req.query.name as string;
    const activeSession = req.query.activeSession === "true";
    const sessionId = (req.query.sessionId as string) || "";
    const callerNumber = req.body.From || "(unknown)";
    const formattedPhone = callerNumber.replace(/^\+1/, ""); // Remove +1 for display

    console.log("💬 WHISPER ENDPOINT CALLED", {
      type,
      name,
      callerNumber,
      activeSession,
      sessionId,
      queryParams: req.query,
      bodyParams: req.body,
      timestamp: new Date().toISOString(),
    });
    console.log(`📞 WHISPER PREPARING CALL: Connecting to ${FORWARD_NUMBER}`);

    const resp = new VoiceResponse();

    if (type === "customer") {
      // Registered customer
      // Add different message based on active session status
      let sessionInfo = "";
      if (activeSession) {
        sessionInfo = `This is a continuation of an existing session.`;
      } else {
        sessionInfo = `This is a new support session.`;
      }

      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        `<speak>
        Incoming call from registered customer ${name || "with account"}.
        <break time="500ms"/>
        ${sessionInfo}
        <break time="500ms"/>
        Connecting now.
      </speak>`
      );
    } else if (type === "freetrial") {
      // Free trial
      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        `<speak>
        Incoming call from new free trial customer.
        <break time="500ms"/>
        This is their first call.
        <break time="500ms"/>
        Connecting now.
      </speak>`
      );
    } else if (type === "returning") {
      // Returning non-registered customer
      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        `<speak>
        Incoming call from returning customer without active subscription.
        <break time="500ms"/>
        They've already used their free trial.
        <break time="500ms"/>
        Connecting now.
      </speak>`
      );
    } else {
      // Default/unknown
      resp.say(
        {
          voice: "Polly.Joanna",
          language: "en-US",
        },
        `<speak>
        Incoming customer call.
        <break time="500ms"/>
        Status: unknown.
        <break time="500ms"/>
        Connecting now.
      </speak>`
      );
    }

    console.log("💬 WHISPER RESPONSE GENERATED:", resp.toString());
    res.type("text/xml").send(resp.toString());
  } catch (error) {
    console.error("❌ ERROR in whisper endpoint:", {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      queryParams: req.query,
      bodyParams: req.body,
      timestamp: new Date().toISOString(),
    });

    // Send a simple error response
    const errorResp = new VoiceResponse();
    errorResp.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      "<speak>Incoming call. Connecting now.</speak>"
    );
    res.type("text/xml").send(errorResp.toString());
  }
});

// 6) SMS handling endpoint for incoming text messages
app.post("/twilio/sms", (req: Request, res: Response) => {
  // Check for media attachments
  const mediaCount = parseInt(req.body.NumMedia || "0");
  const mediaUrls: string[] = [];

  if (mediaCount > 0) {
    for (let i = 0; i < mediaCount; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      if (mediaUrl) {
        mediaUrls.push(mediaUrl);
      }
    }
  }

  console.log("📱 INCOMING SMS", {
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body,
    mediaCount: mediaCount,
    mediaUrls: mediaUrls,
    timestamp: new Date().toISOString(),
  });

  const senderNumber = req.body.From || "";
  const messageBody = req.body.Body || "";

  // Create a combined message content that includes both text and media info
  let combinedMessage = messageBody;
  if (mediaUrls.length > 0) {
    const mediaInfo = mediaUrls
      .map((url, index) => `[Image ${index + 1}: ${url}]`)
      .join(" ");
    combinedMessage = messageBody
      ? `${messageBody}\n\n${mediaInfo}`
      : mediaInfo;
  }

  // Make the response async to handle database operations
  (async () => {
    try {
      // Check if the sender is a registered user
      const user = await findUserByPhone(senderNumber);

      if (user) {
        // User found - check their subscription info
        const subscriptionInfo = await getUserSubscriptionInfo(user.id);

        console.log(
          `✅ SMS FROM REGISTERED USER: ${user.name} (${subscriptionInfo.subscriptionType} plan)`
        );

        // Check if user can make more sessions
        if (
          subscriptionInfo.subscriptionType === "free" &&
          subscriptionInfo.freeSessionsRemaining <= 0
        ) {
          // Free user has used all sessions
          console.log(`⛔ FREE USER ${user.name} HAS REACHED SESSION LIMIT`);

          // Send SMS response to user
          await client.messages.create({
            body: `Hello ${user.name}! You've used all 3 of your help sessions for this month. Please check back next month for more available sessions.`,
            from: TWILIO_PHONE_NUMBER,
            to: senderNumber,
          });

          // Notify admin but don't forward the message
          await client.messages.create({
            body: `ELDRIX SMS ALERT: Message received from ${senderNumber} (${user.name}), but not forwarded because they've used all their monthly sessions.\n\nTheir message: "${combinedMessage}"`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });
        } else {
          // User has sessions remaining - check for existing active SMS session before creating a new one
          console.log(
            `✅ PROCESSING SMS: From ${user.name} (${subscriptionInfo.subscriptionType} plan)`
          );

          // Variables to track session state
          let isNewSession = true;
          let helpSessionId: string | null = null;

          try {
            // Check for an existing active (uncompleted) session of ANY type for this user
            const existingResult = await dbPool.query(
              'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND completed = false ORDER BY "createdAt" DESC LIMIT 1',
              [user.id]
            );
            const existingSessions = existingResult.rows;

            // Filter for sessions with active statuses
            const incompleteSessions = existingSessions.filter(
              (session) =>
                session.status === "pending" ||
                session.status === "active" ||
                session.status === "ongoing" ||
                session.status === "open"
            );

            // Update our isNewSession flag based on filtered results
            isNewSession = incompleteSessions.length === 0;

            // helpSessionId is already declared in the outer scope

            if (incompleteSessions.length > 0) {
              // Found an existing active session - use it and update type if needed
              const existingSession = incompleteSessions[0];
              helpSessionId = existingSession.id;

              // Check if we need to update the session type
              if (existingSession.type !== "sms") {
                console.log(
                  `🔄 Switching session ${helpSessionId} from ${existingSession.type} to SMS for user ${user.name}`
                );

                // Update the session type to SMS
                await dbPool.query(
                  'UPDATE "HelpSession" SET type = \'sms\', "updatedAt" = $1 WHERE id = $2',
                  [new Date(), helpSessionId]
                );
              }

              console.log(
                `✅ Found existing session ${helpSessionId} for user ${user.name} - continuing conversation via SMS`
              );
            } else {
              // Check if user is on pay-as-you-go plan to prevent multiple sessions
              if (subscriptionInfo.subscriptionType === "pay-as-you-go") {
                // For pay-as-you-go users, check if they have any recent sessions (within last 24 hours)
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const recentResult = await dbPool.query(
                  'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND "createdAt" > $2 ORDER BY "createdAt" DESC LIMIT 1',
                  [user.id, oneDayAgo]
                );
                const recentSessions = recentResult.rows;

                if (recentSessions.length > 0) {
                  console.log(
                    `⚠️ Pay-as-you-go user ${user.name} has a recent session - preventing new session creation`
                  );

                  // Send message to user explaining they need to wait
                  await client.messages.create({
                    body: `Hello ${user.name}! You already have a recent help session. Please wait 24 hours before starting a new session, or complete your current session first.`,
                    from: TWILIO_PHONE_NUMBER,
                    to: senderNumber,
                  });

                  // Notify admin
                  await client.messages.create({
                    body: `ELDRIX SMS ALERT: Pay-as-you-go user ${user.name} (${senderNumber}) tried to start a new session but has a recent one. Message not forwarded.`,
                    from: TWILIO_PHONE_NUMBER,
                    to: ADMIN_PHONE,
                  });

                  // Send TwiML response and return early
                  const twiml = new MessagingResponse();
                  res.type("text/xml").send(twiml.toString());
                  return;
                }
              }

              // No existing active session found - create a new one
              console.log(
                `📝 No active session found - creating new SMS session for user ${user.name}`
              );
              helpSessionId = await createHelpSession(
                user.id,
                "sms",
                combinedMessage
              );
              if (helpSessionId) {
                console.log(
                  `✅ Created new help session ${helpSessionId} for user ${user.name}`
                );
              } else {
                console.error(
                  `⚠️ Failed to create help session for user ${user.name}`
                );
              }
            }

            // If we have a valid session ID (either existing or new), store the message
            if (helpSessionId) {
              // Store the message in the database
              const messageResult = await createMessage(
                helpSessionId,
                combinedMessage,
                false
              );
              if (messageResult) {
                console.log(
                  `✅ Stored message in database for session ${helpSessionId}`
                );
              } else {
                console.error(
                  `⚠️ Failed to store message in database for session ${helpSessionId}`
                );
              }
            }
          } catch (sessionError) {
            console.error("Error managing help session:", sessionError);
          }

          // Forward the message to admin/representative with appropriate context based on new vs ongoing session
          let adminMessagePrefix = "";

          if (isNewSession) {
            // New session notification with subscription info
            if (subscriptionInfo.subscriptionType === "subscription") {
              adminMessagePrefix = `From: ${user.name} (${senderNumber})\nPlan: Subscription (Unlimited)\n\n`;
            } else if (subscriptionInfo.subscriptionType === "pay-as-you-go") {
              if (subscriptionInfo.freeSessionsRemaining > 0) {
                adminMessagePrefix = `From: ${user.name} (${senderNumber})\nPlan: Pay-as-you-go (${subscriptionInfo.freeSessionsRemaining} free sessions remaining)\n\n`;
              } else {
                adminMessagePrefix = `From: ${user.name} (${senderNumber})\nPlan: Pay-as-you-go (Billing active)\n\n`;
              }
            } else {
              adminMessagePrefix = `From: ${user.name} (${senderNumber})\nPlan: Free (${subscriptionInfo.freeSessionsRemaining} sessions remaining)\n\n`;
            }
          } else {
            // Ongoing conversation notification
            adminMessagePrefix = `${user.name} (${senderNumber}) replied to their ongoing conversation.\n\n`;
          }

          // Common part of the message including chat link
          const chatLink = helpSessionId
            ? `https://admin.eldrix.app/chat?id=${helpSessionId}`
            : "";

          await client.messages.create({
            body: `${adminMessagePrefix}To reply directly to this user, respond with your message OR start with their number: ${senderNumber} Your message here\n\nClick here to respond in web interface: ${chatLink}\n\n${combinedMessage}`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });

          // We already determined if this is a new session above, so we don't need to check again

          // Only send the confirmation message if this is a new session
          if (isNewSession) {
            // Format the message based on subscription type
            let sessionMessage = "";
            if (subscriptionInfo.subscriptionType === "subscription") {
              sessionMessage = `You have unlimited sessions with your subscription.`;
            } else if (subscriptionInfo.subscriptionType === "pay-as-you-go") {
              if (subscriptionInfo.freeSessionsRemaining > 0) {
                sessionMessage = `This is one of your ${subscriptionInfo.freeSessionsRemaining} remaining free sessions this month.`;
              } else {
                sessionMessage = `This session will be billed to your pay-as-you-go account.`;
              }
            } else {
              sessionMessage = `This is one of your ${subscriptionInfo.freeSessionsRemaining} remaining free sessions this month.`;
            }

            await client.messages.create({
              body: `Thank you for your message. Our representative will respond shortly. ${sessionMessage}`,
              from: TWILIO_PHONE_NUMBER,
              to: senderNumber,
            });
          }
        }
      } else {
        // No user found - check if they've used a free trial before
        const freeTrialUsed = await hasUsedFreeTrial(senderNumber);

        if (freeTrialUsed) {
          // Already used free trial - inform the sender
          console.log("⛔ FREE TRIAL ALREADY USED: Informing sender");

          // Send message to sender
          await client.messages.create({
            body: "We notice you've already used a free trial with us. To create an account and get regular access, please visit our website at eldrix.app.",
            from: TWILIO_PHONE_NUMBER,
            to: senderNumber,
          });

          // Notify admin but don't forward
          await client.messages.create({
            body: `ELDRIX SMS ALERT: Message received from ${senderNumber}, but not forwarded because they've already used their free trial.\n\nTheir message: "${combinedMessage}"`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });
        } else {
          // Eligible for free trial - record and process it
          console.log("🆓 NEW USER: Processing free trial SMS");

          // Record the free trial usage
          await recordFreeTrial(senderNumber);

          // Generate a unique free trial session ID for free trial users
          const freeTrialSessionId = uuidv4();

          // Forward the message to admin/representative with free trial info
          await client.messages.create({
            body: `FREE TRIAL SMS from: ${senderNumber}\n\nTo reply directly to this user, respond with your message OR start with their number: ${senderNumber} Your message here\n\nClick here to respond in web interface: https://admin.eldrix.app/chat?id=${freeTrialSessionId}\n\n${combinedMessage}`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });

          // Send response to the sender (no chat link for users)
          await client.messages.create({
            body: `Thank you for your message. Our representative will respond shortly. This is your one-time free trial message. To continue using our services, please visit eldrix.app to create an account.`,
            from: TWILIO_PHONE_NUMBER,
            to: senderNumber,
          });
        }
      }

      // Send a TwiML response to Twilio
      const twiml = new MessagingResponse();
      res.type("text/xml").send(twiml.toString());
    } catch (error) {
      console.error("Error processing SMS:", error);

      // In case of error, send a generic response
      const twiml = new MessagingResponse();
      res.type("text/xml").send(twiml.toString());
    }
  })();
});

// 7) SMS reply handler - for when the admin/rep responds to a forwarded message
app.post("/twilio/sms-reply", (req: Request, res: Response) => {
  console.log("📱 OUTGOING REPLY SMS", {
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body,
    timestamp: new Date().toISOString(),
  });

  // This endpoint assumes the ADMIN_PHONE is the sender (From)
  // and the original customer's phone is the recipient (To)
  const adminNumber = req.body.From || "";
  const customerNumber = req.body.To || "";
  const messageBody = req.body.Body || "";

  // Verify this is actually coming from the admin number for security
  if (adminNumber !== ADMIN_PHONE && adminNumber !== FORWARD_NUMBER) {
    console.warn(
      `⚠️ Unauthorized attempt to send SMS reply from ${adminNumber}`
    );
    const twiml = new MessagingResponse();
    res.type("text/xml").send(twiml.toString());
    return;
  }

  (async () => {
    try {
      // Check if message starts with a phone number (in case admin is using different format)
      // This handles cases where the admin might reply with "+1234567890 Your message"
      let targetNumber = customerNumber;
      let actualMessage = messageBody;

      // Check if the message starts with a phone number pattern
      const phonePattern = /^\s*(\+?[0-9]{10,15})(?:\s+(.+))?/;
      const phoneMatch = messageBody.match(phonePattern);

      if (phoneMatch) {
        // Extract the phone number and the actual message
        targetNumber = phoneMatch[1];
        actualMessage = phoneMatch[2] || ""; // Use empty string if there's no message after the phone

        console.log(`📞 Detected phone number in message: ${targetNumber}`);
        console.log(`💬 Actual message content: ${actualMessage}`);
      }

      // Find the user associated with this phone number
      const user = await findUserByPhone(targetNumber);

      if (user) {
        // Look for an active help session for this user
        try {
          // Find the most recent active help session for this user (any type)
          const sessionResult = await dbPool.query(
            'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND completed = false ORDER BY "createdAt" DESC LIMIT 1',
            [user.id]
          );
          const sessions = sessionResult.rows;

          // Filter for sessions with active statuses
          const incompleteSessions = sessions.filter(
            (session) =>
              session.status === "pending" ||
              session.status === "active" ||
              session.status === "ongoing" ||
              session.status === "open"
          );

          if (incompleteSessions.length > 0) {
            const session = incompleteSessions[0];

            // Check if we need to update the session type to SMS (since admin is replying via SMS)
            if (session.type !== "sms") {
              console.log(
                `🔄 Switching session ${session.id} from ${session.type} to SMS for admin reply to user ${user.name}`
              );

              // Update the session type to SMS
              await dbPool.query(
                'UPDATE "HelpSession" SET type = \'sms\', "updatedAt" = $1 WHERE id = $2',
                [new Date(), session.id]
              );
            }

            console.log(
              `✅ Found active help session ${session.id} for user ${user.name} - admin replying via SMS`
            );

            // Store the admin's message in the database
            const messageResult = await createMessage(
              session.id,
              actualMessage,
              true
            );
            if (messageResult) {
              console.log(
                `✅ Stored admin's reply in database for session ${session.id}`
              );
            } else {
              console.error(
                `⚠️ Failed to store admin's reply in database for session ${session.id}`
              );
            }
          } else {
            console.log(
              `⚠️ No active help session found for user ${user.name}. Creating a new SMS session.`
            );

            // Create a new help session with the admin's message
            const helpSessionId = await createHelpSession(
              user.id,
              "sms",
              actualMessage
            );
            if (helpSessionId) {
              console.log(
                `✅ Created new help session ${helpSessionId} for admin reply to ${user.name}`
              );

              // Store the message in the database
              const messageResult = await createMessage(
                helpSessionId,
                actualMessage,
                true
              );
              if (messageResult) {
                console.log(
                  `✅ Stored admin's message in database for new session ${helpSessionId}`
                );
              } else {
                console.error(
                  `⚠️ Failed to store admin's message in database for new session ${helpSessionId}`
                );
              }
            }
          }
        } catch (dbError) {
          console.error("Database error while finding help session:", dbError);
        }
      } else {
        console.log(
          `⚠️ No user found with phone ${targetNumber} for admin reply`
        );
      }

      // Forward the admin's reply to the customer
      await client.messages.create({
        body: actualMessage,
        from: TWILIO_PHONE_NUMBER,
        to: targetNumber,
      });

      console.log(`✅ Forwarded admin reply to customer: ${targetNumber}`);

      // Send a TwiML response to Twilio
      const twiml = new MessagingResponse();
      res.type("text/xml").send(twiml.toString());
    } catch (error) {
      console.error("Error sending SMS reply:", error);

      // In case of error, send a generic response
      const twiml = new MessagingResponse();
      res.type("text/xml").send(twiml.toString());
    }
  })();
});

// 8) Call status tracking endpoint
app.post("/twilio/call-status", (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const from = req.body.From;
  const to = req.body.To;
  const direction = req.body.Direction;
  const duration = req.body.CallDuration;
  const answeredBy = req.body.AnsweredBy;

  console.log("📞 CALL STATUS UPDATE", {
    callSid: callSid,
    callStatus: callStatus,
    from: from,
    to: to,
    direction: direction,
    duration: duration,
    answeredBy: answeredBy,
    timestamp: new Date().toISOString(),
  });

  // Log specific status changes with more detail
  if (callStatus === "initiated") {
    console.log(`🚀 CALL INITIATED: ${callSid} - From: ${from} to ${to}`);
  } else if (callStatus === "ringing") {
    console.log(`📞 CALL RINGING: ${callSid} - Ringing ${to}`);
  } else if (callStatus === "answered") {
    console.log(
      `✅ CALL ANSWERED: ${callSid} - ${to} answered the call${
        answeredBy ? ` (answered by: ${answeredBy})` : ""
      }`
    );
  } else if (callStatus === "completed") {
    console.log(
      `🏁 CALL COMPLETED: ${callSid} - Duration: ${
        duration || "unknown"
      } seconds`
    );
  } else if (callStatus === "busy") {
    console.log(`📵 CALL BUSY: ${callSid} - ${to} is busy`);
  } else if (callStatus === "no-answer") {
    console.log(`📵 CALL NO ANSWER: ${callSid} - ${to} did not answer`);
  } else if (callStatus === "failed") {
    console.log(`❌ CALL FAILED: ${callSid} - Call failed to ${to}`);
  } else {
    console.log(`📞 CALL STATUS: ${callSid} - Status: ${callStatus}`);
  }

  // This endpoint just logs the status and responds with 200 OK
  res.status(200).send("OK");
});

// Helper function to download a file from a URL to a local temp file
async function downloadFileFromUrl(
  url: string,
  authUsername?: string,
  authPassword?: string
): Promise<string> {
  try {
    const tempFilePath = path.join(
      os.tmpdir(),
      `twilio_recording_${Date.now()}.wav`
    );
    console.log(`📥 Downloading file from ${url} to ${tempFilePath}`);

    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      timeout: 10000, // 10 second timeout - fail fast
      maxContentLength: 10 * 1024 * 1024, // 10MB max file size
      auth:
        authUsername && authPassword
          ? {
              username: authUsername,
              password: authPassword,
            }
          : undefined,
      headers: {
        "User-Agent": "Eldrix-Recording-Downloader/1.0",
        Accept: "audio/wav, audio/*, */*",
      },
    });

    const streamPipeline = promisify(pipeline);
    const writer = createWriteStream(tempFilePath);

    // Add a timeout wrapper around the pipeline
    const pipelinePromise = streamPipeline(response.data, writer);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Download timeout after 8 seconds")),
        8000
      );
    });

    await Promise.race([pipelinePromise, timeoutPromise]);

    console.log(`✅ Download complete: ${tempFilePath}`);
    return tempFilePath;
  } catch (error) {
    console.error("Error downloading file:", error);
    // Don't throw the error, just return empty string so we can continue with original URL
    return "";
  }
}

// Helper function to upload a file to Vercel Blob
async function uploadFileToBlob(
  filePath: string,
  filename: string,
  contentType: string = "audio/wav"
): Promise<string> {
  try {
    console.log(`📤 Uploading file to Vercel Blob: ${filename}`);

    const fileContent = fs.readFileSync(filePath);

    const blob = await put(filename, fileContent, {
      access: "public",
      contentType: contentType,
      token: BLOB_READ_WRITE_TOKEN,
    });

    console.log(`✅ Upload complete: ${blob.url}`);

    return blob.url;
  } catch (error) {
    console.error("Error uploading to Vercel Blob:", error);
    throw error;
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🧹 Cleaned up temp file: ${filePath}`);
      }
    } catch (cleanupError) {
      console.error("Error cleaning up temp file:", cleanupError);
    }
  }
}

// 9) Recording status callback - handles recording notifications
app.post("/twilio/recording-status", (req: Request, res: Response) => {
  console.log("🎙️ RECORDING STATUS UPDATE", {
    recordingSid: req.body.RecordingSid,
    recordingStatus: req.body.RecordingStatus,
    recordingUrl: req.body.RecordingUrl,
    recordingDuration: req.body.RecordingDuration,
    recordingChannels: req.body.RecordingChannels,
    callSid: req.body.CallSid,
    timestamp: new Date().toISOString(),
  });

  // Respond quickly to Twilio - we'll process async
  res.status(200).send("OK");

  // Associate recording with help session if we can find one
  (async () => {
    try {
      // Use the original caller number from query params instead of the From field
      const callerNumber =
        (req.query.originalCaller as string) || req.body.From || "";
      const userId = req.query.userId as string;
      const recordingUrl = req.body.RecordingUrl;
      const recordingSid = req.body.RecordingSid;
      const recordingDuration = req.body.RecordingDuration;
      const recordingStatus = req.body.RecordingStatus;

      // Only proceed if we have a valid recording URL and it's completed
      if (recordingUrl && recordingSid && recordingStatus === "completed") {
        console.log(`🎵 Processing completed recording: ${recordingSid}`);

        let blobUrl = "";

        try {
          // Download the recording from Twilio
          // Note: Some Twilio recordings require authentication with AccountSid:AuthToken
          const localFilePath = await downloadFileFromUrl(
            recordingUrl,
            TWILIO_ACCOUNT_SID,
            TWILIO_AUTH_TOKEN
          );

          // Only try to upload if download was successful
          if (localFilePath) {
            // Upload to Vercel Blob
            const filename = `call-recordings/${recordingSid}_${new Date()
              .toISOString()
              .replace(/[:.]/g, "-")}.wav`;
            blobUrl = await uploadFileToBlob(localFilePath, filename);

            console.log(`🎉 Recording saved to Vercel Blob: ${blobUrl}`);
          } else {
            console.log(
              `⚠️ Recording download failed, using original Twilio URL`
            );
            blobUrl = "";
          }
        } catch (storageError) {
          console.error("Error saving recording to Vercel Blob:", storageError);
          // Continue with the original Twilio URL if Blob upload fails
          blobUrl = "";
        }

        // Find user either by ID (if passed) or by phone number
        let user = null;

        if (userId) {
          // Try to get user directly by ID first if we have it
          try {
            const userResult = await dbPool.query(
              'SELECT * FROM "User" WHERE id = $1',
              [userId]
            );
            const users = userResult.rows;

            if (Array.isArray(users) && users.length > 0) {
              user = users[0];
              console.log(`✅ Found user by ID: ${user.name}`);
            }
          } catch (idLookupError) {
            console.error("Error looking up user by ID:", idLookupError);
          }
        }

        // Fall back to phone lookup if we don't have a user yet
        if (!user && callerNumber) {
          user = await findUserByPhone(callerNumber);
        }

        if (user) {
          // Find most recent active session for this user
          const sessionResult = await dbPool.query(
            'SELECT * FROM "HelpSession" WHERE "userId" = $1 AND type = \'phone\' ORDER BY "createdAt" DESC LIMIT 1',
            [user.id]
          );
          const sessions = sessionResult.rows;

          if (Array.isArray(sessions) && sessions.length > 0) {
            const sessionId = sessions[0].id;

            // Store recording details in the session
            // Create a message with both recording URLs
            const messageText = blobUrl
              ? `📞 Call recording: ${blobUrl} (Duration: ${
                  recordingDuration || "unknown"
                } seconds)\n\nTwilio original: ${recordingUrl}`
              : `📞 Call recording: ${recordingUrl} (Duration: ${
                  recordingDuration || "unknown"
                } seconds)`;

            await createMessage(
              sessionId,
              messageText,
              true // Mark as from admin
            );

            console.log(
              `✅ Saved recording URL to help session ${sessionId} for user ${user.name}`
            );

            // Send notification to admin with recording link
            const notificationText = blobUrl
              ? `ELDRIX CALL RECORDING: Call with ${
                  user.name
                } (${callerNumber}) was recorded.\n\nDuration: ${
                  recordingDuration || "unknown"
                } seconds\n\nVercel Blob URL: ${blobUrl}\n\nTwilio URL: ${recordingUrl}\n\nSession ID: ${sessionId}`
              : `ELDRIX CALL RECORDING: Call with ${
                  user.name
                } (${callerNumber}) was recorded.\n\nDuration: ${
                  recordingDuration || "unknown"
                } seconds\n\nRecording URL: ${recordingUrl}\n\nSession ID: ${sessionId}`;

            await client.messages.create({
              body: notificationText,
              from: TWILIO_PHONE_NUMBER,
              to: ADMIN_PHONE,
            });
          } else {
            console.log(
              `⚠️ No recent phone session found for user ${user.name} to attach recording`
            );
          }
        } else {
          // Unknown user, still send notification to admin
          console.log(
            `⚠️ Unknown user for call recording from ${callerNumber}`
          );

          // Send notification to admin with recording link
          const notificationText = blobUrl
            ? `ELDRIX CALL RECORDING: Call with unknown user (${callerNumber}) was recorded.\n\nDuration: ${
                recordingDuration || "unknown"
              } seconds\n\nVercel Blob URL: ${blobUrl}\n\nTwilio URL: ${recordingUrl}`
            : `ELDRIX CALL RECORDING: Call with unknown user (${callerNumber}) was recorded.\n\nDuration: ${
                recordingDuration || "unknown"
              } seconds\n\nRecording URL: ${recordingUrl}`;

          await client.messages.create({
            body: notificationText,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });
        }
      }
    } catch (error) {
      console.error("Error processing recording status:", error);
    }
  })();
});

// 10) SMS response handler for external API integration
app.post("/twilio/sms/respond", (req: Request, res: Response) => {
  console.log("📱 SMS RESPOND API CALL", {
    sessionId: req.body.sessionId,
    userId: req.body.userId,
    messageLength: req.body.message?.length || 0,
    imageUrl: req.body.imageUrl || null,
    timestamp: new Date().toISOString(),
  });

  (async () => {
    try {
      // Validate required parameters
      const { sessionId, message, userId, imageUrl } = req.body;

      if (!sessionId || !message || !userId) {
        console.error("⚠️ Missing required parameters for SMS respond API");
        return res.status(400).json({
          success: false,
          error:
            "Missing required parameters: sessionId, message, and userId are required",
        });
      }

      // Look up the user to get their phone number
      const user = await findUserByPhone(userId); // Try first treating userId as a phone number

      let phoneNumber = "";

      if (user) {
        // If userId was actually a phone number and we found a user
        phoneNumber = userId;
        console.log(`✅ Found user by phone number: ${user.name}`);
      } else {
        // Look up the user by their actual userId
        try {
          const userResult = await dbPool.query(
            'SELECT * FROM "User" WHERE id = $1',
            [userId]
          );
          const users = userResult.rows;

          if (Array.isArray(users) && users.length > 0) {
            const userObj = users[0] as User;
            phoneNumber = userObj.phone;
            console.log(
              `✅ Found user by ID: ${userObj.name}, phone: ${phoneNumber}`
            );
          } else {
            console.error(`❌ No user found with ID: ${userId}`);
            return res.status(404).json({
              success: false,
              error: "User not found",
            });
          }
        } catch (dbError) {
          console.error("Database error looking up user:", dbError);
          return res.status(500).json({
            success: false,
            error: "Database error looking up user",
          });
        }
      }

      // Ensure we have a valid phone number
      if (!phoneNumber) {
        console.error(`❌ No phone number found for user ID: ${userId}`);
        return res.status(400).json({
          success: false,
          error: "No phone number found for user",
        });
      }

      // Format the phone number for Twilio (add +1 if it's just 10 digits)
      const formattedPhone = phoneNumber.startsWith("+")
        ? phoneNumber
        : phoneNumber.length === 10
        ? `+1${phoneNumber}`
        : `+${phoneNumber}`;

      // Send the SMS through Twilio (no chat link for users)
      const messageOptions: any = {
        body: message,
        from: TWILIO_PHONE_NUMBER,
        to: formattedPhone,
      };

      // Add image URL if provided
      if (imageUrl) {
        messageOptions.mediaUrl = [imageUrl];
        console.log(`📷 Including image in SMS: ${imageUrl}`);
      }

      const smsResult = await client.messages.create(messageOptions);

      console.log(
        `✅ Successfully sent SMS to ${formattedPhone}, SID: ${smsResult.sid}${
          imageUrl ? " with image" : ""
        }`
      );

      // Skip storing message in database - this will be handled by the external system

      // Send a successful response
      res.json({
        success: true,
        messageId: smsResult.sid,
        to: formattedPhone,
        imageIncluded: !!imageUrl,
      });
    } catch (error) {
      console.error("Error processing SMS respond request:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  })();
});

// Export the app for Vercel serverless
export default app;

// Start the server only when running locally
if (process.env.NODE_ENV !== "production") {
  app.listen(Number(PORT), () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
