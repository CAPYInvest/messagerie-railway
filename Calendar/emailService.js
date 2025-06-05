/**
 * Service d'envoi d'emails avec Brevo (Sendinblue)
 * @module services/emailService
 */

const { googleConfig } = require('../config/services');
const { google } = require('googleapis');
const SibApiV3Sdk = require('sib-api-v3-sdk');

// Configuration de l'API Brevo
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY_CALENDAR;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

class EmailService {
  constructor() {
    this.apiInstance = apiInstance;
  }

  /**
   * Envoie un email de confirmation de rendez-vous
   */
  async sendAppointmentConfirmation(appointment, user) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Confirmation de votre rendez-vous CAPY Invest";
    sendSmtpEmail.htmlContent = `
      <h1>Votre rendez-vous est confirmé</h1>
      <p>Bonjour ${user.firstName},</p>
      <p>Votre rendez-vous du ${new Date(appointment.startTime).toLocaleDateString()} 
         à ${new Date(appointment.startTime).toLocaleTimeString()} est confirmé.</p>
      <p>Type de rendez-vous : ${appointment.type}</p>
      ${appointment.notes ? `<p>Notes : ${appointment.notes}</p>` : ''}
    `;
    sendSmtpEmail.sender = {
      name: googleConfig.senderName,
      email: googleConfig.senderEmail
    };
    sendSmtpEmail.to = [{ email: user.email, name: `${user.firstName} ${user.lastName}` }];

    return this.apiInstance.sendTransacEmail(sendSmtpEmail);
  }

  /**
   * Envoie un email de rappel de rendez-vous
   */
  async sendAppointmentReminder(appointment, user) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Rappel de votre rendez-vous CAPY Invest";
    sendSmtpEmail.htmlContent = `
      <h1>Rappel de rendez-vous</h1>
      <p>Bonjour ${user.firstName},</p>
      <p>Nous vous rappelons votre rendez-vous du ${new Date(appointment.startTime).toLocaleDateString()} 
         à ${new Date(appointment.startTime).toLocaleTimeString()}.</p>
      <p>Type de rendez-vous : ${appointment.type}</p>
    `;
    sendSmtpEmail.sender = {
      name: googleConfig.senderName,
      email: googleConfig.senderEmail
    };
    sendSmtpEmail.to = [{ email: user.email, name: `${user.firstName} ${user.lastName}` }];

    return this.apiInstance.sendTransacEmail(sendSmtpEmail);
  }

  /**
   * Envoie un email d'annulation de rendez-vous
   */
  async sendAppointmentCancellation(appointment, user) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Annulation de votre rendez-vous CAPY Invest";
    sendSmtpEmail.htmlContent = `
      <h1>Votre rendez-vous a été annulé</h1>
      <p>Bonjour ${user.firstName},</p>
      <p>Votre rendez-vous du ${new Date(appointment.startTime).toLocaleDateString()} 
         à ${new Date(appointment.startTime).toLocaleTimeString()} a été annulé.</p>
      <p>Type de rendez-vous : ${appointment.type}</p>
    `;
    sendSmtpEmail.sender = {
      name: googleConfig.senderName,
      email: googleConfig.senderEmail
    };
    sendSmtpEmail.to = [{ email: user.email, name: `${user.firstName} ${user.lastName}` }];

    return this.apiInstance.sendTransacEmail(sendSmtpEmail);
  }
}

module.exports = new EmailService();