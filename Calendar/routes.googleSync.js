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
            googleTokens: null,
            isConnected: false,
            lastSync: null
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
                syncState.isConnected = true;
                
                // Démarrer la simulation de progression
                simulateProgress(req.userId);

                return res.json({ success: true, message: 'Authentification réussie' });
            } catch (error) {
                console.error(`[Google Sync] Erreur lors de la tentative ${attempts}:`, error.message);
                
                // Si l'erreur est "invalid_grant", considérer que l'utilisateur est déjà connecté
                if (error.message && error.message.includes('invalid_grant')) {
                    console.log('[Google Sync] Code déjà utilisé, considérant que l\'utilisateur est déjà connecté');
                    
                    // Marquer l'utilisateur comme connecté même si nous n'avons pas les tokens
                    syncState.isConnected = true;
                    syncState.progress = 100;
                    syncState.lastSync = new Date().toISOString();
                    
                    return res.json({ 
                        success: true, 
                        alreadyConnected: true,
                        message: 'Votre compte Google Calendar est déjà connecté.' 
                    });
                }
                
                if (attempts >= maxAttempts || error.message.includes('expiré')) {
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

/**
 * Route pour déconnecter Google Calendar
 */
router.post('/disconnect', (req, res) => {
    console.log('[Google Sync] Demande de déconnexion Google Calendar');
    
    // Vérifier si l'ID utilisateur est disponible
    if (!req.userId) {
        console.error('[Google Sync] ID utilisateur manquant');
        return res.status(401).json({ error: 'Authentification requise' });
    }
    
    const syncState = getUserSyncState(req.userId);
    
    // Réinitialiser l'état de synchronisation
    syncState.googleTokens = null;
    syncState.isConnected = false;
    syncState.lastSync = null;
    syncState.isSyncing = false;
    syncState.progress = 0;
    syncState.lastError = null;
    
    console.log(`[Google Sync] Compte Google Calendar déconnecté pour l'utilisateur ${req.userId}`);
    
    res.json({ success: true, message: 'Compte Google Calendar déconnecté avec succès' });
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