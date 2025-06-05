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
  }

  /**
   * Génère l'URL d'autorisation OAuth2
   */
  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: googleConfig.scopes,
      prompt: 'consent'
    });
  }

  /**
   * Échange le code d'autorisation contre des tokens
   */
  async getTokens(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    return tokens;
  }

  /**
   * Configure le client avec les tokens
   */
  setCredentials(tokens) {
    this.oauth2Client.setCredentials(tokens);
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
