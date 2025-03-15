// Importation d'Express
const express = require('express');
const app = express();

// Port d'écoute (utilise la variable d'environnement PORT si définie par Railway)
const port = process.env.PORT || 3000;

// Middleware pour parser le corps des requêtes en JSON
app.use(express.json());

// Définition d'une route POST pour recevoir le message
app.post('/api/message', (req, res) => {
  const message = req.body.message;
  if (!message) {
    return res.status(400).json({ error: 'Message manquant' });
  }
  console.log('Message reçu:', message);
  // Vous pourrez ultérieurement ajouter ici la logique de stockage (ex : base de données)
  res.json({ success: true, message: message });
});

// Démarrage du serveur
app.listen(port, () => {
  console.log(`Serveur Node.js démarré sur le port ${port}`);
});
