//route pour générer un token personnalisé avec jsonwebtoken
// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Route de test simple
router.get('/test', (req, res) => {
  console.log('[Auth] Route de test appelée');
  // Ajout d'en-têtes CORS spécifiques
  res.header('Access-Control-Allow-Origin', 'https://capy-invest-fr.webflow.io');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  return res.json({ message: 'Le serveur fonctionne correctement!' });
});

// On suppose que le payload contient au minimum l'ID du membre
router.post('/login', async (req, res) => {
  try {
    console.log('[Auth] Requête de login reçue');
    console.log('[Auth] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[Auth] Body:', JSON.stringify(req.body, null, 2));
    
    // Ajout d'en-têtes CORS spécifiques
    res.header('Access-Control-Allow-Origin', 'https://capy-invest-fr.webflow.io');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    const memberData = req.body;
    if (!memberData) {
      console.error('[Auth] Aucune donnée reçue dans le body');
      return res.status(400).json({ error: 'Aucune donnée reçue.' });
    }

    if (!memberData.memberId) {
      console.error('[Auth] Données membres manquantes:', memberData);
      return res.status(400).json({ error: 'Données membres manquantes.' });
    }

    try {
      const payload = { uid: memberData.memberId };
      console.log('[Auth] Génération du token pour:', payload);
      
      if (!process.env.MEMBERSTACK_SECRET_TOKEN) {
        console.error('[Auth] Variable d\'environnement MEMBERSTACK_SECRET_TOKEN non définie');
        return res.status(500).json({ error: 'Configuration du serveur incorrecte.' });
      }
      
      // Générer un token personnalisé avec une expiration d'1 heure
      const token = jwt.sign(payload, process.env.MEMBERSTACK_SECRET_TOKEN, { expiresIn: '1h' });
      console.log('[Auth] Token généré avec succès');
      
      return res.json({ token });
    } catch (error) {
      console.error('[Auth] Erreur lors de la génération du token:', error);
      return res.status(500).json({ error: 'Erreur lors de la génération du token: ' + error.message });
    }
  } catch (error) {
    console.error('[Auth] Erreur générale dans la route login:', error);
    return res.status(500).json({ error: 'Erreur serveur: ' + error.message });
  }
});

// Gérer les requêtes OPTIONS pour le CORS
router.options('/login', (req, res) => {
  res.header('Access-Control-Allow-Origin', 'https://capy-invest-fr.webflow.io');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

module.exports = router;
