// Script de test pour l'API Google Calendar
require('dotenv').config();
const { google } = require('googleapis');

// Configuration similaire à celle de l'application
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID_CALENDAR,
    process.env.GOOGLE_CLIENT_SECRET_CALENDAR,
    process.env.GOOGLE_REDIRECT_URI_CALENDAR || 'https://capy-invest-fr.webflow.io/compte-utilisateur'
);

// Fonction pour générer l'URL d'authentification
function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events'
        ],
        prompt: 'consent'
    });
}

// Fonction pour obtenir les tokens à partir du code
async function getTokens(code) {
    try {
        const { tokens } = await oauth2Client.getToken(code);
        return tokens;
    } catch (error) {
        console.error('Erreur lors de l\'échange du code:', error);
        throw error;
    }
}

// Fonction pour lister les événements
async function listEvents(tokens) {
    try {
        // Configurer les credentials
        oauth2Client.setCredentials(tokens);
        
        // Créer un client Calendar API
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        // Définir la période pour les événements
        const now = new Date();
        const oneMonthAgo = new Date(now);
        oneMonthAgo.setMonth(now.getMonth() - 1);
        const oneMonthLater = new Date(now);
        oneMonthLater.setMonth(now.getMonth() + 1);
        
        // Appel API pour récupérer les événements
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: oneMonthAgo.toISOString(),
            timeMax: oneMonthLater.toISOString(),
            singleEvents: true,
            orderBy: 'startTime'
        });
        
        // Récupérer les événements
        const events = response.data.items;
        
        if (events.length) {
            console.log('Événements trouvés:');
            events.forEach(event => {
                const start = event.start.dateTime || event.start.date;
                console.log(`- ${start} - ${event.summary}`);
            });
        } else {
            console.log('Aucun événement trouvé.');
        }
        
        return events;
    } catch (error) {
        console.error('Erreur lors de la récupération des événements:', error);
        throw error;
    }
}

// Traitement principal basé sur les arguments
async function main() {
    // Si aucun token n'est fourni, afficher l'URL d'authentification
    if (process.argv.length < 3) {
        console.log('URL d\'authentification:');
        console.log(getAuthUrl());
        console.log('\nUtilisez cette commande après avoir obtenu le code:');
        console.log('node test-google-api.js CODE_AUTORISATION');
    } else {
        try {
            // Utiliser le code d'authentification fourni
            const code = process.argv[2];
            console.log('Échange du code d\'autorisation contre des tokens...');
            const tokens = await getTokens(code);
            console.log('Tokens obtenus avec succès:');
            console.log('- Access Token:', tokens.access_token ? 'Présent' : 'Absent');
            console.log('- Refresh Token:', tokens.refresh_token ? 'Présent' : 'Absent');
            console.log('- Expiration:', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'Non définie');
            
            // Récupérer les événements
            console.log('\nRécupération des événements...');
            await listEvents(tokens);
        } catch (error) {
            console.error('Erreur:', error.message);
        }
    }
}

// Exécuter le programme
main().catch(console.error); 