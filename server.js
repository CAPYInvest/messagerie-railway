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
  where,
  doc,
  getDoc,           
  updateDoc,
  deleteDoc,      
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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

    // Ajout dans Firestore avec read: false
    const docRef = await addDoc(collection(db, 'messages'), {
      message,
      senderId,
      receiverId,
      timestamp: new Date(),
      read: false   // <-- Important
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
    // Pour clarifier les noms :
    const userId = senderId;    // L'utilisateur courant
    const otherId = recipientId; // L'autre personne

    const messagesCollection = collection(db, 'messages');

    // Query A : userId -> otherId
    const q1 = query(
      messagesCollection,
      where('senderId', '==', senderId),
      where('receiverId', '==', recipientId)
    );
    // Query B : otherId -> userId
    const q2 = query(
      messagesCollection,
      where('senderId', '==', recipientId),
      where('receiverId', '==', senderId)
    );

    let results = [];

    // Récup A
    const snapshotA = await getDocs(q1);
    snapshotA.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });

    // Récup B
    const snapshotB = await getDocs(q2);
    snapshotB.forEach(doc => {
      results.push({ id: doc.id, ...doc.data() });
    });

    // ⬇️ Marquer "lu" UNIQUEMENT si msg.receiverId === userId
    for (const msg of results) {
      if (!msg.read && msg.receiverId === userId) {
        const docRef = doc(db, 'messages', msg.id);
        await updateDoc(docRef, { read: true });
      }
    }  

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
// ROUTE 4 : GET /api/unread?userId=xxx
// ----------------------------------------------

// ATTENTION : Il faut installer et importer les fonctions Firestore côté Node
//    const { initializeApp } = require('firebase/app');
//    const { getFirestore, collection, getDocs, query, where } = require('firebase/firestore');

app.get('/api/unread', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'Paramètre userId requis' });
    }

    // 1) Récupérer tous les messages "read = false" où receiverId = userId
    const messagesRef = collection(db, 'messages');
    const q = query(
      messagesRef,
      where('receiverId', '==', userId),
      where('read', '==', false)
    );
    const snapshot = await getDocs(q);

    // 2) Regrouper par senderId
    //    On construit un map : { [senderId]: { unreadCount, lastMessageTime } }
    const map = new Map();

    snapshot.forEach(doc => {
      const data = doc.data();
      const sender = data.senderId;
      if (!map.has(sender)) {
        map.set(sender, {
          contactId: sender,
          unreadCount: 0,
          lastMessageTime: 0
        });
      }
      const obj = map.get(sender);

      // Incrémenter le nombre de non-lus
      obj.unreadCount++;

      // Gérer la date du dernier message
      // On convertit data.timestamp (Date ou Firestore Timestamp) en nombre (ms)
      let ts = 0;
      if (data.timestamp && data.timestamp.toMillis) {
        // Firestore Timestamp
        ts = data.timestamp.toMillis();
      } else {
        // Date JS ou string
        ts = new Date(data.timestamp).getTime();
      }
      // Mettre à jour si c'est plus récent
      if (ts > obj.lastMessageTime) {
        obj.lastMessageTime = ts;
      }
    });

    // 3) Transformer le map en tableau
    //    ex: [ { contactId, unreadCount, lastMessageTime: "2025-03-27T14:05:00.000Z" }, ... ]
    const result = Array.from(map.values()).map(item => {
      return {
        contactId: item.contactId,
        unreadCount: item.unreadCount,
        // Convertir le nombre (ms) en ISO string
        lastMessageTime: new Date(item.lastMessageTime).toISOString()
      };
    });

    // 4) Retourner le tableau
    return res.json(result);

  } catch (err) {
    console.error('Erreur /api/unread :', err);
    return res.status(500).json({ error: 'Erreur interne' });
  }
});

//---------------------------------------------------------------------
// ROUTE 5 : PUT /api/messages/:id
// Permet de modifier un message existant si on est l’expéditeur
//---------------------------------------------------------------------
app.put('/api/messages/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    const { userId, newContent } = req.body; 
    // userId = l'utilisateur courant, newContent = nouveau texte du message

    if (!messageId || !userId || !newContent) {
      return res.status(400).json({ error: 'Données manquantes (messageId, userId, newContent)' });
    }

    // On récupère le document Firestore
    const docRef = doc(db, 'messages', messageId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      return res.status(404).json({ error: 'Message introuvable' });
    }

    const messageData = docSnap.data();
    // Vérification : seul l’expéditeur peut modifier
    if (messageData.senderId !== userId) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    // Sanitize pour éviter XSS
    const safeContent = sanitizeString(newContent);

    // Mise à jour dans Firestore
    await updateDoc(docRef, {
      message: safeContent,
      edited: true
    });

    console.log(`Message ${messageId} modifié par ${userId}`);

    // Émettre un événement Socket.io => tous les clients peuvent se mettre à jour
    io.emit('messageUpdated', {
      id: messageId,
      senderId: messageData.senderId,
      receiverId: messageData.receiverId,
      newContent: safeContent,
      edited: true    // <-- on signale que c'est édité
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur lors de la modification du message :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

//---------------------------------------------------------------------
// ROUTE 6 : DELETE /api/messages/:id
// Permet de supprimer un message si on est l’expéditeur
//---------------------------------------------------------------------
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    // userId peut être passé en query ?userId=xxx ou dans le body
    // Ici, on le récupère en query pour l’exemple
    const { userId } = req.query;

    if (!messageId || !userId) {
      return res.status(400).json({ error: 'Paramètres messageId et userId requis' });
    }

    const docRef = doc(db, 'messages', messageId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      return res.status(404).json({ error: 'Message introuvable' });
    }

    const messageData = docSnap.data();
    // Vérification : seul l’expéditeur peut supprimer
    if (messageData.senderId !== userId) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    // Suppression Firestore
    await deleteDoc(docRef);

    console.log(`Message ${messageId} supprimé par ${userId}`);

    // Émettre un événement Socket.io => tous les clients peuvent se mettre à jour
    io.emit('messageDeleted', {
      id: messageId,
      senderId: messageData.senderId,
      receiverId: messageData.receiverId
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur lors de la suppression du message :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});



// 5) Lancement
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur Node.js + Socket.io démarré sur le port ${PORT}`);
});
