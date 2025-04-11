// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const { Webhook } = require('svix');
const admin = require('firebase-admin');

// Initialisation de Firebase Admin si ce n'est pas déjà fait
if (!admin.apps.length) {
  console.warn("Initialisation de Firebase Admin depuis le module webhook.");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Corriger le format de la clé privée
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}

// Accès à Firestore
const db = admin.firestore();

/**
 * Endpoint POST pour recevoir les webhooks MemberStack.
 * L'URL configurée dans MemberStack doit être :
 * https://messagerie-railway-production-4894.up.railway.app/api/webhook/memberstack
 */
router.post('/memberstack', async (req, res) => {
  try {
    // Récupération du corps brut et des headers
    const rawBody = req.rawBody;
    const headers = req.headers;
    
    // Debug : afficher les headers reçus
    console.log("Headers reçus :", headers);
    console.log("Corps brut reçu :", rawBody);

    // Récupérer le secret depuis la variable d'environnement
    const msSigningSecret = process.env.MS_SIGNING_SECRET;
    if (!msSigningSecret) {
      console.error("MS_SIGNING_SECRET non définie dans les variables d'environnement.");
      return res.status(500).send("Configuration serveur incomplète");
    }

    // Initialisation du vérificateur de webhook Svix
    const wh = new Webhook(msSigningSecret);

    let event;
    try {
      // Remarquez que la librairie svix extrait la signature dans l'en-tête "svix-signature"
      event = wh.verify(rawBody, headers);
    } catch (err) {
      console.error("Erreur lors de la vérification de la signature Svix :", err.message);
      return res.status(401).send("Signature invalide");
    }

    // event contient la propriété 'event' (type d'événement) et 'payload'
    const type = event.event;
    const data = event.payload;
    if (!type || !data || !data.id) {
      return res.status(400).send("Payload invalide");
    }

    // Extraction de l'email : si disponible dans data.auth.email, sinon data.email
    const email = (data.auth && data.auth.email) ? data.auth.email : data.email;
    if (["member.created", "member.updated", "member.plan.added", "member.plan.updated"].includes(type)) {
      if (!email) {
        return res.status(400).send("Email manquant dans le payload");
      }

      // Préparation des données utilisateur à enregistrer dans Firestore
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

      // Synchronisation dans Firestore (création ou mise à jour du document)
      await db.collection('users').doc(data.id).set(userData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${data.id} via l'événement ${type}`);
    } else if (type === "member.deleted") {
      // Suppression du document correspondant dans Firestore
      await db.collection('users').doc(data.id).delete();
      console.log(`Membre ${data.id} supprimé via l'événement ${type}`);
    } else {
      console.log(`Événement non géré : ${type}`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
