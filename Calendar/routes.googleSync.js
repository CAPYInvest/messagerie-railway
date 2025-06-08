/**
 * Routes de synchronisation Google Calendar
 * @module routes/googleSync
 */

const express = require('express');
const router = express.Router();
const googleCalendarService = require('./googleCalendar');
const { requireAuth } = require('../middlewareauth');
const admin = require('firebase-admin');

// État de synchronisation en mémoire par utilisateur
const userSyncStates = new Map();

// Fonction pour obtenir ou créer l'état de synchronisation d'un utilisateur
function getUserSyncState(userId) {
    if (!userSyncStates.has(userId)) {
        userSyncStates.set(userId, {
            isSyncing: false,
            progress: 0,
            lastError: null,
            googleTokens: null
        });
    }
    return userSyncStates.get(userId);
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

/**
 * Route de callback pour l'authentification Google
 */
router.post('/callback', async (req, res) => {
    try {
        console.log('[Google Sync] Réception du callback Google');
        console.log('[Google Sync] Headers:', req.headers);
        console.log('[Google Sync] Body:', req.body);

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
        const syncState = getUserSyncState(req.userId);

        // Réinitialiser l'état de synchronisation
        syncState.isSyncing = false;
        syncState.progress = 0;
        syncState.lastError = null;

        // Échange du code contre des tokens avec mécanisme de réessai
        let tokens = null;
        let attempts = 0;
        const maxAttempts = 2;

        while (attempts < maxAttempts && !tokens) {
            try {
                attempts++;
                console.log(`[Google Sync] Tentative ${attempts}/${maxAttempts} d'échange du code`);
                tokens = await googleCalendarService.getTokens(code);
                
                console.log('[Google Sync] Tokens reçus:', {
                    access_token: tokens.access_token ? 'Présent' : 'Absent',
                    refresh_token: tokens.refresh_token ? 'Présent' : 'Absent',
                    scope: tokens.scope,
                    token_type: tokens.token_type,
                    expiry_date: tokens.expiry_date
                });

                // Stockage des tokens pour cet utilisateur
                syncState.googleTokens = tokens;
                
                // Démarrage de la synchronisation
                syncState.isSyncing = true;
                syncState.progress = 0;
                syncState.lastError = null;

                // Simulation de la synchronisation
                setTimeout(() => {
                    syncState.isSyncing = false;
                    syncState.progress = 100;
                }, 2000);

                return res.json({ success: true, message: 'Authentification réussie' });
            } catch (error) {
                console.error(`[Google Sync] Erreur lors de la tentative ${attempts}:`, error.message);
                
                if (attempts >= maxAttempts || error.message.includes('expiré') || error.message.includes('déjà été utilisé')) {
                    throw error;
                }
                
                // Attendre un peu avant de réessayer
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Si on arrive ici, c'est qu'on a épuisé toutes les tentatives
        throw new Error("Échec de l'authentification après plusieurs tentatives");
    } catch (error) {
        console.error('[Google Sync] Erreur lors du callback:', error);
        if (req.userId) {
            const syncState = getUserSyncState(req.userId);
            syncState.lastError = error.message;
            syncState.isSyncing = false;
        }
        
        // Message d'erreur plus convivial
        let errorMessage = error.message;
        if (error.message.includes('invalid_grant') || error.message.includes('expiré') || error.message.includes('déjà été utilisé')) {
            errorMessage = 'Le code d\'autorisation a expiré. Veuillez réessayer la synchronisation.';
        }
        
        res.status(400).json({ error: errorMessage });
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

        const syncState = getUserSyncState(req.userId);
        
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
            
            syncState.isSyncing = true;
            syncState.progress = 0;
            syncState.lastError = null;
            syncState.syncStartedAt = Date.now();

            // Simulation de la synchronisation
            setTimeout(() => {
                syncState.isSyncing = false;
                syncState.progress = 100;
                delete syncState.syncStartedAt;
            }, 2000);

            res.json({ success: true, message: 'Synchronisation démarrée' });
        } catch (error) {
            console.error('[Google Sync] Erreur avec les tokens:', error);
            
            // Si les tokens sont invalides, rediriger vers l'authentification
            console.log('[Google Sync] Tokens invalides, génération d\'une nouvelle URL d\'authentification');
            syncState.googleTokens = null;
            const authUrl = googleCalendarService.getAuthUrl();
            return res.json({ authUrl });
        }
    } catch (error) {
        console.error('[Google Sync] Erreur lors du démarrage de la synchronisation:', error);
        if (req.userId) {
            const syncState = getUserSyncState(req.userId);
            syncState.lastError = error.message;
            syncState.isSyncing = false;
        }
        res.status(500).json({ error: error.message });
    }
});

/**
 * Route pour vérifier le statut de la synchronisation
 */
router.get('/status', (req, res) => {
    console.log('[Google Sync] Vérification du statut de synchronisation');
    
    // Vérifier si l'ID utilisateur est disponible
    if (!req.userId) {
        console.error('[Google Sync] ID utilisateur manquant');
        return res.status(401).json({ error: 'Authentification requise' });
    }
    
    const syncState = getUserSyncState(req.userId);
    console.log(`[Google Sync] État actuel pour l'utilisateur ${req.userId}:`, syncState);
    
    res.json(syncState);
});

// Route pour l'authentification Google (pas besoin d'auth)
router.post('/auth', async (req, res) => {
    try {
        console.log('[Google Sync] Demande d\'authentification');
        
        const authUrl = googleCalendarService.getAuthUrl();
        console.log('[Google Sync] URL d\'authentification générée:', authUrl);
        
        res.json({ requiresAuth: true, authUrl });
    } catch (error) {
        console.error('[Google Sync] Erreur lors de la génération de l\'URL d\'authentification:', error);
        res.status(500).json({ error: error.message });
    }
});

// Gérer les requêtes OPTIONS
router.options('*', (req, res) => {
    setCorsHeaders(req, res);
    res.sendStatus(200);
});

module.exports = router; 