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

// 1) Config Firebase
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

// 2) Init Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// 3) Express + Socket.io
const app = express();
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// Serveur HTTP + Socket.io
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'https://capy-invest-fr.webflow.io',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log('Un client est connecté à Socket.io :', socket.id);
});

// -------------------------------------------------------------------
// FONCTION SIMPLE D’ÉCHAPPEMENT (évite XSS en transformant <, >, etc.)
// -------------------------------------------------------------------
function sanitizeString(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // échappe aussi l'apostrophe
}

// ----------------------------------------------
// ROUTE 1 : POST /api/messages (ajout d’un message)
// ----------------------------------------------
app.post('/api/messages', async (req, res) => {
  try {
    const { message, senderId, receiverId } = req.body;
    if (!message || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Champs message, senderId, receiverId requis' });
    }

    // Échapper le contenu du message pour éviter le code HTML malveillant
    const safeMessage = sanitizeString(message);

    // Enregistrer dans Firestore
    const docRef = await addDoc(collection(db, 'messages'), {
      message: safeMessage,
      senderId,
      receiverId,
      timestamp: new Date()
    });

    console.log('Nouveau message ajouté :', docRef.id);

    // Émettre un événement temps réel si vous utilisez Socket.io
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
// ROUTE 2 : GET /api/messages?senderId=xxx&recipientId=yyy
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

    // Tri par date
    results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return res.json(results);
  } catch (error) {
    console.error('Erreur lors de la récupération des messages :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// ----------------------------------------------
// ROUTE 3 : GET /api/last-message?userId=....
// ----------------------------------------------

// Nouvelle route : GET /api/last-message?userId=XXX
app.get('/api/last-message', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'Paramètre userId requis' });
    }

    // On va récupérer tous les messages où userId est sender OU receiver
    // Comme Firestore ne gère pas le OR direct sur deux champs,
    // on fait deux requêtes et on fusionne.
    const messagesColl = collection(db, 'messages');

    const qA = query(messagesColl, where('senderId', '==', userId));
    const qB = query(messagesColl, where('receiverId', '==', userId));

    let allMessages = [];

    // Récup query A
    const snapA = await getDocs(qA);
    snapA.forEach(doc => {
      allMessages.push({ id: doc.id, ...doc.data() });
    });

    // Récup query B
    const snapB = await getDocs(qB);
    snapB.forEach(doc => {
      allMessages.push({ id: doc.id, ...doc.data() });
    });

    if (allMessages.length === 0) {
      // Aucun message où userId est impliqué
      return res.json(null); // ou { message: null }
    }

    // Trier par date décroissante (plus récent en premier)
    function getTimeValue(ts) {
      // Si c'est un objet Firestore {seconds, nanoseconds}
      if (ts && ts.seconds !== undefined) {
        return ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1e6);
      }
      // Sinon, s'il s'agit déjà d'une date ou d'un string date
      return new Date(ts).getTime();
    }    
    allMessages.sort((a, b) => {
      return getTimeValue(b.timestamp) - getTimeValue(a.timestamp);
    });   
    console.log("Après tri (du plus récent au plus ancien) :");
    allMessages.forEach(m => {
      console.log(
        `messageID=${m.id}`,
        `sender=${m.senderId}`,
        `receiver=${m.receiverId}`,
        `timestamp=${m.timestamp}`
      );
    });
    const lastMsg = allMessages[0];
    console.log("Le plus récent message est :", lastMsg);
    return res.json(lastMsg);
  } catch (error) {
    console.error('Erreur /api/last-message :', error);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

// ----------------------------------------------
// ROUTE 4 : GET /api/unread
// ----------------------------------------------

app.get('/api/unread', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'Paramètre userId requis' });
    }
    
    // TODO: Ici, calculez le nombre de messages non lus pour chaque contact
    // ex: vous parcourez la collection "messages", 
    //     trouvez ceux reçus par userId et pas encore "lus"
    //     et regroupez par senderId, etc.

    // Pour l'exemple, renvoyons un tableau bidon :
    // [
    //   { contactId: 'mem_abc123', unreadCount: 2, lastMessageTime: '2025-03-27T14:05:00.000Z' },
    //   { contactId: 'mem_def456', unreadCount: 0, lastMessageTime: '2025-03-26T10:20:00.000Z' }
    // ]

    const result = [
      {
        contactId: 'mem_cm76fa3di06di0sskfvxdgb96',
        unreadCount: 2,
        lastMessageTime: new Date().toISOString()
      },
      {
        contactId: 'mem_foobar',
        unreadCount: 0,
        lastMessageTime: '2025-03-26T10:20:00.000Z'
      }
    ];

    return res.json(result);
  } catch (err) {
    console.error('Erreur /api/unread :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});


// 5) Lancement
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur Node.js + Socket.io démarré sur le port ${PORT}`);
});
