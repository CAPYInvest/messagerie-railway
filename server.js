// server.js
const express = require('express');
const cors = require('cors');
const http = require('http');          // <-- Pour créer un serveur HTTP
const { Server } = require('socket.io'); // <-- Socket.io

// --- 1) Import des modules Firebase côté Node.js
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where
} = require('firebase/firestore');

// --- 2) Configuration Firebase (cachée côté serveur)
const firebaseConfig = {
  apiKey: "xxx",
  authDomain: "capy-invest.firebaseapp.com",
  databaseURL: "https://capy-invest-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "capy-invest",
  storageBucket: "capy-investheroku.firebaseapp.com",
  messagingSenderId: "1056270478078",
  appId: "1:1056270478078:web:5f54bdabd1f0ce662253af",
  measurementId: "G-WD1T00C496"
};

// --- 3) Initialisation de Firebase et Firestore
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// --- 4) Création de l'app Express
const app = express();

// Autorise le JSON et CORS
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// ---------------------------------------------------------------------------
// Création du serveur HTTP et injection de Socket.io
// ---------------------------------------------------------------------------
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'https://capy-invest-fr.webflow.io',
    methods: ['GET', 'POST']
  }
});

// ---------------------------------------------------------------------------
// Socket.io : lorsque le client se connecte, on peut logger ou gérer des rooms
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('Un client est connecté à Socket.io :', socket.id);

  // Optionnel : vous pouvez écouter des événements côté client, ex: "joinRoom"
  // socket.on('joinRoom', (roomName) => {
  //   socket.join(roomName);
  // });
});

// ----------------------------------------------
// ROUTE 1 : POST /api/messages
// Enregistre un message dans la collection "messages"
// ----------------------------------------------
app.post('/api/messages', async (req, res) => {
  try {
    const { message, senderId, receiverId } = req.body;

    if (!message || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Champs message, senderId, receiverId requis' });
    }

    // Ajoute un document dans Firestore
    const docRef = await addDoc(collection(db, 'messages'), {
      message,
      senderId,
      receiverId,
      timestamp: new Date()
    });

    console.log('Nouveau message ajouté :', docRef.id);

    // Émettre un événement "newMessage" via Socket.io
    // pour avertir tous les clients qu'un nouveau message est disponible
    io.emit('newMessage', {
      id: docRef.id,
      message,
      senderId,
      receiverId,
      timestamp: new Date().toISOString() // ou tout autre format
    });

    return res.json({ success: true, message: 'Message enregistré', id: docRef.id });
  } catch (error) {
    console.error('Erreur lors de l\'ajout du message :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// ----------------------------------------------
// ROUTE 2 : GET /api/messages?senderId=...&recipientId=...
// Récupère tous les messages échangés entre deux utilisateurs
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

    // Exécuter la requête A
    const snapshotA = await getDocs(q1);
    snapshotA.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });

    // Exécuter la requête B
    const snapshotB = await getDocs(q2);
    snapshotB.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });

    // Trier par date croissante (timestamp)
    results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return res.json(results);
  } catch (error) {
    console.error('Erreur lors de la récupération des messages :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// --- 5) Lancement du serveur sur le port
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur Node.js + Socket.io démarré sur le port ${PORT}`);
});
