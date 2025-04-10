/* Firestore - Storage - server.js */

// ============ Partie Constante ============
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const connectedClients = {};
const jwt = require('jsonwebtoken');
const axios = require('axios');
// Importez le middleware d'authentification depuis middlewareauth.js et routes
const { requireAuth } = require('./middlewareauth');
const authRoutes = require('./routesauth');
const router = express.Router();
const app = express();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
// Initialisation firebase admin pour pouvoir avoir acccès au Storage
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');



admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "capy-invest.firebasestorage.app"
});
const bucket = admin.storage().bucket();

// Utilisez l'Admin SDK pour Firestore
const db = admin.firestore();




// 3) Express + Socket.io
app.use(cors({
  origin: 'https://capy-invest-fr.webflow.io',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());


//Import route token
app.use('/api', authRoutes);


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
  //-------------------------------------------------------------------------------
  // AJOUT VISIOCONF : Écouter l’événement "register" pour enregistrer le memberId
  // DE : socket.on('register', (data) => {
  // A : console.log(`Client déconnecté : ${socket.memberId}`);
  //-------------------------------------------------------------------------------
   // Écoute de l'enregistrement du memberId
   socket.on('register', (data) => {
    if (data && data.memberId) {
      connectedClients[data.memberId] = socket.id;
      socket.memberId = data.memberId;
      console.log(`Client enregistré : ${data.memberId} => ${socket.id}`);
      console.log("connectedClients =", connectedClients); // Pour vérification
    }
  });

  // Relai de l'invitation d'appel vers le destinataire
  socket.on('callInvitation', (data) => {
    const recipientSocketId = connectedClients[data.to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incomingCall', data);
      console.log(`Invitation d'appel de ${data.from} vers ${data.to} envoyée.`);
    } else {
      console.warn(`Le destinataire ${data.to} n'est pas connecté.`);
    }
  });

  // À la déconnexion, retirer le client
  socket.on('disconnect', () => {
    if (socket.memberId) {
      delete connectedClients[socket.memberId];
      console.log(`Client déconnecté : ${socket.memberId}`);
    }
  });
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
app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const { message, senderId, receiverId } = req.body;
    if (!message || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Champs message, senderId, receiverId requis' });
    }

    // Échapper le contenu du message pour éviter le code HTML malveillant
    const safeMessage = sanitizeString(message);

    // Ajout dans Firestore avec read: false
    const docRef = await addDoc(db.collection('messages'), {
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
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const { senderId, recipientId } = req.query;
    if (!senderId || !recipientId) {
      return res.status(400).json({ error: 'Paramètres senderId et recipientId requis' });
    }
    // Pour clarifier les noms :
    const userId = senderId;    // L'utilisateur courant
    const otherId = recipientId; // L'autre personne

    const messagesCollection = db.collection('messages');


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
app.get('/api/last-message', requireAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'Paramètre userId requis' });
    }

    // Utiliser le Admin SDK pour accéder à la collection "messages"
    const messagesColl = db.collection('messages');
    
    // Récupérer les messages où l'utilisateur est l'expéditeur
    const snapshotA = await messagesColl.where('senderId', '==', userId).get();
    
    // Récupérer les messages où l'utilisateur est le destinataire
    const snapshotB = await messagesColl.where('receiverId', '==', userId).get();
    
    let allMessages = [];
    
    snapshotA.forEach(doc => {
      allMessages.push({ id: doc.id, ...doc.data() });
    });
    snapshotB.forEach(doc => {
      allMessages.push({ id: doc.id, ...doc.data() });
    });
    
    if (allMessages.length === 0) {
      return res.json(null);
    }
    
    // Fonction utilitaire pour extraire la valeur en millisecondes d'un timestamp
    function getTimeValue(ts) {
      // Cas d'un Firestore Timestamp
      if (ts && ts.seconds !== undefined) {
        return ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1e6);
      }
      // Sinon, s'il s'agit d'une date JavaScript ou d'une chaîne de caractères
      return new Date(ts).getTime();
    }
    
    // Trier les messages par date décroissante (le plus récent en premier)
    allMessages.sort((a, b) => getTimeValue(b.timestamp) - getTimeValue(a.timestamp));
    
    console.log("Après tri (du plus récent au plus ancien) :");
    allMessages.forEach(m => {
      console.log(`messageID=${m.id}, sender=${m.senderId}, receiver=${m.receiverId}, timestamp=${m.timestamp}`);
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

app.get('/api/unread', requireAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'Paramètre userId requis' });
    }

    // Utilisez la collection "messages" du Admin SDK
    const messagesRef = db.collection('messages');
    // Récupérer les messages non lus (read == false) où receiverId est égal à userId
    const snapshot = await messagesRef
      .where('receiverId', '==', userId)
      .where('read', '==', false)
      .get();

    // Construction d'un map regroupant par senderId
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
      obj.unreadCount++;

      let ts = 0;
      if (data.timestamp && data.timestamp.seconds !== undefined) {
        ts = data.timestamp.seconds * 1000 + Math.floor(data.timestamp.nanoseconds / 1e6);
      } else {
        ts = new Date(data.timestamp).getTime();
      }
      if (ts > obj.lastMessageTime) {
        obj.lastMessageTime = ts;
      }
    });

    // Transformer le map en tableau
    const result = Array.from(map.values()).map(item => {
      return {
        contactId: item.contactId,
        unreadCount: item.unreadCount,
        lastMessageTime: new Date(item.lastMessageTime).toISOString()
      };
    });

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
app.put('/api/messages/:id', requireAuth, async (req, res) => {
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
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
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

//---------------------------------------------------------------------
// ROUTE 7 : VISIOCONFERENCE création de room :  /api/create-room
// Endpoint pour créer une salle Daily
//---------------------------------------------------------------------

app.post('/api/create-room', requireAuth, async (req, res) => {
  try {
    const { type } = req.body; // "audio" ou "video"

    // Définir nowInSeconds avant de l'utiliser
    const nowInSeconds = Math.floor(Date.now() / 1000);
    
    // Propriétés reconnues par l'API Daily
    // Ici, on coupe la vidéo au démarrage si c'est un appel audio.
    const roomOptions = {
      properties: {
        enable_screenshare: false,
        enable_chat: false,
        start_video_off: (type === "audio"),
        start_audio_off: false,
        exp: nowInSeconds + 3600   // Expire dans 1 heure
      }
    };

    const response = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer 1dd665faed96e61789a8e982faf2ffbb6197b4c49fd6bd06394cff9b1df7ae0c"
      },
      body: JSON.stringify(roomOptions)
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("Daily API error: ", errorData);
      return res.status(500).json({ error: "Erreur lors de la création de la salle." });
    }
    const data = await response.json();
    console.log("Salle Daily créée :", data.url);
    return res.json(data);

  } catch (error) {
    console.error("Erreur serveur:", error);
    res.status(500).json({ error: "Erreur interne." });
  }
});








// ============ Partie Stockage de fichiers (nouvelle fonctionnalité) ============













//---------------------------------------------------------------------
// ROUTE 8 : Gestionnaire de fichier : Upload /api/upload-file...
//---------------------------------------------------------------------

// Endpoint pour uploader un fichier
app.post('/api/upload-file', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier fourni." });
    }
    // Les IDs d'utilisateur sont envoyés dans le corps de la requête
    const { senderId, receiverId } = req.body;
    if (!senderId || !receiverId) {
      return res.status(400).json({ error: "Les champs senderId et receiverId sont requis." });
    }
    const timestamp = Date.now();
    const originalName = req.file.originalname;
    const filePath = `uploads/${senderId}_${timestamp}_${originalName}`;
    const fileUpload = bucket.file(filePath);
    
    const blobStream = fileUpload.createWriteStream({
      metadata: {
        contentType: req.file.mimetype
      }
    });
    
    blobStream.on('error', (err) => {
      console.error("Erreur lors de l'upload vers Storage :", err);
      return res.status(500).json({ error: err.message });
    });
    
    blobStream.on('finish', async () => {
      // Rendre le fichier public (optionnel, mais souvent nécessaire pour un accès direct)
      await fileUpload.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileUpload.name}`;
      
      // Enregistrer les métadonnées dans Firestore, dans la collection "sharedFiles"
      const fileDoc = await addDoc(db.collection('sharedFiles'), {
        senderId,
        receiverId,
        fileUrl: publicUrl,
        fileName: originalName,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        uploadedAt: new Date(),
        deleted: false  
      });
      
      // Émettre un événement Socket.io pour mettre à jour les clients en temps réel
      io.emit('newFile', {
        id: fileDoc.id,
        senderId,
        receiverId,
        fileUrl: publicUrl,
        fileName: originalName,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        uploadedAt: new Date().toISOString()
      });
      
      return res.json({ success: true, fileUrl: publicUrl, fileId: fileDoc.id });
    });
    
    blobStream.end(req.file.buffer);
  } catch (error) {
    console.error("Erreur dans /api/upload-file :", error);
    res.status(500).json({ error: error.message });
  }
});


//---------------------------------------------------------------------
// ROUTE 9 : Gestionnaire de fichier : récupérer la liste des fichiers échangés /api/files...
//---------------------------------------------------------------------

// Endpoint pour récupérer la liste des fichiers échangés entre deux utilisateurs
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const { senderId, recipientId } = req.query;
    if (!senderId || !recipientId) {
      return res.status(400).json({ error: 'Les paramètres senderId et recipientId sont requis.' });
    }
    const filesCollection = db.collection('sharedFiles');
    
    // Supposons que vous ajoutez un champ "deleted" lors de la suppression, et qu'il vaut false par défaut.
    const q1 = query(
      filesCollection,
      where('senderId', '==', senderId),
      where('receiverId', '==', recipientId),
      where('deleted', '==', false)
    );
    const q2 = query(
      filesCollection,
      where('senderId', '==', recipientId),
      where('receiverId', '==', senderId),
      where('deleted', '==', false)
    );
    
    let results = [];
    const snapshot1 = await getDocs(q1);
    snapshot1.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
    const snapshot2 = await getDocs(q2);
    snapshot2.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
    
    results.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
    return res.json(results);
  } catch (error) {
    console.error("Erreur dans /api/files :", error);
    res.status(500).json({ error: error.message });
  }
});


//---------------------------------------------------------------------
// ROUTE 10 : Gestionnaire de fichier : suppression des fichiers /api/files...
//---------------------------------------------------------------------

// Endpoint pour supprimer un fichier (via son ID Firestore)
app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    if (!fileId) {
      return res.status(400).json({ error: "L'ID du fichier est requis." });
    }
    
    // Récupérer le document Firestore correspondant
    const fileDocRef = doc(db, 'sharedFiles', fileId);
    const fileDocSnap = await getDoc(fileDocRef);
    if (!fileDocSnap.exists()) {
      return res.status(404).json({ error: "Document introuvable." });
    }
    const fileData = fileDocSnap.data();
    
    // Supprimer le fichier de Storage
    // On suppose que le champ fileUrl contient l'URL du fichier dans Storage
    // Pour obtenir le chemin, vous pouvez extraire la partie après le bucket, par exemple :
    const filePath = fileData.fileUrl.split(`https://storage.googleapis.com/${bucket.name}/`)[1];
    if (filePath) {
      await bucket.file(filePath).delete();
      console.log("Fichier supprimé du Storage :", filePath);
    }
    
    // Mettre à jour le document Firestore pour marquer le fichier comme supprimé
    await updateDoc(fileDocRef, { deleted: true });
    
    // Émettre un événement Socket.io pour actualiser la liste côté client
    io.emit('newFile', { deleted: true, id: fileId });
    
    return res.json({ success: true });
  } catch (error) {
    console.error("Erreur lors de la suppression du fichier :", error);
    res.status(500).json({ error: error.message });
  }
});





// 5) Lancement
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur Node.js + Socket.io démarré sur le port ${PORT}`);
});
