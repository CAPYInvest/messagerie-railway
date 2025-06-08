const express = require('express');
const router = express.Router();
const googleCalendar = require('./googleCalendar');
const { requireAuth } = require('../middlewareauth');
const admin = require('firebase-admin');

// État de synchronisation global
let syncState = {
    isSyncing: false,
    progress: 0,
    lastError: null
};

// Route pour vérifier le statut de synchronisation (pas besoin d'auth)
router.get('/status', (req, res) => {
    console.log('[Google Sync] Vérification du statut de synchronisation');
    console.log('[Google Sync] État actuel:', syncState);
    res.json(syncState);
});

// Route pour gérer le callback de Google OAuth
router.post('/callback', requireAuth, async (req, res) => {
    try {
        console.log('[Google Sync] Réception du callback Google avec code:', req.body.code);
        
        // Récupérer le code d'autorisation
        const { code } = req.body;
        if (!code) {
            throw new Error('Code d\'autorisation manquant');
        }

        // Échanger le code contre des tokens
        const tokens = await googleCalendar.getTokens(code);
        console.log('[Google Sync] Tokens reçus:', tokens);

        // Stocker les tokens dans l'état de synchronisation
        syncState.googleTokens = tokens;
        syncState.hasTokens = true;

        res.json({ success: true, message: 'Authentification réussie' });
    } catch (error) {
        console.error('[Google Sync] Erreur lors du callback:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route pour vérifier le statut de synchronisation
router.get('/status', requireAuth, (req, res) => {
    console.log('[Google Sync] Vérification du statut de synchronisation');
    console.log('[Google Sync] État actuel:', syncState);
    res.json({
        ...syncState,
        hasTokens: !!syncState.googleTokens
    });
});

// Route pour démarrer la synchronisation (nécessite auth)
router.post('/sync', requireAuth, async (req, res) => {
    try {
        console.log('[Google Sync] Démarrage de la synchronisation pour utilisateur:', req.member.uid);
        
        if (syncState.isSyncing) {
            console.log('[Google Sync] Une synchronisation est déjà en cours');
            return res.status(409).json({ error: 'Une synchronisation est déjà en cours' });
        }

        // Vérifier si nous avons des tokens Google
        if (!syncState.googleTokens) {
            console.log('[Google Sync] Pas de tokens Google, redirection vers l\'authentification');
            return res.json({ requiresAuth: true, authUrl: googleCalendar.getAuthUrl() });
        }

        syncState = {
            isSyncing: true,
            progress: 0,
            lastError: null,
            googleTokens: syncState.googleTokens
        };

        // Configurer le client Google avec les tokens
        googleCalendar.setCredentials(syncState.googleTokens);

        // Simulation de progression (à remplacer par la vraie logique)
        const progressInterval = setInterval(() => {
            if (syncState.progress < 90) {
                syncState.progress += 10;
                console.log('[Google Sync] Progression:', syncState.progress + '%');
            }
        }, 1000);

        // TODO: Implémenter la vraie logique de synchronisation ici
        await new Promise(resolve => setTimeout(resolve, 5000)); // Simulation

        clearInterval(progressInterval);
        syncState = {
            isSyncing: false,
            progress: 100,
            lastError: null,
            googleTokens: syncState.googleTokens
        };

        console.log('[Google Sync] Synchronisation terminée avec succès');
        res.json({ success: true, message: 'Synchronisation terminée' });

    } catch (error) {
        console.error('[Google Sync] Erreur lors de la synchronisation:', error);
        syncState = {
            isSyncing: false,
            progress: 0,
            lastError: error.message,
            googleTokens: syncState.googleTokens
        };
        res.status(500).json({ error: error.message });
    }
});

// Route pour l'authentification Google (pas besoin d'auth)
router.post('/auth', async (req, res) => {
    try {
        console.log('[Google Sync] Demande d\'authentification');
        
        const authUrl = googleCalendar.getAuthUrl();
        console.log('[Google Sync] URL d\'authentification générée:', authUrl);
        
        res.json({ requiresAuth: true, authUrl });
    } catch (error) {
        console.error('[Google Sync] Erreur lors de la génération de l\'URL d\'authentification:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 