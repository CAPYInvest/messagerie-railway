// sync_memberstack_firebase.js
const { Webhook } = require("svix");
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const crypto = require('crypto');


// ... Init Firebase Admin etc. ...
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

// On n'utilise plus verifySignature(...) au sens HMAC simple :
router.post('/memberstack', async (req, res) => {
  try {
    // corps brut
    const rawBody = req.rawBody;
    // en-têtes complets
    const headers = req.headers;

    // On récupère la clé secrète
    const msSigningSecret = process.env.MS_SIGNING_SECRET;
    if (!msSigningSecret) {
      console.error("MS_SIGNING_SECRET non définie");
      return res.status(500).send("Configuration serveur incomplète");
    }

    // On prépare le webhook verifier de Svix
    const wh = new Webhook(msSigningSecret);

    let event;
    try {
      // La méthode verify va lever une exception si la signature ne correspond pas
      event = wh.verify(rawBody, headers);
      // event contient alors le JSON parsé : event.event, event.payload, etc.
    } catch (err) {
      console.error("Signature Svix invalide :", err.message);
      return res.status(401).send("Signature invalide");
    }

    // Extractions
    const type = event.event;      // ex: "member.created"
    const data = event.payload;    // ex: { auth: {...}, customFields: {...}, id: "...", ... }

    if (!type || !data || !data.id) {
      return res.status(400).send("Payload invalide");
    }

    // Ensuite, on traite comme avant :
    if (["member.created", "member.updated", "member.plan.added", "member.plan.updated"].includes(type)) {
      const email = data.auth?.email || data.email;
      if (!email) {
        return res.status(400).send("Email manquant");
      }

      // Récupération / Mapping
      const userData = {
        email,
        Adresse: data.customFields?.["Adresse"] || null,
        CodePostal: data.customFields?.["Code postal"] || null,
        Nom: data.customFields?.["Nom"] || null,
        Prenom: data.customFields?.["Prénom"] || null,
        Phone: data.customFields?.["Phone"] || null,
        Conseiller: data.customFields?.["Conseiller"] || null,
        Ville: data.customFields?.["Ville"] || null,
        plans: data.planConnections || null,
      };

      await db.collection('users').doc(data.id).set(userData, { merge: true });
      console.log(`Synchronisation OK pour le membre ${data.id} via ${type}`);
    } else if (type === "member.deleted") {
      await db.collection('users').doc(data.id).delete();
      console.log(`Membre ${data.id} supprimé`);
    } else {
      console.log(`Événement non géré : ${type}`);
    }

    // on répond 200
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
