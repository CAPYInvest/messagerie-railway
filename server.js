// Importation d'Express
const express = require('express');
const cors = require('cors');

const app = express();
// Configuration du middleware cors
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Port d'écoute
const port = process.env.PORT || 3000;

// Middleware pour parser le corps des requêtes en JSON
app.use(express.json());

// Votre route POST
app.post('/api/message', (req, res) => {
  const message = req.body.message;
  if (!message) {
    return res.status(400).json({ error: 'Message manquant' });
  }
  console.log('Message reçu:', message);
  res.json({ success: true, message: message });
});

// Démarrage du serveur
app.listen(port, () => {
  console.log(`Serveur Node.js démarré sur le port ${port}`);
});
