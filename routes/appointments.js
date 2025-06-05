 /**
 * Routes API pour la gestion des rendez-vous
 * @module routes/appointments
 */

const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const googleCalendar = require('../services/googleCalendar');
const emailService = require('../services/emailService');
const { authMiddleware } = require('../middleware/auth');

// Middleware d'authentification pour toutes les routes
router.use(authMiddleware);

/**
 * Récupère les rendez-vous d'un conseiller
 */
router.get('/conseiller', async (req, res) => {
  try {
    const appointments = await Appointment.findByConseillerId(req.user.id);
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Récupère les rendez-vous d'un client
 */
router.get('/client', async (req, res) => {
  try {
    const appointments = await Appointment.findByClientId(req.user.id);
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Crée un nouveau rendez-vous
 */
router.post('/', async (req, res) => {
  try {
    const { conseillerId, startTime, endTime, type, notes } = req.body;

    // Vérification de la disponibilité du créneau
    const isAvailable = await googleCalendar.isSlotAvailable(
      'primary',
      new Date(startTime),
      new Date(endTime)
    );

    if (!isAvailable) {
      return res.status(400).json({ error: 'Créneau non disponible' });
    }

    // Création de l'événement Google Calendar
    const googleEvent = await googleCalendar.createEvent('primary', {
      summary: `RDV CAPY Invest - ${type}`,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
      description: notes
    });

    // Création du rendez-vous dans la base de données
    const appointment = new Appointment({
      id: Date.now().toString(),
      conseillerId,
      clientId: req.user.id,
      startTime,
      endTime,
      type,
      notes,
      status: 'confirmed',
      googleEventId: googleEvent.id
    });

    await appointment.save();

    // Envoi de l'email de confirmation
    await emailService.sendAppointmentConfirmation(appointment, req.user);

    res.json(appointment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Annule un rendez-vous
 */
router.delete('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);

    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé' });
    }

    // Vérification des droits
    if (appointment.conseillerId !== req.user.id && appointment.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // Suppression de l'événement Google Calendar
    if (appointment.googleEventId) {
      await googleCalendar.deleteEvent('primary', appointment.googleEventId);
    }

    // Suppression du rendez-vous
    await Appointment.delete(req.params.id);

    // Envoi de l'email d'annulation
    await emailService.sendAppointmentCancellation(appointment, req.user);

    res.json({ message: 'Rendez-vous annulé avec succès' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;