/**
 * Routes API pour la gestion des rendez-vous
 * @module routes/appointment
 */

const express = require('express');
const router = express.Router();
const Appointment = require('./Appointment');
const googleCalendar = require('./googleCalendar');
const emailService = require('./emailService');
const { requireAuth } = require('../middlewareauth');

// Route PUBLIQUE : disponibilité des créneaux
router.get('/availability/:conseillerId', async (req, res) => {
  try {
    const { conseillerId } = req.params;
    const appointments = await Appointment.findByConseillerId(conseillerId);
    const slots = [];
    const now = new Date();
    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      for (let hour = 9; hour < 18; hour++) {
        const slotStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0);
        const slotEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour + 1, 0, 0);
        const isTaken = appointments.some(app => {
          return (
            new Date(app.startTime) < slotEnd && new Date(app.endTime) > slotStart
          );
        });
        if (!isTaken && slotStart > now) {
          slots.push(slotStart.toISOString());
        }
      }
    }
    res.json(slots);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Middleware d'authentification pour toutes les autres routes
router.use(requireAuth);

// Récupère les rendez-vous d'un conseiller
router.get('/conseiller', async (req, res) => {
  try {
    const appointments = await Appointment.findByConseillerId(req.user.id);
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Récupère les rendez-vous d'un client
router.get('/client', async (req, res) => {
  try {
    const appointments = await Appointment.findByClientId(req.user.id);
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crée un nouveau rendez-vous
router.post('/', async (req, res) => {
  try {
    const { conseillerId, startTime, endTime, type, notes } = req.body;
    const isAvailable = await googleCalendar.isSlotAvailable(
      'primary',
      new Date(startTime),
      new Date(endTime)
    );
    if (!isAvailable) {
      return res.status(400).json({ error: 'Créneau non disponible' });
    }
    const googleEvent = await googleCalendar.createEvent('primary', {
      summary: `RDV CAPY Invest - ${type}`,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
      description: notes
    });
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
    await emailService.sendAppointmentConfirmation(appointment, req.user);
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Annule un rendez-vous
router.delete('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé' });
    }
    if (appointment.conseillerId !== req.user.id && appointment.clientId !== req.user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }
    if (appointment.googleEventId) {
      await googleCalendar.deleteEvent('primary', appointment.googleEventId);
    }
    await Appointment.delete(req.params.id);
    await emailService.sendAppointmentCancellation(appointment, req.user);
    res.json({ message: 'Rendez-vous annulé avec succès' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router; 