// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const admin = require('firebase-admin');

// Initialisation de Firebase Admin s'il n'est pas déjà fait
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
 * Vérifie la signature HMAC-SHA256 du webhook.
 * @param {string} rawBody - Le corps brut de la requête.
 * @param {string} signatureHeader - La signature reçue dans l'en-tête.
 * @param {string} secret - Le Signing Secret MemberStack.
 * @returns {boolean} - Vrai si la signature est valide, faux sinon.
 */
function verifySignature(rawBody, signatureHeader, secret) {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  return computedSignature === signatureHeader;
}

// Note : Nous ne réappliquons pas express.json() ici pour ne pas écraser req.rawBody

/**
 * Endpoint POST pour recevoir les webhooks MemberStack.
 * L'URL de configuration dans MemberStack devra être :
 * https://votre-domaine/api/webhook/memberstack
 */
router.post('/memberstack', async (req, res) => {
  try {
    // Récupération du corps brut
    const rawBody = req.rawBody;
    // Récupération de la signature dans l'en-tête (ajustez le nom si nécessaire)
    const signatureHeader = req.headers['x-membersignature'];
    if (!signatureHeader) {
      return res.status(401).send('Signature manquante');
    }

    // Vérification de la signature à l'aide du Signing Secret
    const msSigningSecret = process.env.MS_SIGNING_SECRET;
    if (!msSigningSecret) {
      console.error("MS_SIGNING_SECRET non définie dans les variables d'environnement.");
      return res.status(500).send("Configuration serveur incomplète");
    }
    if (!verifySignature(rawBody, signatureHeader, msSigningSecret)) {
      return res.status(401).send('Signature invalide');
    }

    // Extraction de l'événement et des données depuis le payload
    // Certains webhooks utilisent "payload", d'autres "data"
    const { event } = req.body;
    const data = req.body.payload || req.body.data;
    if (!event || !data || !data.id) {
      return res.status(400).send("Payload invalide");
    }

    // Récupérer l'email : s'il se trouve dans data.auth.email (comme dans vos logs), sinon dans data.email
    const email = (data.auth && data.auth.email) ? data.auth.email : data.email;

    // Selon l'événement, on effectue la synchronisation
    if (['member.created', 'member.updated', 'member.plan.added', 'member.plan.updated'].includes(event)) {
      if (!email) {
        return res.status(400).send("Email manquant dans le payload");
      }

      // Construction de l'objet utilisateur à enregistrer dans Firestore
      const userData = {
        email: email,
        Adresse: data.customFields && data.customFields["Adresse"] ? data.customFields["Adresse"] : null,
        CodePostal: data.customFields && data.customFields["Code postal"] ? data.customFields["Code postal"] : null,
        Nom: data.customFields && data.customFields["Nom"] ? data.customFields["Nom"] : null,
        Prenom: data.customFields && data.customFields["Prénom"] ? data.customFields["Prénom"] : null,
        Phone: data.customFields && data.customFields["Phone"] ? data.customFields["Phone"] : null,
        Conseiller: data.customFields && data.customFields["Conseiller"] ? data.customFields["Conseiller"] : null,
        Ville: data.customFields && data.customFields["Ville"] ? data.customFields["Ville"] : null,
        plans: data.planConnections || null
      };

      // Mise à jour (ou création) du document dans Firestore (collection "users")
      await db.collection('users').doc(data.id).set(userData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${data.id} via l'événement ${event}`);
    } else if (event === 'member.deleted') {
      // Suppression du document correspondant dans Firestore
      await db.collection('users').doc(data.id).delete();
      console.log(`Membre ${data.id} supprimé via l'événement ${event}`);
    } else {
      console.log(`Événement non géré : ${event}`);
    }

    // Répondre avec succès
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
