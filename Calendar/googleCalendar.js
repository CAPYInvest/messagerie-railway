/**
 * Service de gestion Google Calendar
 * @module services/googleCalendar
 */

const { google } = require('googleapis');
const { googleConfig } = require('../config/services');

// Configuration de l'API Google Calendar
const oauth2Client = new google.auth.OAuth2(
    googleConfig.clientId,
    googleConfig.clientSecret,
    googleConfig.redirectUri
);

class GoogleCalendarService {
  constructor() {
    this.oauth2Client = oauth2Client;
    console.log('[Google Calendar] Service initialisé avec:', {
      clientId: googleConfig.clientId ? 'Défini' : 'Non défini',
      clientSecret: googleConfig.clientSecret ? 'Défini' : 'Non défini',
      redirectUri: googleConfig.redirectUri
    });
  }

  /**
   * Génère l'URL d'autorisation OAuth2
   */
  getAuthUrl() {
    const url = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: googleConfig.scopes,
      // Forcer l'affichage du consentement pour obtenir un refresh_token
      prompt: 'consent',
      // Inclure l'état pour éviter les attaques CSRF
      state: Date.now().toString()
    });
    console.log('[Google Calendar] URL d\'authentification générée:', url);
    return url;
  }

  /**
   * Échange le code d'autorisation contre des tokens
   */
  async getTokens(code) {
    try {
      console.log('[Google Calendar] Tentative d\'échange du code:', code);
      console.log('[Google Calendar] Configuration OAuth2:', {
        clientId: this.oauth2Client._clientId,
        redirectUri: this.oauth2Client._redirectUri
      });

      // Vérifier que l'URI de redirection correspond
      if (this.oauth2Client._redirectUri !== googleConfig.redirectUri) {
        console.log('[Google Calendar] Mise à jour de l\'URI de redirection');
        this.oauth2Client = new google.auth.OAuth2(
          googleConfig.clientId,
          googleConfig.clientSecret,
          googleConfig.redirectUri
        );
      }

      // Définir un délai d'attente pour la requête
      const tokenPromise = this.oauth2Client.getToken(code);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Délai d\'attente dépassé')), 10000);
      });

      const { tokens } = await Promise.race([tokenPromise, timeoutPromise]);

      if (!tokens) {
        throw new Error('Aucun token reçu de Google');
      }

      console.log('[Google Calendar] Tokens reçus avec succès:', {
        access_token: tokens.access_token ? 'Présent' : 'Absent',
        refresh_token: tokens.refresh_token ? 'Présent' : 'Absent',
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date
      });
      return tokens;
    } catch (error) {
      console.error('[Google Calendar] Erreur lors de l\'échange du code:', error);
      
      // Gestion spécifique des erreurs Google OAuth
      if (error.message && error.message.includes('invalid_grant')) {
        console.error('[Google Calendar] Erreur invalid_grant - Le code a probablement expiré ou a déjà été utilisé');
        throw new Error('Le code d\'autorisation a expiré ou a déjà été utilisé. Veuillez réessayer la synchronisation.');
      }
      
      console.error('[Google Calendar] Détails de l\'erreur:', {
        message: error.message,
        code: error.code,
        errors: error.errors
      });
      
      throw error;
    }
  }

  /**
   * Configure les credentials pour les requêtes API
   */
  setCredentials(tokens) {
    console.log('[Google Calendar] Configuration des credentials');
    try {
      if (!tokens || !tokens.access_token) {
        throw new Error('Tokens invalides');
      }
      this.oauth2Client.setCredentials(tokens);
    } catch (error) {
      console.error('[Google Calendar] Erreur lors de la configuration des credentials:', error);
      throw error;
    }
  }

  /**
   * Crée un événement dans Google Calendar
   */
  async createEvent(calendarId, event) {
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const response = await calendar.events.insert({
      calendarId,
      requestBody: event
    });
    return response.data;
  }

  /**
   * Met à jour un événement dans Google Calendar
   */
  async updateEvent(calendarId, eventId, event) {
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const response = await calendar.events.update({
      calendarId,
      eventId,
      requestBody: event
    });
    return response.data;
  }

  /**
   * Supprime un événement de Google Calendar
   */
  async deleteEvent(calendarId, eventId) {
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    await calendar.events.delete({
      calendarId,
      eventId
    });
  }

  /**
   * Récupère les événements d'une période donnée
   */
  async listEvents(calendarId, timeMin, timeMax) {
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    return response.data.items;
  }

  /**
   * Vérifie si un créneau est disponible
   */
  async isSlotAvailable(calendarId, startTime, endTime) {
    const events = await this.listEvents(calendarId, startTime, endTime);
    return events.length === 0;
  }
}

module.exports = new GoogleCalendarService();
