/**
 * Routes de gestion des événements du calendrier
 * @module routes/calendarEvents
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middlewareauth');
// Utiliser l'instance Firebase Admin déjà initialisée dans server.js
const admin = require('firebase-admin');
const { google } = require('googleapis');
const googleCalendarService = require('./googleCalendar');

// Référence à la collection Firestore
// Utiliser getFirestore() pour accéder à l'instance Firestore déjà initialisée
const db = admin.firestore();
const eventsCollection = db.collection('calendar_events');

// Configurer les en-têtes CORS
function setCorsHeaders(req, res) {
  const origin = req.headers.origin || 'https://capy-invest-fr.webflow.io';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
}

// Middleware pour le débogage
const debugMiddleware = (req, res, next) => {
  console.log('[Calendar Events] Requête reçue:', req.method, req.path);
  console.log('[Calendar Events] Headers:', req.headers);
  
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('[Calendar Events] Body:', req.body);
  }
  
  // Ajout d'en-têtes CORS
  setCorsHeaders(req, res);
  
  next();
};

// Middleware pour extraire l'ID utilisateur du token JWT
const extractUserIdMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      // Décodage du token sans vérification (juste pour obtenir l'ID)
      const decoded = require('jsonwebtoken').decode(token);
      if (decoded && decoded.uid) {
        req.userId = decoded.uid;
        console.log('[Calendar Events] ID utilisateur extrait:', req.userId);
      }
    }
    next();
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de l\'extraction de l\'ID utilisateur:', error);
    next();
  }
};

// Appliquer les middlewares
router.use(debugMiddleware);
router.use(extractUserIdMiddleware);

/**
 * Récupère les événements d'un utilisateur
 * GET /api/calendar/events
 */
router.get('/events', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    // Récupérer les événements de la base de données
    const snapshot = await eventsCollection
      .where('userId', '==', req.userId)
      .get();

    const events = [];
    snapshot.forEach(doc => {
      const event = doc.data();
      events.push({
        id: doc.id,
        title: event.title,
        start: event.start.toDate().toISOString(),
        end: event.end.toDate().toISOString(),
        description: event.description || '',
        googleEventId: event.googleEventId || null
      });
    });

    console.log(`[Calendar Events] ${events.length} événements récupérés pour l'utilisateur ${req.userId}`);
    res.json(events);
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la récupération des événements:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des événements' });
  }
});

/**
 * Récupère un événement spécifique
 * GET /api/calendar/events/:id
 */
router.get('/events/:id', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const eventId = req.params.id;
    const eventDoc = await eventsCollection.doc(eventId).get();

    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    const event = eventDoc.data();
    
    // Vérifier que l'événement appartient à l'utilisateur
    if (event.userId !== req.userId) {
      return res.status(403).json({ error: 'Accès non autorisé à cet événement' });
    }

    res.json({
      id: eventDoc.id,
      title: event.title,
      start: event.start.toDate().toISOString(),
      end: event.end.toDate().toISOString(),
      description: event.description || '',
      googleEventId: event.googleEventId || null
    });
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la récupération de l\'événement:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'événement' });
  }
});

/**
 * Crée un nouvel événement
 * POST /api/calendar/events
 */
router.post('/events', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const { title, start, end, description } = req.body;
    
    // Validation des données
    if (!title || !start || !end) {
      return res.status(400).json({ error: 'Titre, date de début et de fin requis' });
    }

    // Convertir les dates
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (endDate <= startDate) {
      return res.status(400).json({ error: 'La date de fin doit être postérieure à la date de début' });
    }

    // Créer l'événement dans Firestore
    const eventData = {
      userId: req.userId,
      title,
      start: admin.firestore.Timestamp.fromDate(startDate),
      end: admin.firestore.Timestamp.fromDate(endDate),
      description: description || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Vérifier si l'utilisateur a connecté Google Calendar
    const syncState = getUserSyncState(req.userId);
    
    if (syncState && syncState.isConnected && syncState.googleTokens) {
      try {
        // Synchroniser avec Google Calendar
        const googleEvent = await createGoogleCalendarEvent(req.userId, {
          title,
          start: startDate,
          end: endDate,
          description: description || ''
        });
        
        if (googleEvent && googleEvent.id) {
          eventData.googleEventId = googleEvent.id;
          console.log(`[Calendar Events] Événement créé dans Google Calendar: ${googleEvent.id}`);
        }
      } catch (googleError) {
        console.error('[Calendar Events] Erreur lors de la création dans Google Calendar:', googleError);
        // Continuer même en cas d'erreur avec Google Calendar
      }
    }

    // Enregistrer dans Firestore
    const docRef = await eventsCollection.add(eventData);
    
    console.log(`[Calendar Events] Événement créé: ${docRef.id}`);
    
    res.status(201).json({
      id: docRef.id,
      title,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      description: description || '',
      googleEventId: eventData.googleEventId || null
    });
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la création de l\'événement:', error);
    res.status(500).json({ error: 'Erreur lors de la création de l\'événement' });
  }
});

/**
 * Met à jour un événement existant
 * PUT /api/calendar/events/:id
 */
router.put('/events/:id', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const eventId = req.params.id;
    const { title, start, end, description } = req.body;
    
    // Validation des données
    if (!title || !start || !end) {
      return res.status(400).json({ error: 'Titre, date de début et de fin requis' });
    }

    // Vérifier que l'événement existe et appartient à l'utilisateur
    const eventDoc = await eventsCollection.doc(eventId).get();
    
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    const existingEvent = eventDoc.data();
    
    if (existingEvent.userId !== req.userId) {
      return res.status(403).json({ error: 'Accès non autorisé à cet événement' });
    }

    // Convertir les dates
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (endDate <= startDate) {
      return res.status(400).json({ error: 'La date de fin doit être postérieure à la date de début' });
    }

    // Préparer les données de mise à jour
    const eventData = {
      title,
      start: admin.firestore.Timestamp.fromDate(startDate),
      end: admin.firestore.Timestamp.fromDate(endDate),
      description: description || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Mettre à jour dans Google Calendar si nécessaire
    if (existingEvent.googleEventId) {
      try {
        await updateGoogleCalendarEvent(req.userId, existingEvent.googleEventId, {
          title,
          start: startDate,
          end: endDate,
          description: description || ''
        });
        console.log(`[Calendar Events] Événement Google Calendar mis à jour: ${existingEvent.googleEventId}`);
      } catch (googleError) {
        console.error('[Calendar Events] Erreur lors de la mise à jour dans Google Calendar:', googleError);
        // Continuer même en cas d'erreur avec Google Calendar
      }
    }

    // Mettre à jour dans Firestore
    await eventsCollection.doc(eventId).update(eventData);
    
    console.log(`[Calendar Events] Événement mis à jour: ${eventId}`);
    
    res.json({
      id: eventId,
      title,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      description: description || '',
      googleEventId: existingEvent.googleEventId || null
    });
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la mise à jour de l\'événement:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'événement' });
  }
});

/**
 * Supprime un événement
 * DELETE /api/calendar/events/:id
 */
router.delete('/events/:id', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    const eventId = req.params.id;
    
    // Vérifier que l'événement existe et appartient à l'utilisateur
    const eventDoc = await eventsCollection.doc(eventId).get();
    
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Événement non trouvé' });
    }

    const existingEvent = eventDoc.data();
    
    if (existingEvent.userId !== req.userId) {
      return res.status(403).json({ error: 'Accès non autorisé à cet événement' });
    }

    // Supprimer de Google Calendar si nécessaire
    if (existingEvent.googleEventId) {
      try {
        await deleteGoogleCalendarEvent(req.userId, existingEvent.googleEventId);
        console.log(`[Calendar Events] Événement Google Calendar supprimé: ${existingEvent.googleEventId}`);
      } catch (googleError) {
        console.error('[Calendar Events] Erreur lors de la suppression dans Google Calendar:', googleError);
        // Continuer même en cas d'erreur avec Google Calendar
      }
    }

    // Supprimer de Firestore
    await eventsCollection.doc(eventId).delete();
    
    console.log(`[Calendar Events] Événement supprimé: ${eventId}`);
    
    res.json({ success: true, message: 'Événement supprimé avec succès' });
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la suppression de l\'événement:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'événement' });
  }
});

/**
 * Synchronise tous les événements d'un utilisateur avec Google Calendar
 * POST /api/calendar/sync
 */
router.post('/sync', requireAuth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    // Vérifier si l'utilisateur a connecté Google Calendar
    const syncState = getUserSyncState(req.userId);
    
    if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
      return res.status(400).json({ 
        error: 'Google Calendar n\'est pas connecté. Veuillez vous connecter d\'abord.' 
      });
    }

    // Récupérer tous les événements de l'utilisateur depuis Firestore
    const snapshot = await eventsCollection
      .where('userId', '==', req.userId)
      .get();

    // Initialiser les compteurs
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let errors = 0;

    // Synchroniser chaque événement
    const syncPromises = [];
    snapshot.forEach(doc => {
      const event = doc.data();
      const eventId = doc.id;
      
      if (event.googleEventId) {
        // Mettre à jour l'événement existant dans Google Calendar
        const updatePromise = updateGoogleCalendarEvent(req.userId, event.googleEventId, {
          title: event.title,
          start: event.start.toDate(),
          end: event.end.toDate(),
          description: event.description || ''
        }).then(() => {
          updated++;
        }).catch(error => {
          console.error(`[Calendar Events] Erreur lors de la mise à jour de l'événement Google Calendar ${event.googleEventId}:`, error);
          errors++;
        });
        
        syncPromises.push(updatePromise);
      } else {
        // Créer un nouvel événement dans Google Calendar
        const createPromise = createGoogleCalendarEvent(req.userId, {
          title: event.title,
          start: event.start.toDate(),
          end: event.end.toDate(),
          description: event.description || ''
        }).then(googleEvent => {
          if (googleEvent && googleEvent.id) {
            // Mettre à jour l'ID Google dans Firestore
            return eventsCollection.doc(eventId).update({
              googleEventId: googleEvent.id,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }).then(() => {
              created++;
            });
          }
        }).catch(error => {
          console.error(`[Calendar Events] Erreur lors de la création de l'événement Google Calendar pour ${eventId}:`, error);
          errors++;
        });
        
        syncPromises.push(createPromise);
      }
    });

    // Attendre que toutes les opérations soient terminées
    await Promise.all(syncPromises);
    
    console.log(`[Calendar Events] Synchronisation terminée pour l'utilisateur ${req.userId}:`, {
      created,
      updated,
      deleted,
      errors
    });
    
    // Mettre à jour l'état de synchronisation
    syncState.lastSync = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Synchronisation terminée',
      stats: {
        created,
        updated,
        deleted,
        errors
      }
    });
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la synchronisation avec Google Calendar:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation avec Google Calendar' });
  }
});

/**
 * Crée un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {Object} eventData - Données de l'événement
 * @returns {Promise<Object>} - Événement Google Calendar créé
 */
async function createGoogleCalendarEvent(userId, eventData) {
  const syncState = getUserSyncState(userId);
  
  if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
    throw new Error('Google Calendar n\'est pas connecté');
  }
  
  // Configurer les credentials pour cet utilisateur
  googleCalendarService.setCredentials(syncState.googleTokens);
  
  // Créer l'événement
  const calendar = google.calendar({ version: 'v3' });
  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: eventData.title,
      description: eventData.description,
      start: {
        dateTime: eventData.start.toISOString(),
        timeZone: 'Europe/Paris'
      },
      end: {
        dateTime: eventData.end.toISOString(),
        timeZone: 'Europe/Paris'
      }
    }
  });
  
  return response.data;
}

/**
 * Met à jour un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {string} googleEventId - ID de l'événement Google Calendar
 * @param {Object} eventData - Données de l'événement
 * @returns {Promise<Object>} - Événement Google Calendar mis à jour
 */
async function updateGoogleCalendarEvent(userId, googleEventId, eventData) {
  const syncState = getUserSyncState(userId);
  
  if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
    throw new Error('Google Calendar n\'est pas connecté');
  }
  
  // Configurer les credentials pour cet utilisateur
  googleCalendarService.setCredentials(syncState.googleTokens);
  
  // Mettre à jour l'événement
  const calendar = google.calendar({ version: 'v3' });
  const response = await calendar.events.update({
    calendarId: 'primary',
    eventId: googleEventId,
    requestBody: {
      summary: eventData.title,
      description: eventData.description,
      start: {
        dateTime: eventData.start.toISOString(),
        timeZone: 'Europe/Paris'
      },
      end: {
        dateTime: eventData.end.toISOString(),
        timeZone: 'Europe/Paris'
      }
    }
  });
  
  return response.data;
}

/**
 * Supprime un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {string} googleEventId - ID de l'événement Google Calendar
 * @returns {Promise<void>}
 */
async function deleteGoogleCalendarEvent(userId, googleEventId) {
  const syncState = getUserSyncState(userId);
  
  if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
    throw new Error('Google Calendar n\'est pas connecté');
  }
  
  // Configurer les credentials pour cet utilisateur
  googleCalendarService.setCredentials(syncState.googleTokens);
  
  // Supprimer l'événement
  const calendar = google.calendar({ version: 'v3' });
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: googleEventId
  });
}

/**
 * Récupère l'état de synchronisation d'un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @returns {Object|null} - État de synchronisation
 */
function getUserSyncState(userId) {
  // Réutiliser la fonction existante du module routes.googleSync
  if (typeof require('./routes.googleSync').getUserSyncState === 'function') {
    return require('./routes.googleSync').getUserSyncState(userId);
  }
  
  // Fallback si la fonction n'est pas disponible
  return null;
}

// Gérer les requêtes OPTIONS
router.options('*', (req, res) => {
  setCorsHeaders(req, res);
  res.sendStatus(200);
});

module.exports = router; 