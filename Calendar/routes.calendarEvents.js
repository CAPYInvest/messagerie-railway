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
const syncStatesCollection = db.collection('google_sync_states');

// Mapping des couleurs Google Calendar
const GOOGLE_COLORS = {
  '#7986cb': '1', // Lavender
  '#33b679': '2', // Sage
  '#8e24aa': '3', // Grape
  '#e67c73': '4', // Flamingo
  '#f6c026': '5', // Banana
  '#f5511d': '6', // Tangerine
  '#039be5': '7', // Peacock
  '#616161': '8', // Graphite
  '#3f51b5': '9', // Blueberry
  '#0b8043': '10', // Basil
  '#d60000': '11' // Tomato
};

// Fonction pour obtenir le colorId Google Calendar le plus proche
function getGoogleColorId(hexColor) {
  if (!hexColor) return '7'; // Peacock par défaut
  
  // Si la couleur est déjà dans le mapping
  if (GOOGLE_COLORS[hexColor.toLowerCase()]) {
    return GOOGLE_COLORS[hexColor.toLowerCase()];
  }
  
  // Sinon retourner la couleur par défaut
  return '7'; // Peacock
}

// Fonction pour obtenir la couleur hexadécimale depuis un colorId Google
function getHexColorFromGoogleId(colorId) {
  const colorMap = {
    '1': '#7986cb', // Lavender
    '2': '#33b679', // Sage
    '3': '#8e24aa', // Grape
    '4': '#e67c73', // Flamingo
    '5': '#f6c026', // Banana
    '6': '#f5511d', // Tangerine
    '7': '#039be5', // Peacock
    '8': '#616161', // Graphite
    '9': '#3f51b5', // Blueberry
    '10': '#0b8043', // Basil
    '11': '#d60000' // Tomato
  };
  
  return colorMap[colorId] || '#039be5'; // Peacock par défaut
}

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
      
      // Fonction pour convertir différents formats de date en ISO string
      const formatDate = (dateField) => {
        if (!dateField) return null;
        
        // Si c'est un timestamp Firestore
        if (dateField.toDate && typeof dateField.toDate === 'function') {
          return dateField.toDate().toISOString();
        }
        
        // Si c'est déjà une chaîne ISO
        if (typeof dateField === 'string') {
          return dateField;
        }
        
        // Si c'est un objet Date
        if (dateField instanceof Date) {
          return dateField.toISOString();
        }
        
        // Si c'est un timestamp en millisecondes
        if (typeof dateField === 'number') {
          return new Date(dateField).toISOString();
        }
        
        // Fallback
        return new Date().toISOString();
      };
      
      events.push({
        id: doc.id,
        title: event.title,
        start: formatDate(event.start),
        end: formatDate(event.end),
        description: event.description || '',
        location: event.location || '',
        googleEventId: event.googleEventId || null,
        color: event.color || '#039be5', // Couleur par défaut (bleu)
        type: event.type || 'event',
        allDay: event.allDay || false,
        recurringEventId: event.recurringEventId || null
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

    // Fonction pour convertir différents formats de date en ISO string
    const formatDate = (dateField) => {
      if (!dateField) return null;
      
      // Si c'est un timestamp Firestore
      if (dateField.toDate && typeof dateField.toDate === 'function') {
        return dateField.toDate().toISOString();
      }
      
      // Si c'est déjà une chaîne ISO
      if (typeof dateField === 'string') {
        return dateField;
      }
      
      // Si c'est un objet Date
      if (dateField instanceof Date) {
        return dateField.toISOString();
      }
      
      // Si c'est un timestamp en millisecondes
      if (typeof dateField === 'number') {
        return new Date(dateField).toISOString();
      }
      
      // Fallback
      return new Date().toISOString();
    };

    res.json({
      id: eventDoc.id,
      title: event.title,
      start: formatDate(event.start),
      end: formatDate(event.end),
      description: event.description || '',
      location: event.location || '',
      googleEventId: event.googleEventId || null,
      color: event.color || '#039be5', // Couleur par défaut (bleu)
      type: event.type || 'event',
      allDay: event.allDay || false,
      recurringEventId: event.recurringEventId || null
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

    const { title, start, end, description, color, type, allDay, location } = req.body;
    
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
      location: location || '',
      color: color || '#039be5',
      colorId: getGoogleColorId(color),
      type: type || 'event',
      allDay: allDay || false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Vérifier si l'utilisateur a connecté Google Calendar
    const syncState = await getUserSyncState(req.userId);
    
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
    const { title, start, end, description, color, type, allDay, location } = req.body;
    
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
    const updates = {
      title,
      start: admin.firestore.Timestamp.fromDate(startDate),
      end: admin.firestore.Timestamp.fromDate(endDate),
      description: description || '',
      location: location || '',
      color: color || '#039be5',
      colorId: getGoogleColorId(color),
      type: type || 'event',
      allDay: allDay || false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Mettre à jour dans Google Calendar si nécessaire
    if (existingEvent.googleEventId) {
      try {
        await updateGoogleCalendarEvent(req.userId, existingEvent.googleEventId, updates);
        console.log(`[Calendar Events] Événement Google Calendar mis à jour: ${existingEvent.googleEventId}`);
      } catch (googleError) {
        console.error('[Calendar Events] Erreur lors de la mise à jour dans Google Calendar:', googleError);
        // Continuer même en cas d'erreur avec Google Calendar
      }
    }

    // Mettre à jour dans Firestore
    await eventsCollection.doc(eventId).update(updates);
    
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
    // Vérifier l'état de synchronisation
    const syncState = await getUserSyncState(req.userId);
    if (!syncState || !syncState.isConnected) {
      return res.status(400).json({ error: 'Google Calendar n\'est pas connecté' });
    }

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let errors = 0;

    // Récupérer les événements de Google Calendar
    const calendar = google.calendar({ version: 'v3', auth: googleCalendarService.oauth2Client });
    const googleEvents = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 jours dans le passé
      timeMax: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 an dans le futur
      singleEvents: true,
      showDeleted: true // Important pour détecter les événements supprimés
    });

    // Créer un Set des IDs Google Calendar actifs
    const activeGoogleEventIds = new Set();

    // Traiter les événements Google Calendar
    for (const googleEvent of googleEvents.data.items) {
      if (!googleEvent.status || googleEvent.status === 'cancelled') {
        continue; // Ignorer les événements supprimés pour l'instant
      }
      activeGoogleEventIds.add(googleEvent.id);
    }

    // Récupérer tous les événements de Firestore
    const firestoreSnapshot = await eventsCollection
      .where('userId', '==', req.userId)
      .get();

    // Supprimer les événements qui n'existent plus dans Google Calendar
    const deletePromises = [];
    firestoreSnapshot.forEach(doc => {
      const event = doc.data();
      if (event.googleEventId && !activeGoogleEventIds.has(event.googleEventId)) {
        console.log(`[Calendar Events] Suppression de l'événement ${doc.id} car supprimé dans Google Calendar`);
        deletePromises.push(
          eventsCollection.doc(doc.id).delete()
            .then(() => {
              deleted++;
            })
            .catch(error => {
              console.error(`[Calendar Events] Erreur lors de la suppression de l'événement ${doc.id}:`, error);
              errors++;
            })
        );
      }
    });

    // Attendre que toutes les suppressions soient terminées
    await Promise.all(deletePromises);

    // Mettre à jour l'état de synchronisation
    await syncStatesCollection.doc(req.userId).update({
      lastSync: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

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
    console.error('[Calendar Events] Erreur lors de la synchronisation:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

/**
 * Crée un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {Object} eventData - Données de l'événement
 * @returns {Promise<Object>} - Événement Google Calendar créé
 */
async function createGoogleCalendarEvent(userId, eventData) {
  try {
    const syncState = await getUserSyncState(userId);
    if (!syncState || !syncState.isConnected) {
      console.log('[Calendar Events] Utilisateur non connecté à Google Calendar');
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth: googleCalendarService.oauth2Client });
    
    // Préparer les dates au format Google Calendar
    let start, end;
    
    if (eventData.allDay) {
      const startDate = new Date(eventData.start);
      const endDate = new Date(eventData.end);
      endDate.setDate(endDate.getDate() + 1);
      
      start = {
        date: startDate.toISOString().split('T')[0]
      };
      end = {
        date: endDate.toISOString().split('T')[0]
      };
    } else {
      start = {
        dateTime: new Date(eventData.start).toISOString(),
        timeZone: 'Europe/Paris'
      };
      end = {
        dateTime: new Date(eventData.end).toISOString(),
        timeZone: 'Europe/Paris'
      };
    }

    // Déterminer le colorId en fonction de la couleur hexadécimale
    const colorMap = {
      '#7986cb': '1', // Lavender
      '#33b679': '2', // Sage
      '#8e24aa': '3', // Grape
      '#e67c73': '4', // Flamingo
      '#f6c026': '5', // Banana
      '#f5511d': '6', // Tangerine
      '#039be5': '7', // Peacock
      '#616161': '8', // Graphite
      '#3f51b5': '9', // Blueberry
      '#0b8043': '10', // Basil
      '#d60000': '11' // Tomato
    };

    // Utiliser le colorId fourni ou le convertir depuis la couleur hexadécimale
    let colorId = eventData.colorId;
    if (!colorId && eventData.color) {
      colorId = colorMap[eventData.color.toLowerCase()] || '7';
    }

    // Ne pas ajouter [TASK] si ce n'est pas une tâche
    const description = eventData.type === 'task' 
      ? `[TASK] ${eventData.description || ''}`
      : eventData.description || '';

    console.log('[Calendar Events] Création événement Google Calendar:', {
      summary: eventData.title,
      description,
      location: eventData.location,
      start,
      end,
      colorId,
      type: eventData.type
    });

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: eventData.title,
        description,
        location: eventData.location || '',
        start,
        end,
        colorId: colorId || '7' // S'assurer que le colorId est toujours défini
      }
    });

    console.log(`[Calendar Events] Événement Google Calendar créé avec succès: ${response.data.id}`);
    return response.data;
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la création de l\'événement Google Calendar:', error);
    throw error;
  }
}

/**
 * Met à jour un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {string} googleEventId - ID de l'événement Google Calendar
 * @param {Object} eventData - Données de l'événement
 * @returns {Promise<Object>} - Événement Google Calendar mis à jour
 */
async function updateGoogleCalendarEvent(userId, googleEventId, eventData) {
  const syncState = await getUserSyncState(userId);
  
  if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
    throw new Error('Google Calendar n\'est pas connecté');
  }
  
  try {
    // Configurer les credentials pour cet utilisateur
    googleCalendarService.setCredentials(syncState.googleTokens);
    
    // Rafraîchir le token si nécessaire
    if (syncState.googleTokens.refresh_token) {
      try {
        console.log('[Calendar Events] Tentative de rafraîchissement du token pour mise à jour');
        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
        
        // Mettre à jour les tokens dans la mémoire
        syncState.googleTokens = {
          ...newTokens,
          refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
        };
        
        console.log('[Calendar Events] Token rafraîchi avec succès pour mise à jour');
        
        // Reconfigurer les credentials avec les nouveaux tokens
        googleCalendarService.setCredentials(syncState.googleTokens);
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token pour mise à jour:', refreshError);
      }
    }
    
    // Mettre à jour l'événement
    const calendar = google.calendar({ version: 'v3', auth: googleCalendarService.oauth2Client });
    
    // Préparer les dates au format Google Calendar
    let start, end;
    
    if (eventData.allDay) {
      // Pour les événements sur la journée entière, utiliser le format 'date'
      const startDate = new Date(eventData.start);
      const endDate = new Date(eventData.end);
      
      // Pour Google Calendar, les dates de fin sont exclusives pour les événements "all day"
      // Il faut donc ajouter un jour à la date de fin
      endDate.setDate(endDate.getDate() + 1);
      
      start = {
        date: startDate.toISOString().split('T')[0]
      };
      end = {
        date: endDate.toISOString().split('T')[0]
      };
    } else {
      // Pour les événements avec heure précise, utiliser le format 'dateTime'
      start = {
        dateTime: new Date(eventData.start).toISOString(),
        timeZone: 'Europe/Paris'
      };
      end = {
        dateTime: new Date(eventData.end).toISOString(),
        timeZone: 'Europe/Paris'
      };
    }
    
    // Déterminer le colorId basé sur la couleur de l'événement
    let colorId = eventData.colorId;
    if (!colorId && eventData.color) {
      // Map des couleurs hexadécimales vers les colorId de Google Calendar
      const colorMap = {
        '#7986cb': '1', // Lavender
        '#33b679': '2', // Sage
        '#8e24aa': '3', // Grape
        '#e67c73': '4', // Flamingo
        '#f6c026': '5', // Banana
        '#f5511d': '6', // Tangerine
        '#039be5': '7', // Peacock
        '#616161': '8', // Graphite
        '#3f51b5': '9', // Blueberry
        '#0b8043': '10', // Basil
        '#d60000': '11' // Tomato
      };
      
      colorId = colorMap[eventData.color.toLowerCase()] || '7';
    }
    
    // Préparer la description en fonction du type d'événement
    let description = eventData.description || '';
    if (eventData.type === 'task') {
      description = '[TASK] ' + description;
    }
    
    console.log('[Calendar Events] Tentative de mise à jour de l\'événement Google Calendar:', {
      calendarId: 'primary',
      eventId: googleEventId,
      title: eventData.title,
      start: eventData.allDay ? start.date : (start.dateTime || ''),
      end: eventData.allDay ? end.date : (end.dateTime || ''),
      colorId: colorId,
      type: eventData.type || 'event'
    });
    
    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: googleEventId,
      requestBody: {
        summary: eventData.title,
        description: description,
        location: eventData.location || '',
        start,
        end,
        colorId: colorId || '7' // S'assurer que le colorId est toujours défini
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la mise à jour de l\'événement Google Calendar:', error);
    
    // Si l'erreur est une erreur d'authentification (401), essayons de reconnecter l'utilisateur
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      console.error('[Calendar Events] Erreur d\'authentification 401 - Token expiré ou invalide');
      
      // Marquer l'utilisateur comme déconnecté pour forcer une reconnexion
      syncState.isConnected = false;
      
      // Si syncStatesCollection est défini, mettre à jour l'état dans Firestore
      try {
        await syncStatesCollection.doc(userId).update({
          isConnected: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (firestoreError) {
        console.error('[Calendar Events] Erreur lors de la mise à jour de l\'état dans Firestore:', firestoreError);
      }
    }
    
    throw error;
  }
}

/**
 * Supprime un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {string} googleEventId - ID de l'événement Google Calendar
 * @returns {Promise<void>}
 */
async function deleteGoogleCalendarEvent(userId, googleEventId) {
  const syncState = await getUserSyncState(userId);
  
  if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
    throw new Error('Google Calendar n\'est pas connecté');
  }
  
  try {
    // Configurer les credentials pour cet utilisateur
    googleCalendarService.setCredentials(syncState.googleTokens);
    
    // Rafraîchir le token si nécessaire
    if (syncState.googleTokens.refresh_token) {
      try {
        console.log('[Calendar Events] Tentative de rafraîchissement du token pour suppression');
        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
        
        // Mettre à jour les tokens dans la mémoire
        syncState.googleTokens = {
          ...newTokens,
          refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
        };
        
        console.log('[Calendar Events] Token rafraîchi avec succès pour suppression');
        
        // Reconfigurer les credentials avec les nouveaux tokens
        googleCalendarService.setCredentials(syncState.googleTokens);
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token pour suppression:', refreshError);
      }
    }
    
    // Supprimer l'événement
    const calendar = google.calendar({ version: 'v3', auth: googleCalendarService.oauth2Client });
    
    console.log(`[Calendar Events] Tentative de suppression de l'événement Google Calendar: ${googleEventId}`);
    
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: googleEventId
    });
    
    console.log(`[Calendar Events] Événement Google Calendar supprimé avec succès: ${googleEventId}`);
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la suppression dans Google Calendar:', error);
    
    // Si l'erreur est une erreur d'authentification (401), essayons de reconnecter l'utilisateur
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      console.error('[Calendar Events] Erreur d\'authentification 401 - Token expiré ou invalide');
      
      // Marquer l'utilisateur comme déconnecté pour forcer une reconnexion
      syncState.isConnected = false;
      
      // Si syncStatesCollection est défini, mettre à jour l'état dans Firestore
      try {
        const syncStatesCollection = admin.firestore().collection('google_sync_states');
        await syncStatesCollection.doc(userId).update({
          isConnected: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (firestoreError) {
        console.error('[Calendar Events] Erreur lors de la mise à jour de l\'état dans Firestore:', firestoreError);
      }
    }
    
    // Si l'erreur est "Not Found", on peut considérer que l'événement est déjà supprimé
    if (error.code === 404 || (error.response && error.response.status === 404)) {
      console.log(`[Calendar Events] L'événement Google Calendar ${googleEventId} n'existe pas ou a déjà été supprimé`);
      return; // Ne pas propager l'erreur
    }
    
    throw error;
  }
}

/**
 * Récupère l'état de synchronisation d'un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<Object|null>} - État de synchronisation
 */
async function getUserSyncState(userId) {
  // Réutiliser la fonction existante du module routes.googleSync
  if (typeof require('./routes.googleSync').getUserSyncState === 'function') {
    return await require('./routes.googleSync').getUserSyncState(userId);
  }
  
  // Fallback si la fonction n'est pas disponible
  return null;
}

// Gérer les requêtes OPTIONS
router.options('*', (req, res) => {
  setCorsHeaders(req, res);
  res.sendStatus(200);
});

// Exporter le router et les fonctions utiles
module.exports = { 
  router,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  getUserSyncState
}; 