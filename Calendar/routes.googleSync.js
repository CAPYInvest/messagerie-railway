const express = require('express');
const router = express.Router();
const googleCalendar = require('./googleCalendar');
const { requireAuth } = require('../middleware/auth');

// État de synchronisation global
let syncState = {
    isSyncing: false,
    progress: 0,
    lastError: null
};

// Route pour vérifier le statut de synchronisation
router.get('/status', (req, res) => {
    console.log('[Google Sync] Vérification du statut de synchronisation');
    console.log('[Google Sync] État actuel:', syncState);
    res.json(syncState);
});

// Route pour démarrer la synchronisation
router.post('/sync', requireAuth, async (req, res) => {
    try {
        console.log('[Google Sync] Démarrage de la synchronisation pour utilisateur:', req.user.id);
        
        if (syncState.isSyncing) {
            console.log('[Google Sync] Une synchronisation est déjà en cours');
            return res.status(409).json({ error: 'Une synchronisation est déjà en cours' });
        }

        syncState = {
            isSyncing: true,
            progress: 0,
            lastError: null
        };

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
            lastError: null
        };

        console.log('[Google Sync] Synchronisation terminée avec succès');
        res.json({ success: true, message: 'Synchronisation terminée' });

    } catch (error) {
        console.error('[Google Sync] Erreur lors de la synchronisation:', error);
        syncState = {
            isSyncing: false,
            progress: 0,
            lastError: error.message
        };
        res.status(500).json({ error: error.message });
    }
});

// Route pour l'authentification Google
router.post('/auth', requireAuth, async (req, res) => {
    try {
        console.log('[Google Sync] Demande d\'authentification pour utilisateur:', req.user.id);
        
        const authUrl = googleCalendar.getAuthUrl();
        console.log('[Google Sync] URL d\'authentification générée:', authUrl);
        
        res.json({ requiresAuth: true, authUrl });
    } catch (error) {
        console.error('[Google Sync] Erreur lors de la génération de l\'URL d\'authentification:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 