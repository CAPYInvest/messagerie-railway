// server.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where
} = require('firebase/firestore');

// --- 1) Configuration Firebase
const firebaseConfig = {
  // ...
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const app = express();
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// --------------------------------------------------------------------
// (A) Création du serveur HTTP + Socket.io (si vous faites du temps réel)
// --------------------------------------------------------------------
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'https://capy-invest-fr.webflow.io',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log('Un client est connecté Socket.io :', socket.id);
});

// --------------------------------------------------------------------
// (B) Fonction d’échappement (anti-XSS) la plus simple
// --------------------------------------------------------------------
function sanitizeString(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----------------------------------------------
// ROUTE 1 : POST /api/messages
// ----------------------------------------------
app.post('/api/messages', async (req, res) => {
  try {
    const { message, senderId, receiverId } = req.body;
    if (!message || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Champs message, senderId, receiverId requis' });
    }

    // (C) On “sanitize” le message pour éviter tout XSS
    const safeMessage = sanitizeString(message);

    // Ajoute un document dans Firestore
    const docRef = await addDoc(collection(db, 'messages'), {
      message: safeMessage,
      senderId,
      receiverId,
      timestamp: new Date()
    });

    console.log('Nouveau message ajouté :', docRef.id);

    // (D) Si vous faites du temps réel, émettre un événement
    io.emit('newMessage', {
      id: docRef.id,
      message: safeMessage,
      senderId,
      receiverId,
      timestamp: new Date().toISOString()
    });

    return res.json({ success: true, message: 'Message enregistré', id: docRef.id });
  } catch (error) {
    console.error('Erreur lors de l\'ajout du message :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// ----------------------------------------------
// ROUTE 2 : GET /api/messages
// ----------------------------------------------
app.get('/api/messages', async (req, res) => {
  try {
    const { senderId, recipientId } = req.query;
    if (!senderId || !recipientId) {
      return res.status(400).json({ error: 'Paramètres senderId et recipientId requis' });
    }

    const messagesCollection = collection(db, 'messages');

    // Query A
    const q1 = query(
      messagesCollection,
      where('senderId', '==', senderId),
      where('receiverId', '==', recipientId)
    );
    // Query B
    const q2 = query(
      messagesCollection,
      where('senderId', '==', recipientId),
      where('receiverId', '==', senderId)
    );

    let results = [];
    const snapshotA = await getDocs(q1);
    snapshotA.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });
    const snapshotB = await getDocs(q2);
    snapshotB.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });

    // Trier par date
    results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return res.json(results);
  } catch (error) {
    console.error('Erreur lors de la récupération des messages :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// --- Lancement du serveur
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur Node.js démarré sur le port ${PORT}`);
});
