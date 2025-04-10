//route pour générer un token personnalisé avec jsonwebtoken
// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// On suppose que le payload contient au minimum l'ID du membre
router.post('/login', async (req, res) => {
  const memberData = req.body;
  if (!memberData || !memberData.id) {
    return res.status(400).json({ error: 'Données membres manquantes.' });
  }
  const payload = { uid: memberData.id };
  // Générer un token personnalisé avec une expiration d'1 heure
  const token = jwt.sign(payload, process.env.MEMBERSTACK_SECRET_TOKEN, { expiresIn: '1h' });
  res.json({ token });
});

module.exports = router;
