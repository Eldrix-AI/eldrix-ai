# Eldrix AI Server

Express.js server for the Eldrix AI platform, handling Twilio integration for calls, SMS, and user management.

## Local Development

1. Install dependencies:

   ```
   npm install
   ```

2. Create a `.env` file based on the `env.example` file and fill in your credentials.

3. Run development server:
   ```
   npm run dev
   ```

## Deployment to Vercel

This project is configured for serverless deployment on Vercel. To deploy:

1. Make sure you have the Vercel CLI installed:

   ```
   npm i -g vercel
   ```

2. Log in to Vercel:

   ```
   vercel login
   ```

3. Deploy to Vercel:

   ```
   vercel
   ```

4. For production deployment:
   ```
   vercel --prod
   ```

## Environment Variables

The following environment variables must be set in your Vercel project settings:

- `PORT`: Server port (default: 3000)
- `TWILIO_ACCOUNT_SID`: Your Twilio account SID
- `TWILIO_AUTH_TOKEN`: Your Twilio auth token
- `TWILIO_PHONE_NUMBER`: Your Twilio phone number
- `FORWARD_NUMBER`: Number to forward calls to
- `ADMIN_PHONE`: Admin phone number for notifications
- `DB_HOST`: Database host
- `DB_USER`: Database username
- `DB_PASSWORD`: Database password
- `DB_NAME`: Database name
- `DB_PORT`: Database port
- `DATABASE_URL`: Complete database connection string
- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key
- `AWS_REGION`: AWS region (default: us-east-2)
- `AWS_BUCKET_NAME`: S3 bucket name
- `FRONTEND_URL`: URL for the frontend application
- `VERCEL_URL`: Automatically provided by Vercel

## API Endpoints

The server exposes various endpoints for Twilio integration:

- `/api/health`: Health check endpoint
- `/api/debug/phone`: Debug endpoint for phone configuration
- `/api/test-call`: Test endpoint for direct calls
- `/api/test-dial`: Test endpoint for TwiML generation
- `/twilio/voice`: Inbound call handler
- `/twilio/no-answer`: No-answer handler
- `/twilio/free-trial`: Free trial confirmation handler
- `/twilio/whisper`: Whisper handler
- `/twilio/sms`: SMS handling endpoint
- `/twilio/sms-reply`: SMS reply handler
- `/twilio/call-status`: Call status tracking endpoint
- `/twilio/recording-status`: Recording status callback
- `/twilio/sms/respond`: SMS response handler
