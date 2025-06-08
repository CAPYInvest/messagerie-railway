/**
 * Configuration des services externes
 * @module config/services
 */

require('dotenv').config();

// Configuration Google
const googleConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI || 'https://capy-invest-fr.webflow.io/compte-utilisateur',
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ]
};

// Vérification de la configuration
console.log('[Config] Vérification de la configuration Google:', {
  clientId: googleConfig.clientId ? 'Défini' : 'Non défini',
  clientSecret: googleConfig.clientSecret ? 'Défini' : 'Non défini',
  redirectUri: googleConfig.redirectUri,
  scopes: googleConfig.scopes
});

// Configuration Brevo (Sendinblue)
const brevoConfig = {
  apiKey: process.env.BREVO_API_KEY_CALENDAR,
  senderEmail: process.env.BREVO_SENDER_EMAIL_CALENDAR
};

module.exports = {
  googleConfig,
  brevoConfig
};