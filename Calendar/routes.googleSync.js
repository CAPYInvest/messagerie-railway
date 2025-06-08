/**
 * Routes de synchronisation Google Calendar
 * @module routes/googleSync
 */

const express = require('express');
const router = express.Router();
const googleCalendarService = require('./googleCalendar');
const { verifyToken } = require('../middleware/auth');
const admin = require('firebase-admin');

// État de synchronisation en mémoire
let syncState = {
    isSyncing: false,
    progress: 0,
    lastError: null,
    googleTokens: null
};

/**
 * Route de callback pour l'authentification Google
 */
router.post('/callback', verifyToken, async (req, res) => {
    try {
        console.log('[Google Sync] Réception du callback Google');
        console.log('[Google Sync] Headers:', req.headers);
        console.log('[Google Sync] Body:', req.body);

        const { code } = req.body;
        if (!code) {
            console.error('[Google Sync] Code d\'autorisation manquant');
            return res.status(400).json({ error: 'Code d\'autorisation manquant' });
        }

        console.log('[Google Sync] Code reçu:', code);

        // Échange du code contre des tokens
        try {
            const tokens = await googleCalendarService.getTokens(code);
            console.log('[Google Sync] Tokens reçus:', {
                access_token: tokens.access_token ? 'Présent' : 'Absent',
                refresh_token: tokens.refresh_token ? 'Présent' : 'Absent',
                scope: tokens.scope,
                token_type: tokens.token_type,
                expiry_date: tokens.expiry_date
            });

            // Stockage des tokens
            syncState.googleTokens = tokens;
            googleCalendarService.setCredentials(tokens);

            // Démarrage de la synchronisation
            syncState.isSyncing = true;
            syncState.progress = 0;
            syncState.lastError = null;

            // Simulation de la synchronisation
            setTimeout(() => {
                syncState.isSyncing = false;
                syncState.progress = 100;
            }, 2000);

            res.json({ success: true, message: 'Authentification réussie' });
        } catch (error) {
            console.error('[Google Sync] Erreur lors de l\'échange du code:', error);
            console.error('[Google Sync] Stack trace:', error.stack);
            console.error('[Google Sync] Détails de l\'erreur:', {
                message: error.message,
                code: error.code,
                errors: error.errors,
                response: error.response ? {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                } : null
            });
            throw error;
        }
    } catch (error) {
        console.error('[Google Sync] Erreur lors du callback:', error);
        syncState.lastError = error.message;
        res.status(500).json({ error: error.message });
    }
});

/**
 * Route pour démarrer la synchronisation
 */
router.post('/sync', verifyToken, async (req, res) => {
    try {
        if (syncState.isSyncing) {
            return res.status(400).json({ error: 'Une synchronisation est déjà en cours' });
        }

        if (!syncState.googleTokens) {
            console.log('[Google Sync] Génération de l\'URL d\'authentification');
            const authUrl = googleCalendarService.getAuthUrl();
            return res.json({ authUrl });
        }

        syncState.isSyncing = true;
        syncState.progress = 0;
        syncState.lastError = null;

        // Simulation de la synchronisation
        setTimeout(() => {
            syncState.isSyncing = false;
            syncState.progress = 100;
        }, 2000);

        res.json({ success: true, message: 'Synchronisation démarrée' });
    } catch (error) {
        console.error('[Google Sync] Erreur lors du démarrage de la synchronisation:', error);
        syncState.lastError = error.message;
        res.status(500).json({ error: error.message });
    }
});

/**
 * Route pour vérifier le statut de la synchronisation
 */
router.get('/status', verifyToken, (req, res) => {
    console.log('[Google Sync] Vérification du statut de synchronisation');
    console.log('[Google Sync] État actuel:', syncState);
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

module.exports = router; 