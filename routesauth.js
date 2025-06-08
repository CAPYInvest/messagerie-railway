//route pour générer un token personnalisé avec jsonwebtoken
// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// On suppose que le payload contient au minimum l'ID du membre
router.post('/login', async (req, res) => {
  console.log('[Auth] Requête de login reçue');
  console.log('[Auth] Headers:', req.headers);
  console.log('[Auth] Body:', req.body);
  
  const memberData = req.body;
  if (!memberData || !memberData.memberId) {
    console.error('[Auth] Données membres manquantes:', memberData);
    return res.status(400).json({ error: 'Données membres manquantes.' });
  }

  try {
    const payload = { uid: memberData.memberId };
    console.log('[Auth] Génération du token pour:', payload);
    
    // Générer un token personnalisé avec une expiration d'1 heure
    const token = jwt.sign(payload, process.env.MEMBERSTACK_SECRET_TOKEN, { expiresIn: '1h' });
    console.log('[Auth] Token généré avec succès');
    
    res.json({ token });
  } catch (error) {
    console.error('[Auth] Erreur lors de la génération du token:', error);
    res.status(500).json({ error: 'Erreur lors de la génération du token' });
  }
});

module.exports = router;
