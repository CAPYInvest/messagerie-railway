// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialisation de Firebase Admin si ce n'est pas déjà fait
if (!admin.apps.length) {
  console.warn("Initialisation de Firebase Admin depuis le module webhook.");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Correction du format de la clé privée
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}

// Accès à Firestore
const db = admin.firestore();

/**
 * Fonction pour vérifier la signature du webhook.
 * @param {string} rawBody - Le corps brut de la requête.
 * @param {string} signatureHeader - La signature reçue dans l'en-tête.
 * @param {string} secret - Le Signing Secret fourni par MemberStack.
 * @returns {boolean} - Vrai si la signature est valide, faux sinon.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  return computedSignature === signatureHeader;
}

// Middleware pour s'assurer que le corps de la requête est traité en JSON
router.use(express.json());

router.post('/memberstack', async (req, res) => {
  try {
    // Récupération du corps brut
    const rawBody = req.rawBody;
    // Récupérer la signature depuis l'en-tête (ajustez le nom de l'en-tête selon la doc MemberStack)
    const signatureHeader = req.headers['x-membersignature'];
    if (!signatureHeader) {
      return res.status(401).send('Signature manquante');
    }

    // Vérification de la signature avec le Signing Secret
    const msSigningSecret = process.env.MS_SIGNING_SECRET;
    if (!msSigningSecret) {
      console.error("MS_SIGNING_SECRET non définie dans les variables d'environnement.");
      return res.status(500).send("Configuration serveur incomplète");
    }
    if (!verifySignature(rawBody, signatureHeader, msSigningSecret)) {
      return res.status(401).send('Signature invalide');
    }

    // Extraction du payload JSON
    const { event, data } = req.body;
    if (!event || !data || !data.id) {
      return res.status(400).send("Payload invalide");
    }

    // Traitement selon le type d'événement
    if (['member.created', 'member.updated', 'member.plan.added', 'member.plan.updated'].includes(event)) {
      if (!data.email) {
        return res.status(400).send("Email manquant dans le payload");
      }

      // Construction des données utilisateur à mettre à jour dans Firestore
      const userData = {
        email: data.email,
        Adresse: data.customFields && data.customFields["Adresse"] ? data.customFields["Adresse"] : null,
        CodePostal: data.customFields && data.customFields["Code postal"] ? data.customFields["Code postal"] : null,
        Nom: data.customFields && data.customFields["Nom"] ? data.customFields["Nom"] : null,
        Prenom: data.customFields && data.customFields["Prénom"] ? data.customFields["Prénom"] : null,
        Phone: data.customFields && data.customFields["Phone"] ? data.customFields["Phone"] : null,
        Conseiller: data.customFields && data.customFields["Conseiller"] ? data.customFields["Conseiller"] : null,
        Ville: data.customFields && data.customFields["Ville"] ? data.customFields["Ville"] : null,
        plans: data.plans || null  // Met à jour le champ plans selon le payload
      };

      // Mise à jour (ou création) du document dans la collection 'users'
      await db.collection('users').doc(data.id).set(userData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${data.id} via l'événement ${event}`);
    } else if (event === 'member.deleted') {
      // Suppression du document correspondant dans Firestore
      await db.collection('users').doc(data.id).delete();
      console.log(`Membre ${data.id} supprimé via l'événement ${event}`);
    } else {
      console.log(`Événement non géré : ${event}`);
    }

    // Répondre avec succès à MemberStack
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
