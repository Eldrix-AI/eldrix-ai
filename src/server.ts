// src/server.ts
import express, { Request, Response } from "express";
import dotenv from "dotenv";
import Twilio from "twilio";
import mysql from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";

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

// Create database connection pool using DATABASE_URL or individual parameters
let dbPool: mysql.Pool;
try {
  if (DATABASE_URL) {
    // Use connection string if available
    console.log("Connecting to database using DATABASE_URL");
    dbPool = mysql.createPool(DATABASE_URL);
  } else if (DB_HOST && DB_USER && DB_PASSWORD && DB_NAME) {
    // Use individual parameters
    console.log("Connecting to database using individual credentials");
    dbPool = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT ? parseInt(DB_PORT, 10) : 3306,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  } else {
    // Create a placeholder pool that will throw errors when used
    console.error(
      "No database credentials provided. Database functionality will be unavailable."
    );
    dbPool = {} as mysql.Pool;
  }
} catch (error) {
  console.error("Error creating database pool:", error);
  dbPool = {} as mysql.Pool;
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

// Function to find user by phone number
async function findUserByPhone(phone: string): Promise<User | null> {
  const cleanedPhone = cleanPhoneNumber(phone);
  console.log(`🔍 Looking up user with phone: ${cleanedPhone}`);

  try {
    console.log(
      `⚠️ DEBUG - Database query: "SELECT * FROM User WHERE phone LIKE '%${cleanedPhone}%'"`
    );

    // Check if dbPool is properly initialized
    if (!dbPool || !dbPool.execute) {
      console.error("⚠️ ERROR - Database pool is not properly initialized!");
      return null;
    }

    const [rows]: [any[], any] = await dbPool.execute(
      "SELECT * FROM User WHERE phone LIKE ?",
      [`%${cleanedPhone}%`]
    );

    if (Array.isArray(rows) && rows.length > 0) {
      const user = rows[0] as User;
      console.log(`✅ User found: ${user.name}`);
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

    // Query that only counts sessions from the current month
    const [rows] = await dbPool.execute(
      "SELECT COUNT(*) as count FROM HelpSession WHERE userId = ? AND createdAt >= ? AND createdAt < ?",
      [userId, firstDayFormatted, nextMonthFormatted]
    );

    if (Array.isArray(rows) && rows.length > 0) {
      const count = (rows[0] as any).count;
      console.log(
        `📊 User has ${count} help sessions this month (${now.toLocaleString(
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
    const [rows]: [any[], any] = await dbPool.execute(
      "SELECT * FROM FreeTrial WHERE phone LIKE ?",
      [`%${cleanedPhone}%`]
    );

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
    await dbPool.execute("INSERT IGNORE INTO FreeTrial (phone) VALUES (?)", [
      cleanedPhone,
    ]);

    console.log(`✅ Successfully recorded free trial for ${cleanedPhone}`);
    return true;
  } catch (error) {
    console.error("Database error recording free trial:", error);
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

    // Insert a new help session record with priority set to medium
    await dbPool.execute(
      "INSERT INTO HelpSession (id, userId, type, title, status, priority, createdAt, updatedAt, lastMessage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        sessionId,
        userId,
        callType,
        title,
        "ongoing",
        "medium", // Always set priority to medium
        now,
        now,
        lastMessageValue,
      ]
    );

    console.log(
      `✅ Successfully created help session ${sessionId} for user ${userId}`
    );

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
    await dbPool.execute(
      "INSERT INTO Message (id, content, isAdmin, helpSessionId, createdAt, `read`) VALUES (?, ?, ?, ?, ?, ?)",
      [
        messageId,
        content,
        isAdmin ? 1 : 0,
        helpSessionId,
        now, // MySQL can accept JavaScript Date objects
        0, // not read initially
      ]
    );

    // Update the lastMessage field in the HelpSession table
    await dbPool.execute(
      "UPDATE HelpSession SET lastMessage = ?, updatedAt = ? WHERE id = ?",
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
  const host = `${req.protocol}://${req.get("host")}`;
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
            // User found - get their session count
            const sessionCount = await countUserSessions(user.id);
            const remainingSessions = 3 - sessionCount;

            console.log(
              `⚠️ DEBUG - User ${user.name} has ${sessionCount} sessions used, ${remainingSessions} remaining`
            );

            // Prepare additional user info for the greeting
            const techUsage = user.techUsage || "not specified";
            const experienceLevel = user.experienceLevel || "beginner";
            const accessibilityNeeds = user.accessibilityNeeds || "none";

            console.log(
              `⚠️ DEBUG - User profile: Tech usage: ${techUsage}, Experience: ${experienceLevel}, Accessibility: ${accessibilityNeeds}`
            );

            if (sessionCount >= 3) {
              // No remaining sessions - tell user and hang up
              console.log(
                "⚠️ DEBUG - User has reached session limit in Option 1"
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
              // Has remaining sessions - provide options to press 2
              console.log(
                "⚠️ DEBUG - User has sessions remaining, presenting option to press 2"
              );

              // Use gather to allow pressing 2 after the info is given
              const gather = resp.gather({
                numDigits: 1,
                action: `${host}/twilio/voice`,
                method: "POST",
              });

              // Prepare the gather message
              let gatherText = `<speak>Hello ${user.name}! <break time='200ms'/> `;
              gatherText += `Your account email is ${user.email}. <break time='200ms'/> `;
              gatherText += `Your tech usage is ${techUsage} with ${experienceLevel} experience level. <break time='300ms'/> `;
              gatherText += `You have ${remainingSessions} help ${
                remainingSessions === 1 ? "session" : "sessions"
              } remaining this month. <break time='300ms'/> `;
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
      // Option 2: Talk to representative
      const callerNumber = req.body.From || "";
      console.log(
        `👩‍💼 OPTION 2 SELECTED: Checking account status for caller: ${callerNumber}`
      );

      // Make the response async to handle database operations
      (async () => {
        try {
          const user = await findUserByPhone(callerNumber);

          if (user) {
            // User found - check their session count
            const sessionCount = await countUserSessions(user.id);

            if (sessionCount >= 3) {
              // User has used all their monthly sessions
              console.log(`⛔ USER ${user.name} HAS REACHED SESSION LIMIT`);

              // Send SMS notification to admin
              await sendSmsNotification(
                "blocked (session limit)",
                callerNumber,
                `User: ${user.name}, Used all 3 monthly sessions`
              );

              resp.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                "<speak>I'm sorry, but you've used all 3 of your help sessions for this month. <break time='300ms'/> Please check back next month for more available sessions. <break time='200ms'/> Thank you for using Eldrix!</speak>"
              );
              resp.hangup();
            } else {
              // User has sessions remaining - create help session and connect the call
              console.log(
                `✅ CONNECTING REGISTERED USER: ${user.name} (${sessionCount}/3 sessions used)`
              );

              // Create a help session record
              try {
                const helpSessionId = await createHelpSession(user.id, "phone");
                if (helpSessionId) {
                  console.log(
                    `✅ Created help session ${helpSessionId} for user ${user.name}`
                  );
                } else {
                  console.error(
                    `⚠️ Failed to create help session for user ${user.name}`
                  );
                }
              } catch (sessionError) {
                console.error("Error creating help session:", sessionError);
              }

              // Use just the phone number for callerId (most compatible with carriers)
              // But add a whisper message that plays before connecting to identify the caller
              console.log(
                `📱 CONNECTING CALL: Registered user ${user.name} to representative at ${FORWARD_NUMBER}`
              );
              console.log(
                `📊 SESSION INFO: User has used ${sessionCount} out of 3 monthly sessions`
              );
              console.log(
                `📋 USER DETAILS: Tech usage: ${
                  user.techUsage || "not specified"
                }, Experience: ${user.experienceLevel || "beginner"}`
              );

              const dial = resp.dial({
                callerId: callerNumber,
                timeout: 30,
                action: `${host}/twilio/no-answer`,
                method: "POST",
              });

              // Add a number with a whisper URL that will play a message to you before connecting
              dial.number(
                {
                  url: `${host}/twilio/whisper?type=customer&name=${encodeURIComponent(
                    user.name || "registered"
                  )}`,
                },
                FORWARD_NUMBER
              );
            }
          } else {
            // No user found - check if they've used a free trial before
            const freeTrialUsed = await hasUsedFreeTrial(callerNumber);

            if (freeTrialUsed) {
              // Already used free trial - inform the caller
              console.log("⛔ FREE TRIAL ALREADY USED: Denying free trial");

              // Send SMS notification to admin
              await sendSmsNotification(
                "denied free trial (already used)",
                callerNumber,
                "Caller already used their free trial and tried again"
              );

              resp.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                "<speak>We notice you've already used a free trial call with us. <break time='300ms'/> To create an account and get regular access, please visit our website at eldrix.app. <break time='300ms'/> Thank you for your interest in our services. <break time='200ms'/> Goodbye!</speak>"
              );
              resp.hangup();
            } else {
              // Eligible for free trial - offer it
              console.log("🆓 NEW USER: Offering free trial call");

              // Add a gather to confirm they want the free trial
              const gather = resp.gather({
                numDigits: 1,
                action: `${host}/twilio/free-trial`,
                method: "POST",
              });

              gather.say(
                {
                  voice: "Polly.Joanna",
                  language: "en-US",
                },
                "<speak>We don't have an account with your phone number yet. <break time='300ms'/> We're offering you a free trial call with our representative. <break time='300ms'/> Press 1 to continue with your free trial call. <break time='200ms'/> Press 2 to end the call.</speak>"
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
          }

          res.type("text/xml").send(resp.toString());
        } catch (error) {
          console.error(
            "Error in account lookup for representative connection:",
            error
          );

          // In case of error, connect the call anyway
          console.log("⚠️ ERROR DURING LOOKUP: Connecting call as fallback");
          resp.dial(
            {
              callerId: `CUSTOMER - ${callerNumber}`,
              timeout: 30,
              action: `${host}/twilio/no-answer`,
              method: "POST",
            },
            FORWARD_NUMBER
          );

          res.type("text/xml").send(resp.toString());
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
app.post("/twilio/no-answer", (req: Request, res: Response) => {
  console.log("📵 NO ANSWER", {
    callSid: req.body.CallSid,
    dialStatus: req.body.DialCallStatus,
    timestamp: new Date().toISOString(),
  });

  const resp = new VoiceResponse();
  resp.say(
    {
      voice: "Polly.Joanna",
      language: "en-US",
    },
    "<speak>Sorry, we couldn't reach our representative at this time. <break time='300ms'/> We'll call you back as soon as possible. <break time='200ms'/> Thank you for contacting Eldrix!</speak>"
  );
  resp.hangup();
  res.type("text/xml").send(resp.toString());
});

// 4) Free trial confirmation handler
app.post("/twilio/free-trial", (req: Request, res: Response) => {
  const digits = req.body.Digits;
  const callerNumber = req.body.From || "";
  const host = `${req.protocol}://${req.get("host")}`;

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
            callerId: callerNumber,
            timeout: 30,
            action: `${host}/twilio/no-answer`,
            method: "POST",
          });

          // Add a number with a whisper URL that will play a message to you before connecting
          dial.number(
            {
              url: `${host}/twilio/whisper?type=freetrial`,
            },
            FORWARD_NUMBER
          );
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
  const type = req.query.type as string;
  const name = req.query.name as string;

  console.log("💬 WHISPER", { type, name });
  console.log(
    `📞 WHISPER PREPARING CALL: Starting 5-second countdown for call to ${FORWARD_NUMBER}`
  );
  console.log(
    `⏱️ COUNTDOWN STARTED: Call will connect to ${FORWARD_NUMBER} in 5 seconds...`
  );

  const resp = new VoiceResponse();

  if (type === "customer") {
    // Registered customer
    resp.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      `<speak>
        Incoming call from customer ${name || "with account"}. 
        <break time="1s"/>
        Connecting in 5 seconds.
        <break time="1s"/> 
        5... <break time="1s"/> 
        4... <break time="1s"/> 
        3... <break time="1s"/> 
        2... <break time="1s"/> 
        1... <break time="1s"/>
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
        Incoming call from free trial customer. 
        <break time="1s"/>
        Connecting in 5 seconds.
        <break time="1s"/> 
        5... <break time="1s"/> 
        4... <break time="1s"/> 
        3... <break time="1s"/> 
        2... <break time="1s"/> 
        1... <break time="1s"/>
        Connecting now.
      </speak>`
    );
  } else {
    // Default
    resp.say(
      {
        voice: "Polly.Joanna",
        language: "en-US",
      },
      `<speak>
        Incoming customer call.
        <break time="1s"/>
        Connecting in 5 seconds.
        <break time="1s"/> 
        5... <break time="1s"/> 
        4... <break time="1s"/> 
        3... <break time="1s"/> 
        2... <break time="1s"/> 
        1... <break time="1s"/>
        Connecting now.
      </speak>`
    );
  }

  res.type("text/xml").send(resp.toString());
});

// 6) SMS handling endpoint for incoming text messages
app.post("/twilio/sms", (req: Request, res: Response) => {
  console.log("📱 INCOMING SMS", {
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body,
    timestamp: new Date().toISOString(),
  });

  const senderNumber = req.body.From || "";
  const messageBody = req.body.Body || "";

  // Make the response async to handle database operations
  (async () => {
    try {
      // Check if the sender is a registered user
      const user = await findUserByPhone(senderNumber);

      if (user) {
        // User found - check their session count
        const sessionCount = await countUserSessions(user.id);
        const remainingSessions = Math.max(0, 3 - sessionCount);

        console.log(
          `✅ SMS FROM REGISTERED USER: ${user.name} (${sessionCount}/3 sessions used)`
        );

        if (sessionCount >= 3) {
          // User has used all their monthly sessions
          console.log(`⛔ USER ${user.name} HAS REACHED SESSION LIMIT`);

          // Send SMS response to user
          await client.messages.create({
            body: `Hello ${user.name}! You've used all 3 of your help sessions for this month. Please check back next month for more available sessions.`,
            from: TWILIO_PHONE_NUMBER,
            to: senderNumber,
          });

          // Notify admin but don't forward the message
          await client.messages.create({
            body: `ELDRIX SMS ALERT: Message received from ${senderNumber} (${user.name}), but not forwarded because they've used all their monthly sessions.\n\nTheir message: "${messageBody}"`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });
        } else {
          // User has sessions remaining - check for existing active SMS session before creating a new one
          console.log(
            `✅ PROCESSING SMS: From ${user.name} (${remainingSessions} sessions remaining)`
          );

          // Variables to track session state
          let isNewSession = true;
          let helpSessionId: string | null = null;

          try {
            // Check for an existing active (uncompleted) SMS session for this user
            const [existingSessions]: [any[], any] = await dbPool.execute(
              "SELECT * FROM HelpSession WHERE userId = ? AND type = 'sms' AND completed = 0 ORDER BY createdAt DESC LIMIT 1",
              [user.id]
            );

            // Update our isNewSession flag based on query results
            isNewSession =
              !Array.isArray(existingSessions) || existingSessions.length === 0;

            // helpSessionId is already declared in the outer scope

            if (
              Array.isArray(existingSessions) &&
              existingSessions.length > 0
            ) {
              // Found an existing active SMS session - use it instead of creating a new one
              const existingSession = existingSessions[0];
              helpSessionId = existingSession.id;
              console.log(
                `✅ Found existing SMS session ${helpSessionId} for user ${user.name} - continuing conversation`
              );
            } else {
              // No existing active SMS session found - create a new one
              console.log(
                `📝 No active SMS session found - creating new session for user ${user.name}`
              );
              helpSessionId = await createHelpSession(
                user.id,
                "sms",
                messageBody
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
                messageBody,
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
            // New session notification with session count info
            adminMessagePrefix = `From: ${user.name} (${senderNumber})\nRemaining sessions: ${remainingSessions}/3\n\n`;
          } else {
            // Ongoing conversation notification
            adminMessagePrefix = `${user.name} (${senderNumber}) replied to their ongoing conversation.\n\n`;
          }

          // Common part of the message including chat link
          const chatLink = helpSessionId
            ? `http://localhost:3001/chat?id=${helpSessionId}`
            : "";

          await client.messages.create({
            body: `${adminMessagePrefix}To reply directly to this user, respond with your message OR start with their number: ${senderNumber} Your message here\n\nClick here to respond in web interface: ${chatLink}\n\n${messageBody}`,
            from: TWILIO_PHONE_NUMBER,
            to: ADMIN_PHONE,
          });

          // We already determined if this is a new session above, so we don't need to check again

          // Only send the confirmation message if this is a new session
          if (isNewSession) {
            // Format the message based on which session number this is
            let sessionMessage = "";
            if (sessionCount === 0) {
              // First session
              sessionMessage = `This is your first session of 3 this month.`;
            } else if (sessionCount === 1) {
              // Second session
              sessionMessage = `This is your second session of 3 this month.`;
            } else if (sessionCount === 2) {
              // Third session
              sessionMessage = `This is your final session of 3 this month.`;
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
            body: `ELDRIX SMS ALERT: Message received from ${senderNumber}, but not forwarded because they've already used their free trial.\n\nTheir message: "${messageBody}"`,
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
            body: `FREE TRIAL SMS from: ${senderNumber}\n\nTo reply directly to this user, respond with your message OR start with their number: ${senderNumber} Your message here\n\nClick here to respond in web interface: http://localhost:3001/chat?id=${freeTrialSessionId}\n\n${messageBody}`,
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
          // Find the most recent active SMS help session for this user
          const [sessions]: [any[], any] = await dbPool.execute(
            "SELECT * FROM HelpSession WHERE userId = ? AND type = 'sms' AND status != 'completed' ORDER BY createdAt DESC LIMIT 1",
            [user.id]
          );

          if (Array.isArray(sessions) && sessions.length > 0) {
            const session = sessions[0];
            console.log(
              `✅ Found active SMS help session ${session.id} for user ${user.name}`
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
              `⚠️ No active SMS help session found for user ${user.name}. Creating a new one.`
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

// 8) SMS response handler for external API integration
app.post("/twilio/sms/respond", (req: Request, res: Response) => {
  console.log("📱 SMS RESPOND API CALL", {
    sessionId: req.body.sessionId,
    userId: req.body.userId,
    messageLength: req.body.message?.length || 0,
    timestamp: new Date().toISOString(),
  });

  (async () => {
    try {
      // Validate required parameters
      const { sessionId, message, userId } = req.body;

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
          const [users]: [any[], any] = await dbPool.execute(
            "SELECT * FROM User WHERE id = ?",
            [userId]
          );

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
      const smsResult = await client.messages.create({
        body: message,
        from: TWILIO_PHONE_NUMBER,
        to: formattedPhone,
      });

      console.log(
        `✅ Successfully sent SMS to ${formattedPhone}, SID: ${smsResult.sid}`
      );

      // Skip storing message in database - this will be handled by the external system

      // Send a successful response
      res.json({
        success: true,
        messageId: smsResult.sid,
        to: formattedPhone,
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

app.listen(Number(PORT), () => {
  console.log(`🚀 Listening on http://localhost:${PORT}`);
});
