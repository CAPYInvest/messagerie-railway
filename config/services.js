/**
 * Configuration des services externes
 * @module config/services
 */

// Configuration Google Calendar
const googleConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID_CALENDAR,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET_CALENDAR,
  redirectUri: process.env.GOOGLE_REDIRECT_URI_CALENDAR,
  scopes: ['https://www.googleapis.com/auth/calendar']
};

// Configuration Brevo (Sendinblue)
const brevoConfig = {
  apiKey: process.env.BREVO_API_KEY_CALENDAR,
  senderEmail: process.env.BREVO_SENDER_EMAIL_CALENDAR
};

module.exports = {
  googleConfig,
  brevoConfig
};