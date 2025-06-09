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
// Ne pas importer getUserSyncState et saveSyncStateToFirestore directement pour éviter une dépendance circulaire
// const { getUserSyncState, saveSyncStateToFirestore } = require('./routes.googleSync');

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
router.post('/sync', requireAuth, syncCalendarRoute);

/**
 * Fonction de synchronisation du calendrier avec Google Calendar
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 */
async function syncCalendarRoute(req, res) {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }

    // Import dynamique pour éviter la dépendance circulaire
    const { getUserSyncState } = require('./routes.googleSync');
    
    // Vérifier si l'utilisateur a connecté Google Calendar
    const syncState = await getUserSyncState(req.userId);
    
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

    // NOUVEAU: Importer les événements de Google Calendar
    try {
      console.log(`[Calendar Events] Importation des événements depuis Google Calendar pour l'utilisateur ${req.userId}`);
      
      // Vérifier si l'utilisateur a connecté Google Calendar
      if (!syncState || !syncState.isConnected || !syncState.googleTokens) {
        return res.status(400).json({ 
          error: 'Google Calendar n\'est pas connecté. Veuillez vous connecter d\'abord.' 
        });
      }
      
      // Configurer les credentials pour cet utilisateur
      googleCalendarService.setCredentials(syncState.googleTokens);
      
      // AJOUT: Vérifier et rafraîchir le token si nécessaire
      try {
        if (syncState.googleTokens.refresh_token) {
          console.log('[Calendar Events] Tentative de rafraîchissement préventif du token');
          const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
          
          // Mettre à jour les tokens dans la mémoire
          syncState.googleTokens = {
            ...newTokens,
            refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
          };
          
          // Mettre à jour les tokens dans la base de données sans utiliser saveSyncStateToFirestore
          // Accéder directement à Firestore
          try {
            await admin.firestore().collection('google_sync_states').doc(req.userId).set({
              googleTokens: syncState.googleTokens,
              isConnected: syncState.isConnected,
              lastSync: syncState.lastSync,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('[Calendar Events] État de synchronisation sauvegardé dans Firestore pour l\'utilisateur', req.userId);
          } catch (firestoreError) {
            console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
          }
          
          console.log('[Calendar Events] Token rafraîchi avec succès');
          
          // Reconfigurer les credentials avec les nouveaux tokens
          googleCalendarService.setCredentials(syncState.googleTokens);
        } else {
          console.log('[Calendar Events] Pas de refresh_token disponible');
        }
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token:', refreshError);
        return res.status(401).json({ 
          error: 'Erreur d\'authentification Google Calendar. Veuillez vous reconnecter.' 
        });
      }
      
      // Récupérer les événements de Google Calendar
      const calendar = google.calendar({ version: 'v3', auth: googleCalendarService.oauth2Client });
      
      // Définir une période plus large pour les événements (3 ans avant et après)
      const now = new Date();
      const threeYearsAgo = new Date(now);
      threeYearsAgo.setFullYear(now.getFullYear() - 1);
      const threeYearsLater = new Date(now);
      threeYearsLater.setFullYear(now.getFullYear() + 3); // Étendre à 3 ans dans le futur pour capturer les événements de 2025
      
      console.log(`[Calendar Events] Récupération des événements Google Calendar entre ${threeYearsAgo.toISOString()} et ${threeYearsLater.toISOString()}`);
      
      // Récupérer d'abord la liste des calendriers disponibles
      const calListResponse = await calendar.calendarList.list();
      const calendars = calListResponse.data.items || [];
      console.log(`[Calendar Events] ${calendars.length} calendriers trouvés`);
      
      // Variable pour stocker les événements Google
      let googleEvents = [];
      let calendarIdToUse = 'primary';
      
      // Récupérer les événements du calendrier principal
      try {
        const response = await calendar.events.list({
          calendarId: calendarIdToUse,
          timeMin: threeYearsAgo.toISOString(),
          timeMax: threeYearsLater.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500 // Augmenter pour récupérer plus d'événements
        });
        
        googleEvents = response.data.items || [];
        console.log(`[Calendar Events] ${googleEvents.length} événements récupérés depuis le calendrier principal`);
        
        // Si aucun événement trouvé dans le calendrier principal, essayer les autres calendriers
        if (googleEvents.length === 0 && calendars.length > 1) {
          console.log(`[Calendar Events] Aucun événement trouvé dans le calendrier principal, essai avec d'autres calendriers`);
          
          for (const cal of calendars.filter(c => !c.primary).slice(0, 3)) {
            try {
              console.log(`[Calendar Events] Essai avec le calendrier: ${cal.summary} (${cal.id})`);
              
              const otherResponse = await calendar.events.list({
                calendarId: cal.id,
                timeMin: threeYearsAgo.toISOString(),
                timeMax: threeYearsLater.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 100
              });
              
              const calEvents = otherResponse.data.items || [];
              console.log(`[Calendar Events] ${calEvents.length} événements trouvés dans le calendrier ${cal.summary}`);
              
              if (calEvents.length > 0) {
                googleEvents = calEvents;
                calendarIdToUse = cal.id;
                break;
              }
            } catch (calError) {
              console.error(`[Calendar Events] Erreur avec le calendrier ${cal.id}:`, calError.message);
            }
          }
        }
      } catch (apiError) {
        console.error('[Calendar Events] Erreur API Google Calendar:', apiError);
        errors++;
      }
      
      console.log(`[Calendar Events] Total de ${googleEvents.length} événements récupérés pour l'importation`);
      
      // Récupérer tous les IDs d'événements Google déjà existants
      const existingGoogleIds = new Set();
      const eventsSnapshot = await eventsCollection
        .where('userId', '==', req.userId)
        .where('googleEventId', '!=', null)
        .get();
      
      eventsSnapshot.forEach(doc => {
        const event = doc.data();
        if (event.googleEventId) {
          existingGoogleIds.add(event.googleEventId);
        }
      });
      
      console.log(`[Calendar Events] ${existingGoogleIds.size} événements Google déjà importés`);
      
      // Traiter chaque événement Google
      console.log(`[Calendar Events] Début du traitement de ${googleEvents.length} événements Google Calendar`);
      
      let processedEvents = 0;
      const importPromises = googleEvents.map(async (googleEvent, index) => {
        try {
          processedEvents++;
          // Log de progression tous les 5 événements
          if (processedEvents % 5 === 0 || processedEvents === 1 || processedEvents === googleEvents.length) {
            console.log(`[Calendar Events] Progression de l'import: ${processedEvents}/${googleEvents.length} événements traités`);
          }
          
          // Vérifier si l'événement est déjà importé
          if (existingGoogleIds.has(googleEvent.id)) {
            console.log(`[Calendar Events] Événement ${index+1}/${googleEvents.length} déjà importé, ignoré: ${googleEvent.id} - ${googleEvent.summary || 'Sans titre'}`);
            return; // Événement déjà importé, ignorer
          }
          
          // Vérifier si l'événement a des dates valides
          if (!googleEvent.start || !googleEvent.end) {
            console.log(`[Calendar Events] Événement sans dates, ignoré: ${googleEvent.id} - ${googleEvent.summary || 'Sans titre'}`);
            return; // Ignorer les événements sans dates
          }
          
          // Convertir les dates
          let startDate, endDate;
          let isAllDay = false;
          
          // Traitement des dates de début
          if (googleEvent.start.dateTime) {
            // Événement avec heure précise
            startDate = new Date(googleEvent.start.dateTime);
            console.log(`[Calendar Events] Date de début avec heure: ${startDate.toISOString()}`);
          } else if (googleEvent.start.date) {
            // Événement sur la journée entière
            startDate = new Date(googleEvent.start.date);
            // Définir explicitement l'heure à 00:00:00 pour les événements sur une journée complète
            startDate.setHours(0, 0, 0, 0);
            isAllDay = true;
            console.log(`[Calendar Events] Date de début journée entière: ${startDate.toISOString()} (ajustée à minuit)`);
          } else {
            console.log(`[Calendar Events] Format de date de début invalide, ignoré: ${googleEvent.id} - ${googleEvent.summary || 'Sans titre'}`);
            return; // Ignorer si pas de date
          }
          
          // Traitement des dates de fin
          if (googleEvent.end.dateTime) {
            // Événement avec heure précise
            endDate = new Date(googleEvent.end.dateTime);
            console.log(`[Calendar Events] Date de fin avec heure: ${endDate.toISOString()}`);
          } else if (googleEvent.end.date) {
            // Événement sur la journée entière - ATTENTION: Dans Google Calendar,
            // la date de fin pour les événements "all day" est exclusive (le jour après)
            endDate = new Date(googleEvent.end.date);
            
            // Si c'est un événement toute la journée, la date de fin est exclusive
            // Nous la reculons d'un jour pour qu'elle soit inclusive
            if (isAllDay) {
              endDate.setDate(endDate.getDate() - 1);
              // Et nous la réglons à 23:59:59 pour couvrir toute la journée
              endDate.setHours(23, 59, 59, 999);
              console.log(`[Calendar Events] Date de fin journée entière ajustée: ${endDate.toISOString()} (réglée à 23:59:59)`);
            }
          } else {
            console.log(`[Calendar Events] Format de date de fin invalide, ignoré: ${googleEvent.id} - ${googleEvent.summary || 'Sans titre'}`);
            return; // Ignorer si pas de date
          }
          
          // Vérifier que les dates sont valides
          if (endDate < startDate) {
            console.log(`[Calendar Events] Date de fin avant la date de début, ignoré: ${googleEvent.id} - ${googleEvent.summary || 'Sans titre'}`);
            return; // Ignorer les événements avec des dates invalides
          }
          
          // Traitement couleur et type d'événement
          let color = '#039be5'; // Couleur par défaut pour les événements
          let eventType = 'event';
          
          // Vérifier s'il s'agit d'une tâche
          if (googleEvent.eventType === 'task' || 
              (googleEvent.summary && googleEvent.summary.toLowerCase().includes('[task]')) ||
              (googleEvent.description && googleEvent.description.toLowerCase().includes('[task]'))) {
            eventType = 'task';
            color = '#616161'; // Gris pour les tâches par défaut
          }
          
          // Récupérer la couleur depuis Google Calendar si disponible
          if (googleEvent.colorId) {
            // Mapping des couleurs Google Calendar (https://developers.google.com/calendar/api/v3/reference/colors/get)
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
            
            color = colorMap[googleEvent.colorId] || color;
            console.log(`[Calendar Events] Couleur Google Calendar trouvée: ${color} (ID: ${googleEvent.colorId})`);
          }
          
          // Créer l'événement dans la base de données
          const calendarEvent = {
            userId: req.userId,
            title: googleEvent.summary || 'Sans titre',
            description: googleEvent.description || '',
            location: googleEvent.location || '',
            start: startDate,
            end: endDate,
            allDay: isAllDay,
            googleEventId: googleEvent.id,
            color: color,
            type: eventType,
            lastSync: new Date(),
            recurringEventId: googleEvent.recurringEventId || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          };
          
          // Enregistrer l'événement dans Firestore
          const docRef = await eventsCollection.add(calendarEvent);
          console.log(`[Calendar Events] Événement Google importé avec succès: ${docRef.id} pour utilisateur ${req.userId}`);
          created++;
        } catch (error) {
          console.error(`[Calendar Events] Erreur lors de l'importation d'un événement Google:`, error);
          errors++;
        }
      });
      
      // Une fois terminé l'import, vérifier les événements supprimés dans Google
      console.log(`[Calendar Events] Vérification des événements supprimés dans Google Calendar`);
      
      // Créer un ensemble des IDs Google actuels
      const currentGoogleIds = new Set();
      googleEvents.forEach(event => {
        if (event.id) {
          currentGoogleIds.add(event.id);
        }
      });
      
      // Récupérer tous les événements avec googleEventId
      const eventsWithGoogleId = await eventsCollection
        .where('userId', '==', req.userId)
        .where('googleEventId', '!=', null)
        .get();
      
      // Vérifier quels événements ont été supprimés sur Google
      const deletionPromises = [];
      let deletedCount = 0;
      
      eventsWithGoogleId.forEach(doc => {
        const event = doc.data();
        // Si l'événement existe en local avec un googleEventId mais n'existe plus dans Google
        if (event.googleEventId && !currentGoogleIds.has(event.googleEventId)) {
          console.log(`[Calendar Events] Événement supprimé dans Google Calendar détecté: ${doc.id} (Google ID: ${event.googleEventId})`);
          // Supprimer l'événement localement
          const deletePromise = eventsCollection.doc(doc.id).delete()
            .then(() => {
              console.log(`[Calendar Events] Événement ${doc.id} supprimé localement`);
              deletedCount++;
            })
            .catch(error => {
              console.error(`[Calendar Events] Erreur lors de la suppression locale de l'événement ${doc.id}:`, error);
              errors++;
            });
          
          deletionPromises.push(deletePromise);
        }
      });
      
      await Promise.all(deletionPromises);
      console.log(`[Calendar Events] ${deletedCount} événements supprimés suite à la synchronisation`);

      // Attendre que toutes les importations soient terminées
      await Promise.all(importPromises);
      console.log(`[Calendar Events] Importation terminée: ${created} événements importés`);
    } catch (importError) {
      console.error(`[Calendar Events] Erreur lors de l'importation depuis Google Calendar:`, importError);
      errors++;
    }

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
}

/**
 * Crée un événement dans Google Calendar
 * @param {string} userId - ID de l'utilisateur
 * @param {Object} eventData - Données de l'événement
 * @returns {Promise<Object>} - Événement Google Calendar créé
 */
async function createGoogleCalendarEvent(userId, eventData) {
  // Import dynamique pour éviter la dépendance circulaire
  // Utiliser une approche différente pour éviter l'erreur TypeError
  const googleSyncModule = require('./routes.googleSync');
  const getUserSyncState = googleSyncModule.getUserSyncState;
  
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
        console.log('[Calendar Events] Tentative de rafraîchissement préventif du token');
        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
        
        // Mettre à jour les tokens dans la mémoire
        syncState.googleTokens = {
          ...newTokens,
          refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
        };
        
        // Mettre à jour les tokens dans la base de données sans utiliser saveSyncStateToFirestore
        // Accéder directement à Firestore
        try {
          await admin.firestore().collection('google_sync_states').doc(userId).set({
            googleTokens: syncState.googleTokens,
            isConnected: syncState.isConnected,
            lastSync: syncState.lastSync,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log('[Calendar Events] État de synchronisation sauvegardé dans Firestore pour l\'utilisateur', userId);
        } catch (firestoreError) {
          console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
        }
        
        console.log('[Calendar Events] Token rafraîchi avec succès');
        
        // Reconfigurer les credentials avec les nouveaux tokens
        googleCalendarService.setCredentials(syncState.googleTokens);
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token:', refreshError);
        // On continue malgré l'erreur, car le token actuel pourrait encore être valide
      }
    }
    
    // Créer le client Google Calendar
    const calendar = google.calendar({version: 'v3', auth: googleCalendarService});
    
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
        dateTime: new Date(eventData.start).toISOString()
      };
      end = {
        dateTime: new Date(eventData.end).toISOString()
      };
    }
    
    // Déterminer le colorId basé sur la couleur de l'événement
    let colorId = null;
    if (eventData.color) {
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
      
      colorId = colorMap[eventData.color];
      console.log(`[Calendar Events] Utilisation de la couleur ${eventData.color} => colorId ${colorId}`);
    }
    
    // Préparer l'événement Google Calendar
    const googleEvent = {
      summary: eventData.title,
      description: eventData.type === 'task' ? '[TASK] ' + (eventData.description || '') : eventData.description,
      location: eventData.location,
      start,
      end,
      colorId
    };
    
    console.log(`[Calendar Events] Tentative de création de l'événement Google Calendar pour ${eventData.id}:`, {
      summary: googleEvent.summary,
      start: googleEvent.start,
      end: googleEvent.end,
      authStatus: syncState.isConnected ? 'Authentifié' : 'Non authentifié'
    });
    
    // Créer l'événement
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: googleEvent
    });
    
    console.log(`[Calendar Events] Événement Google Calendar créé avec succès, ID: ${response.data.id}`);
    return response.data;
  } catch (error) {
    console.error(`[Calendar Events] Erreur lors de la création de l'événement Google Calendar pour ${eventData.id}:`, error);
    
    // Si l'erreur est une erreur d'authentification (401), essayons de reconnecter l'utilisateur
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      console.error('[Calendar Events] Erreur d\'authentification 401 - Token expiré ou invalide');
      
      // Marquer l'utilisateur comme déconnecté pour forcer une reconnexion
      syncState.isConnected = false;
      
      // Sauvegarder directement dans Firestore
      try {
        await admin.firestore().collection('google_sync_states').doc(userId).set({
          isConnected: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (firestoreError) {
        console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
      }
    }
    
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
  // Import dynamique pour éviter la dépendance circulaire
  // Utiliser une approche différente pour éviter l'erreur TypeError
  const googleSyncModule = require('./routes.googleSync');
  const getUserSyncState = googleSyncModule.getUserSyncState;
  
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
        console.log('[Calendar Events] Tentative de rafraîchissement préventif du token pour mise à jour');
        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
        
        // Mettre à jour les tokens dans la mémoire
        syncState.googleTokens = {
          ...newTokens,
          refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
        };
        
        // Mettre à jour les tokens dans la base de données sans utiliser saveSyncStateToFirestore
        // Accéder directement à Firestore
        try {
          await admin.firestore().collection('google_sync_states').doc(userId).set({
            googleTokens: syncState.googleTokens,
            isConnected: syncState.isConnected,
            lastSync: syncState.lastSync,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log('[Calendar Events] État de synchronisation sauvegardé dans Firestore pour l\'utilisateur', userId);
        } catch (firestoreError) {
          console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
        }
        
        console.log('[Calendar Events] Token rafraîchi avec succès pour mise à jour');
        
        // Reconfigurer les credentials avec les nouveaux tokens
        googleCalendarService.setCredentials(syncState.googleTokens);
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token pour mise à jour:', refreshError);
      }
    }
    
    // Mettre à jour l'événement - utiliser l'instance oauth2Client de googleCalendarService
    const calendar = google.calendar({ 
      version: 'v3', 
      auth: googleCalendarService.oauth2Client 
    });
    
    console.log('[Calendar Events] Tentative de mise à jour de l\'événement Google Calendar:', {
      calendarId: 'primary',
      eventId: googleEventId,
      title: eventData.title,
      authStatus: googleCalendarService.oauth2Client.credentials ? 'Authentifié' : 'Non authentifié'
    });
    
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
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la mise à jour de l\'événement Google Calendar:', error);
    
    // Si l'erreur est une erreur d'authentification (401), essayons de reconnecter l'utilisateur
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      console.error('[Calendar Events] Erreur d\'authentification 401 - Token expiré ou invalide');
      
      // Marquer l'utilisateur comme déconnecté pour forcer une reconnexion
      syncState.isConnected = false;
      
      // Sauvegarder directement dans Firestore
      try {
        await admin.firestore().collection('google_sync_states').doc(userId).set({
          isConnected: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (firestoreError) {
        console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
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
  // Import dynamique pour éviter la dépendance circulaire
  // Utiliser une approche différente pour éviter l'erreur TypeError
  const googleSyncModule = require('./routes.googleSync');
  const getUserSyncState = googleSyncModule.getUserSyncState;
  
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
        console.log('[Calendar Events] Tentative de rafraîchissement préventif du token pour suppression');
        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
        
        // Mettre à jour les tokens dans la mémoire
        syncState.googleTokens = {
          ...newTokens,
          refresh_token: syncState.googleTokens.refresh_token // Préserver le refresh_token
        };
        
        // Mettre à jour les tokens dans la base de données sans utiliser saveSyncStateToFirestore
        // Accéder directement à Firestore
        try {
          await admin.firestore().collection('google_sync_states').doc(userId).set({
            googleTokens: syncState.googleTokens,
            isConnected: syncState.isConnected,
            lastSync: syncState.lastSync,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log('[Calendar Events] État de synchronisation sauvegardé dans Firestore pour l\'utilisateur', userId);
        } catch (firestoreError) {
          console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
        }
        
        console.log('[Calendar Events] Token rafraîchi avec succès pour suppression');
        
        // Reconfigurer les credentials avec les nouveaux tokens
        googleCalendarService.setCredentials(syncState.googleTokens);
      } catch (refreshError) {
        console.error('[Calendar Events] Erreur lors du rafraîchissement du token pour suppression:', refreshError);
      }
    }
  
    // Supprimer l'événement - utiliser l'instance oauth2Client de googleCalendarService
    const calendar = google.calendar({ 
      version: 'v3', 
      auth: googleCalendarService.oauth2Client 
    });
    
    console.log('[Calendar Events] Tentative de suppression de l\'événement Google Calendar:', {
      calendarId: 'primary',
      eventId: googleEventId,
      authStatus: googleCalendarService.oauth2Client.credentials ? 'Authentifié' : 'Non authentifié'
    });
    
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: googleEventId
    });
    
    console.log(`[Calendar Events] Événement Google Calendar ${googleEventId} supprimé avec succès`);
  } catch (error) {
    console.error('[Calendar Events] Erreur lors de la suppression de l\'événement Google Calendar:', error);
    
    // Si l'erreur est une erreur d'authentification (401), essayons de reconnecter l'utilisateur
    if (error.code === 401 || (error.response && error.response.status === 401)) {
      console.error('[Calendar Events] Erreur d\'authentification 401 - Token expiré ou invalide');
      
      // Marquer l'utilisateur comme déconnecté pour forcer une reconnexion
      syncState.isConnected = false;
      
      // Sauvegarder directement dans Firestore
      try {
        await admin.firestore().collection('google_sync_states').doc(userId).set({
          isConnected: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (firestoreError) {
        console.error('[Calendar Events] Erreur lors de la sauvegarde dans Firestore:', firestoreError);
      }
    }
    
    throw error;
  }
}

// Gérer les requêtes OPTIONS
router.options('*', (req, res) => {
  setCorsHeaders(req, res);
  res.sendStatus(200);
});

// Exporter à la fois le routeur et la fonction de synchronisation
module.exports = {
  router,
  syncCalendarRoute
}; 