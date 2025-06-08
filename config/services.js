/**
 * Configuration des services externes
 * @module config/services
 */

require('dotenv').config();

// Configuration Google
const googleConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID_CALENDAR,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET_CALENDAR,
    redirectUri: process.env.GOOGLE_REDIRECT_URI_CALENDAR || 'https://capy-invest-fr.webflow.io/compte-utilisateur',
    scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
    ]
};

module.exports = {
    googleConfig
};