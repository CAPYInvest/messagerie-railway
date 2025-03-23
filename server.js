// server.js
const express = require('express');
const cors = require('cors');

// --- 1) Import des modules Firebase côté Node.js
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where
} = require('firebase/firestore'); // Note : Firestore Lite ou Firestore ?

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

// --- 4) Création du serveur Express
const app = express();

// Autorise le JSON et CORS
// Configuration du middleware cors
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

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

    // Comme Firestore ne gère pas directement le "OR" sur deux champs,
    // on va faire 2 requêtes :
    // 1) senderId=senderId & receiverId=recipientId
    // 2) senderId=recipientId & receiverId=senderId
    // puis on fusionne les résultats.

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

// --- 5) Lancement du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur Node.js démarré sur le port ${PORT}`);
});
