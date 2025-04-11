// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('firebase-admin');

// Initialisation de Firebase Admin (si non déjà faite) avec la configuration issue de la variable d'environnement Railway
if (!admin.apps.length) {
  console.warn("Firebase Admin n'était pas initialisé. Initialisation depuis les variables d'environnement.");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}

// Initialisation de Firestore
const db = admin.firestore();

// Récupération de la clé API Memberstack depuis l'environnement
const API_KEY = process.env.MEMBERSTACK_SECRET_KEY || process.env.MEMBERSTACK_SECRET;
if (!API_KEY) {
  throw new Error('La clé API Memberstack n\'est pas définie dans les variables d\'environnement.');
}

// Création d'une instance Axios configurée pour l'API Memberstack
const memberstackClient = axios.create({
  baseURL: 'https://admin.memberstack.com', // URL de base selon la doc officielle de Memberstack
  headers: {
    'X-API-KEY': API_KEY,
    'Content-Type': 'application/json'
  }
});

// Intercepteur pour gérer notamment les erreurs (ex. rate limiting)
memberstackClient.interceptors.response.use(
  response => response,
  async error => {
    if (error.response && error.response.status === 429) {
      console.log('Taux de requêtes dépassé (429). Nouvelle tentative après délai...');
      await new Promise(resolve => setTimeout(resolve, 2000)); // attente de 2 secondes avant réessai
      return memberstackClient.request(error.config);
    }
    console.error('Erreur lors de l\'appel à l\'API Memberstack :', {
      status: error.response?.status,
      url: error.config?.url,
      method: error.config?.method
    });
    return Promise.reject(error);
  }
);

// Middleware pour interpréter le corps en JSON
router.use(express.json());

/**
 * Endpoint POST déclenché lors d'une inscription.
 * Il reçoit les données du formulaire, récupère les infos complètes via l'API Memberstack (si possible),
 * puis enregistre/actualise ces données dans Firestore.
 */
router.post('/sync/member', async (req, res) => {
  try {
    const memberData = req.body;

    // Vérification minimale : l'email est requis.
    if (!memberData.email) {
      return res.status(400).send('Email obligatoire pour la synchronisation.');
    }

    let memberFromApi = null;
    if (memberData.id) {
      // Si un identifiant de membre est fourni, on tente de récupérer les infos complètes via l'API
      const response = await memberstackClient.get(`/members/${memberData.id}`);
      memberFromApi = response.data;
    } else {
      // Sinon, nous utilisons directement les données reçues
      memberFromApi = memberData;
    }

    // Vérification que les données essentielles sont présentes
    if (!memberFromApi.id || !memberFromApi.email) {
      return res.status(400).send('Données incomplètes pour la synchronisation.');
    }

    // Mise à jour ou création du document dans la collection Firestore 'users'
    await db.collection('users').doc(memberFromApi.id).set({
      email: memberFromApi.email,
      customFields: memberFromApi.customFields || {}
    }, { merge: true });

    console.log(`Synchronisation réussie pour le membre ${memberFromApi.id}`);
    res.status(200).json({ message: 'Synchronisation effectuée.' });
  } catch (error) {
    console.error('Erreur lors de la synchronisation du membre :', error);
    res.status(500).send('Erreur lors de la synchronisation.');
  }
});

/**
 * Endpoint GET pour une synchronisation globale de tous les membres.
 * Accessible via : https://messagerie-railway-production-4894.up.railway.app/api/sync/members
 */
router.get('/sync/members', async (req, res) => {
  try {
    const response = await memberstackClient.get('/members');
    const members = response.data.members;
    if (!members || !Array.isArray(members)) {
      return res.status(500).send('Format de réponse invalide depuis l\'API Memberstack.');
    }

    for (const member of members) {
      if (!member.id || !member.email) {
        console.warn('Membre ignoré en raison de données incomplètes :', member);
        continue;
      }
      await db.collection('users').doc(member.id).set({
        email: member.email,
        customFields: member.customFields || {}
      }, { merge: true });
    }

    console.log(`Synchronisation globale effectuée pour ${members.length} membres.`);
    res.send(`Synchronisation globale effectuée pour ${members.length} membres.`);
  } catch (error) {
    console.error('Erreur lors de la synchronisation globale :', error);
    res.status(500).send('Erreur lors de la synchronisation globale.');
  }
});

module.exports = { router };
