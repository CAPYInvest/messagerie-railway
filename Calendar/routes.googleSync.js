/**
 * Routes de synchronisation Google Calendar
 * @module routes/googleSync
 */

const express = require('express');
const router = express.Router();
const googleCalendarService = require('./googleCalendar');
const { requireAuth } = require('../middlewareauth');
// Utiliser l'instance Firebase Admin déjà initialisée dans server.js
const admin = require('firebase-admin');

// État de synchronisation en mémoire par utilisateur
const userSyncStates = new Map();

// Collection Firestore pour stocker les états de synchronisation
const syncStatesCollection = admin.firestore().collection('google_sync_states');

// Fonction pour obtenir ou créer l'état de synchronisation d'un utilisateur
async function getUserSyncState(userId) {
    if (!userSyncStates.has(userId)) {
        // Essayer d'abord de charger depuis Firestore
        try {
            const syncDoc = await syncStatesCollection.doc(userId).get();
            
            if (syncDoc.exists) {
                const firestoreState = syncDoc.data();
                console.log(`[Google Sync] État de synchronisation chargé depuis Firestore pour l'utilisateur ${userId}`);
                
                // Créer un état en mémoire avec les données de Firestore
                userSyncStates.set(userId, {
                    isSyncing: false, // Toujours réinitialiser à false lors du chargement
                    progress: 0,
                    lastError: firestoreState.lastError || null,
                    googleTokens: firestoreState.googleTokens || null,
                    isConnected: firestoreState.isConnected || false,
                    lastSync: firestoreState.lastSync || null
                });
            } else {
                // Créer un nouvel état par défaut
                console.log(`[Google Sync] Nouvel état de synchronisation créé pour l'utilisateur ${userId}`);
                userSyncStates.set(userId, {
                    isSyncing: false,
                    progress: 0,
                    lastError: null,
                    googleTokens: null,
                    isConnected: false,
                    lastSync: null
                });
                
                // Persister dans Firestore
                await saveSyncStateToFirestore(userId);
            }
        } catch (error) {
            console.error(`[Google Sync] Erreur lors du chargement de l'état de synchronisation:`, error);
            // Créer un nouvel état par défaut en cas d'erreur
            userSyncStates.set(userId, {
                isSyncing: false,
                progress: 0,
                lastError: null,
                googleTokens: null,
                isConnected: false,
                lastSync: null
            });
        }
    }
    
    return userSyncStates.get(userId);
}

// Fonction pour sauvegarder l'état de synchronisation dans Firestore
async function saveSyncStateToFirestore(userId) {
    try {
        if (!userId || !userSyncStates.has(userId)) {
            console.error(`[Google Sync] Impossible de sauvegarder l'état: userId invalide ou état non trouvé`);
            return;
        }
        
        const syncState = userSyncStates.get(userId);
        
        // Ne pas stocker l'état "isSyncing" dans Firestore car il est temporaire
        const stateToSave = {
            lastError: syncState.lastError,
            googleTokens: syncState.googleTokens,
            isConnected: syncState.isConnected,
            lastSync: syncState.lastSync,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        console.log(`[Google Sync] Sauvegarde de l'état dans Firestore pour l'utilisateur ${userId}:`, {
            isConnected: stateToSave.isConnected,
            hasTokens: stateToSave.googleTokens ? 'Oui' : 'Non',
            lastSync: stateToSave.lastSync
        });
        
        await syncStatesCollection.doc(userId).set(stateToSave, { merge: true });
        console.log(`[Google Sync] État de synchronisation sauvegardé dans Firestore pour l'utilisateur ${userId}`);
    } catch (error) {
        console.error(`[Google Sync] Erreur lors de la sauvegarde de l'état:`, error);
    }
}

// Fonction pour configurer les en-têtes CORS
function setCorsHeaders(req, res) {
  const origin = req.headers.origin || 'https://capy-invest-fr.webflow.io';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Origin, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
}

// Middleware temporaire pour le débogage
const debugMiddleware = (req, res, next) => {
    console.log('[Google Sync Debug] Requête reçue:', req.method, req.path);
    console.log('[Google Sync Debug] Headers:', req.headers);
    console.log('[Google Sync Debug] Body:', req.body);
    
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
                console.log('[Google Sync] ID utilisateur extrait:', req.userId);
            }
        }
        next();
    } catch (error) {
        console.error('[Google Sync] Erreur lors de l\'extraction de l\'ID utilisateur:', error);
        next();
    }
};

// Appliquer les middlewares
router.use(debugMiddleware);
router.use(extractUserIdMiddleware);

// Fonction pour simuler la progression de la synchronisation
function simulateProgress(userId) {
    const syncState = getUserSyncState(userId);
    let currentProgress = 0;
    
    // Réinitialiser l'état
    syncState.isSyncing = true;
    syncState.progress = 0;
    syncState.lastError = null;
    
    // Créer un intervalle pour mettre à jour la progression
    const progressInterval = setInterval(() => {
        currentProgress += 10;
        if (currentProgress > 100) {
            clearInterval(progressInterval);
            syncState.isSyncing = false;
            syncState.progress = 100;
            syncState.lastSync = new Date().toISOString();
            console.log(`[Google Sync] Synchronisation terminée pour l'utilisateur ${userId}`);
            return;
        }
        
        syncState.progress = currentProgress;
        console.log(`[Google Sync] Progression de la synchronisation pour l'utilisateur ${userId}: ${currentProgress}%`);
    }, 1000); // Mettre à jour toutes les secondes
    
    return progressInterval;
}

/**
 * Route de callback pour l'authentification Google
 */
router.post('/callback', async (req, res) => {
    try {
        console.log('[Google Sync] Réception du callback Google');
        
        // Vérifier si l'ID utilisateur est disponible
        if (!req.userId) {
            console.error('[Google Sync] ID utilisateur manquant');
            return res.status(401).json({ error: 'Authentification requise' });
        }

        const { code } = req.body;
        if (!code) {
            console.error('[Google Sync] Code d\'autorisation manquant');
            return res.status(400).json({ error: 'Code d\'autorisation manquant' });
        }

        console.log('[Google Sync] Code reçu:', code);
        const syncState = await getUserSyncState(req.userId);

        // Réinitialiser l'état de synchronisation
        syncState.isSyncing = false;
        syncState.progress = 0;
        syncState.lastError = null;

        try {
            console.log(`[Google Sync] Tentative d'échange du code`);
            const tokens = await googleCalendarService.getTokens(code);
            
            console.log('[Google Sync] Tokens reçus avec succès');

            // Stockage des tokens pour cet utilisateur
            syncState.googleTokens = tokens;
            syncState.isConnected = true;
            
            // Persister les tokens dans Firestore
            await saveSyncStateToFirestore(req.userId);
            
            // Démarrer la simulation de progression
            simulateProgress(req.userId);

            return res.json({ success: true, message: 'Authentification réussie' });
        } catch (error) {
            console.error(`[Google Sync] Erreur lors de l'échange du code:`, error.message);
            
            // Si l'erreur est "invalid_grant", retourner un message d'erreur convivial
            if (error.message && error.message.includes('invalid_grant')) {
                console.log('[Google Sync] Code expiré ou déjà utilisé');
                
                // Vérifier si l'utilisateur est peut-être déjà connecté
                // Cette vérification est approximative - dans un système de production,
                // vous devriez stocker l'état de connexion dans la base de données
                if (syncState.isConnected) {
                    return res.json({ 
                        success: true, 
                        alreadyConnected: true,
                        message: 'Votre compte Google Calendar semble déjà être connecté.' 
                    });
                }
                
                return res.status(400).json({ 
                    error: 'Code d\'autorisation expiré ou déjà utilisé', 
                    message: 'Veuillez réessayer la synchronisation en cliquant à nouveau sur le bouton de connexion Google Calendar.',
                    needsReauthorization: true
                });
            }
            
            // Pour les autres erreurs
            syncState.lastError = error.message;
            return res.status(500).json({ 
                error: 'Erreur lors de la synchronisation', 
                message: 'Une erreur s\'est produite lors de la connexion à Google Calendar. Veuillez réessayer.' 
            });
        }
    } catch (error) {
        console.error('[Google Sync] Erreur générale lors du callback:', error);
        return res.status(500).json({ 
            error: 'Erreur serveur', 
            message: 'Une erreur interne s\'est produite. Veuillez réessayer ultérieurement.' 
        });
    }
});

/**
 * Route pour démarrer la synchronisation
 */
router.post('/sync', async (req, res) => {
    try {
        // Vérifier si l'ID utilisateur est disponible
        if (!req.userId) {
            console.error('[Google Sync] ID utilisateur manquant');
            return res.status(401).json({ error: 'Authentification requise' });
        }

        const syncState = await getUserSyncState(req.userId);
        
        // Si le compte est déjà connecté et synchronisé, retourner un message spécifique
        if (syncState.isConnected && syncState.lastSync && !syncState.isSyncing) {
            const lastSyncDate = new Date(syncState.lastSync);
            const formattedDate = lastSyncDate.toLocaleString('fr-FR');
            return res.json({ 
                success: true, 
                alreadySynced: true,
                message: `Votre compte Google Calendar est déjà connecté. Dernière synchronisation: ${formattedDate}`,
                lastSync: syncState.lastSync
            });
        }
        
        // Réinitialiser l'état si la synchronisation est bloquée depuis plus de 5 minutes
        if (syncState.isSyncing) {
            const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
            if (syncState.syncStartedAt && syncState.syncStartedAt < fiveMinutesAgo) {
                console.log('[Google Sync] Réinitialisation d\'une synchronisation bloquée');
                syncState.isSyncing = false;
            } else {
                return res.status(400).json({ error: 'Une synchronisation est déjà en cours' });
            }
        }

        // Si nous n'avons pas de tokens, rediriger vers l'authentification
        if (!syncState.googleTokens) {
            console.log('[Google Sync] Génération de l\'URL d\'authentification');
            const authUrl = googleCalendarService.getAuthUrl();
            return res.json({ authUrl });
        }

        try {
            // Configurer les credentials pour cet utilisateur
            googleCalendarService.setCredentials(syncState.googleTokens);
            
            // Démarrer la simulation de progression
            syncState.syncStartedAt = Date.now();
            simulateProgress(req.userId);

            res.json({ success: true, message: 'Synchronisation démarrée' });
        } catch (error) {
            console.error('[Google Sync] Erreur avec les tokens:', error);
            
            // Si les tokens sont invalides, rediriger vers l'authentification
            console.log('[Google Sync] Tokens invalides, génération d\'une nouvelle URL d\'authentification');
            syncState.googleTokens = null;
            syncState.isConnected = false;
            
            // Sauvegarder l'état mis à jour dans Firestore
            await saveSyncStateToFirestore(req.userId);
            
            const authUrl = googleCalendarService.getAuthUrl();
            return res.json({ authUrl });
        }
    } catch (error) {
        console.error('[Google Sync] Erreur lors du démarrage de la synchronisation:', error);
        if (req.userId) {
            const syncState = await getUserSyncState(req.userId);
            syncState.lastError = error.message;
            syncState.isSyncing = false;
            await saveSyncStateToFirestore(req.userId);
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * Route pour vérifier le statut de synchronisation
 * GET /api/google/sync/status
 */
router.get('/status', requireAuth, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Authentification requise' });
        }

        // Récupérer l'état de synchronisation de l'utilisateur
        const syncState = await getUserSyncState(req.userId);
        
        // Si l'utilisateur est connecté mais que le token d'accès est expiré, essayer de le rafraîchir
        if (syncState.isConnected && syncState.googleTokens) {
            try {
                const tokenInfo = await googleCalendarService.verifyToken(syncState.googleTokens.access_token);
                console.log('[Google Sync] Token vérifié:', tokenInfo);
            } catch (tokenError) {
                console.log('[Google Sync] Le token d\'accès est peut-être expiré, tentative de rafraîchissement');
                try {
                    if (syncState.googleTokens.refresh_token) {
                        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
                        syncState.googleTokens = { 
                            ...newTokens, 
                            refresh_token: syncState.googleTokens.refresh_token
                        };
                        console.log('[Google Sync] Token rafraîchi avec succès');
                        
                        // Sauvegarder les nouveaux tokens dans Firestore
                        await saveSyncStateToFirestore(req.userId);
                    } else {
                        console.error('[Google Sync] Pas de refresh_token disponible');
                        syncState.isConnected = false;
                        await saveSyncStateToFirestore(req.userId);
                    }
                } catch (refreshError) {
                    console.error('[Google Sync] Erreur lors du rafraîchissement du token:', refreshError);
                    syncState.isConnected = false;
                    await saveSyncStateToFirestore(req.userId);
                }
            }
        }
        
        // Générer l'URL d'authentification si l'utilisateur n'est pas connecté
        let authUrl = null;
        if (!syncState.isConnected) {
            authUrl = googleCalendarService.getAuthUrl();
        }

        // Retourner l'état actuel
        res.json({
            isConnected: syncState.isConnected,
            isSyncing: syncState.isSyncing,
            progress: syncState.progress,
            lastSync: syncState.lastSync,
            lastError: syncState.lastError,
            authUrl: authUrl
        });
    } catch (error) {
        console.error('[Google Sync] Erreur lors de la vérification du statut:', error);
        res.status(500).json({ error: 'Erreur lors de la vérification du statut' });
    }
});

/**
 * Route pour déconnecter Google Calendar
 */
router.post('/disconnect', async (req, res) => {
    console.log('[Google Sync] Demande de déconnexion Google Calendar');
    
    // Vérifier si l'ID utilisateur est disponible
    if (!req.userId) {
        console.error('[Google Sync] ID utilisateur manquant');
        return res.status(401).json({ error: 'Authentification requise' });
    }
    
    const syncState = await getUserSyncState(req.userId);
    
    // Réinitialiser l'état de synchronisation
    syncState.googleTokens = null;
    syncState.isConnected = false;
    syncState.lastSync = null;
    syncState.isSyncing = false;
    syncState.progress = 0;
    syncState.lastError = null;
    
    // Sauvegarder l'état mis à jour dans Firestore
    await saveSyncStateToFirestore(req.userId);
    
    console.log(`[Google Sync] Compte Google Calendar déconnecté pour l'utilisateur ${req.userId}`);
    
    res.json({ success: true, message: 'Compte Google Calendar déconnecté avec succès' });
});

/**
 * Route pour obtenir l'URL d'authentification Google
 * GET /api/google/sync/auth
 */
router.get('/auth', requireAuth, (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Authentification requise' });
        }

        // Générer l'URL d'authentification Google
        const authUrl = googleCalendarService.getAuthUrl();
        
        // Rediriger l'utilisateur vers l'URL d'authentification
        res.redirect(authUrl);
    } catch (error) {
        console.error('[Google Sync] Erreur lors de la génération de l\'URL d\'authentification:', error);
        res.status(500).json({ error: 'Erreur lors de la génération de l\'URL d\'authentification' });
    }
});

/**
 * Route pour effectuer une synchronisation complète du calendrier
 * POST /api/google/sync/calendar
 */
router.post('/calendar', requireAuth, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Authentification requise' });
        }

        console.log(`[Google Sync] Démarrage de la synchronisation complète du calendrier pour l'utilisateur ${req.userId}`);
        
        // Récupérer l'état de synchronisation de l'utilisateur
        const syncState = await getUserSyncState(req.userId);
        
        // Vérifier si l'utilisateur est connecté à Google Calendar
        if (!syncState.isConnected || !syncState.googleTokens) {
            console.error('[Google Sync] Utilisateur non connecté à Google Calendar');
            return res.status(400).json({ 
                error: 'Google Calendar non connecté',
                message: 'Veuillez d\'abord connecter votre compte Google Calendar'
            });
        }
        
        try {
            // Configurer les credentials pour cet utilisateur
            googleCalendarService.setCredentials(syncState.googleTokens);
            
            // Récupérer les événements de Firestore
            const eventsCollection = admin.firestore().collection('calendar_events');
            const firestoreEvents = await eventsCollection.where('userId', '==', req.userId).get();
            
            console.log(`[Google Sync] ${firestoreEvents.size} événements trouvés dans Firestore`);
            
            // Récupérer les événements de Google Calendar (30 jours avant et après aujourd'hui)
            const today = new Date();
            const thirtyDaysAgo = new Date(today);
            thirtyDaysAgo.setDate(today.getDate() - 30);
            const thirtyDaysLater = new Date(today);
            thirtyDaysLater.setDate(today.getDate() + 30);
            
            const googleEvents = await googleCalendarService.listEvents(
                'primary',
                thirtyDaysAgo,
                thirtyDaysLater
            );
            
            console.log(`[Google Sync] ${googleEvents.length} événements trouvés dans Google Calendar`);
            
            // Statistiques de synchronisation
            const stats = {
                created: 0,
                updated: 0,
                deleted: 0,
                errors: 0
            };
            
            // Mapper les événements Google par ID pour faciliter la recherche
            const googleEventsMap = new Map();
            googleEvents.forEach(event => {
                googleEventsMap.set(event.id, event);
            });
            
            // Synchroniser les événements Firestore vers Google (création/mise à jour)
            for (const doc of firestoreEvents.docs) {
                const eventData = doc.data();
                
                try {
                    // Si l'événement a déjà un ID Google Calendar, le mettre à jour
                    if (eventData.googleEventId) {
                        // Vérifier si l'événement existe toujours dans Google Calendar
                        if (googleEventsMap.has(eventData.googleEventId)) {
                            // Mettre à jour l'événement dans Google Calendar
                            const { router: calendarEventsRouter } = require('./routes.calendarEvents');
                            await calendarEventsRouter.updateGoogleCalendarEvent(
                                req.userId,
                                eventData.googleEventId,
                                eventData
                            );
                            stats.updated++;
                            
                            // Retirer l'événement de la map pour marquer qu'il a été traité
                            googleEventsMap.delete(eventData.googleEventId);
                        } else {
                            // L'événement a été supprimé de Google Calendar, mettre à jour l'entrée Firestore
                            await eventsCollection.doc(doc.id).update({
                                googleEventId: null,
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    } else {
                        // Créer un nouvel événement dans Google Calendar
                        const { router: calendarEventsRouter } = require('./routes.calendarEvents');
                        const googleEvent = await calendarEventsRouter.createGoogleCalendarEvent(
                            req.userId,
                            eventData
                        );
                        
                        // Mettre à jour l'ID Google Calendar dans Firestore
                        await eventsCollection.doc(doc.id).update({
                            googleEventId: googleEvent.id,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        stats.created++;
                    }
                } catch (eventError) {
                    console.error(`[Google Sync] Erreur lors de la synchronisation de l'événement ${doc.id}:`, eventError);
                    stats.errors++;
                }
            }
            
            // Mettre à jour l'état de synchronisation
            syncState.lastSync = new Date().toISOString();
            syncState.isSyncing = false;
            await saveSyncStateToFirestore(req.userId);
            
            console.log(`[Google Sync] Synchronisation terminée avec succès: ${stats.created} créés, ${stats.updated} mis à jour, ${stats.errors} erreurs`);
            
            res.json({
                success: true,
                message: 'Synchronisation terminée avec succès',
                stats
            });
        } catch (error) {
            console.error('[Google Sync] Erreur lors de la synchronisation du calendrier:', error);
            
            // Si l'erreur est une erreur d'authentification, essayer de rafraîchir le token
            if (error.code === 401 || (error.response && error.response.status === 401)) {
                try {
                    if (syncState.googleTokens.refresh_token) {
                        const newTokens = await googleCalendarService.refreshToken(syncState.googleTokens.refresh_token);
                        syncState.googleTokens = {
                            ...newTokens,
                            refresh_token: syncState.googleTokens.refresh_token
                        };
                        await saveSyncStateToFirestore(req.userId);
                        
                        return res.status(401).json({
                            error: 'Token expiré',
                            message: 'Votre session a expiré. Veuillez réessayer la synchronisation.'
                        });
                    }
                } catch (refreshError) {
                    console.error('[Google Sync] Erreur lors du rafraîchissement du token:', refreshError);
                    syncState.isConnected = false;
                    await saveSyncStateToFirestore(req.userId);
                }
            }
            
            syncState.lastError = error.message;
            await saveSyncStateToFirestore(req.userId);
            
            res.status(500).json({
                error: 'Erreur lors de la synchronisation',
                message: error.message
            });
        }
    } catch (error) {
        console.error('[Google Sync] Erreur générale lors de la synchronisation du calendrier:', error);
        res.status(500).json({ error: 'Erreur serveur lors de la synchronisation' });
    }
});

// Gérer les requêtes OPTIONS
router.options('*', (req, res) => {
    setCorsHeaders(req, res);
    res.sendStatus(200);
});

// Exporter à la fois le routeur et la fonction getUserSyncState
module.exports = { 
    router,
    getUserSyncState
}; 