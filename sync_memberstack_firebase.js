// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// Initialisation de Firebase Admin si ce n'est pas déjà fait
if (!admin.apps.length) {
  console.warn("Initialisation de Firebase Admin depuis le module webhook.");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Correction du format de la clé privée
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}

// Accès à Firestore
const db = admin.firestore();

// Middleware pour s'assurer que le corps de la requête est traité en JSON (déjà appliqué globalement dans server.js)
router.use(express.json());

/**
 * Endpoint POST pour recevoir les webhooks MemberStack.
 * L'URL de configuration dans MemberStack doit pointer vers :
 * https://messagerie-railway-production-4894.up.railway.app/api/webhook/memberstack
 */
router.post('/memberstack', async (req, res) => {
  try {
    // Extraction de l'événement et du payload
    const event = req.body.event;
    const payload = req.body.payload;
    
    // Journalisation complète pour le debugging
    console.log("Payload complet reçu :", JSON.stringify(req.body, null, 2));
    console.log("Payload customFields :", JSON.stringify(payload.customFields, null, 2));

    if (!event || !payload || !payload.id) {
      console.error("Payload invalide :", req.body);
      return res.status(400).send("Payload invalide");
    }
    
    // Récupération de l'e-mail : soit payload.auth.email, sinon payload.email
    const email = (payload.auth && payload.auth.email) ? payload.auth.email : payload.email;
    
    // Préparation de l'objet à enregistrer dans Firestore. 
    // On gère les variations en vérifiant d'abord la version "standard" puis celle en minuscules avec tiret (ou sans espace).
    const userData = {
      email: email,
      Adresse: payload.customFields 
                ? (payload.customFields["Adresse"] || payload.customFields["adresse"] || null)
                : null,
      CodePostal: payload.customFields 
                   ? (payload.customFields["Code postal"] || payload.customFields["code-postal"] || null)
                   : null,
      Nom: payload.customFields 
             ? (payload.customFields["Nom"] || payload.customFields["last-name"] || null)
             : null,
      Prenom: payload.customFields 
                ? (payload.customFields["Prénom"] || payload.customFields["first-name"] || null)
                : null,
      Phone: payload.customFields 
               ? (payload.customFields["Phone"] || payload.customFields["phone"] || null)
               : null,
      Conseiller: payload.customFields 
                    ? (payload.customFields["Conseiller"] || payload.customFields["conseiller"] || null)
                    : null,
      Ville: payload.customFields 
               ? (payload.customFields["Ville"] || payload.customFields["ville"] || null)
               : null,
      plans: payload.planConnections || null
    };

    if (["member.created", "member.updated", "member.plan.added", "member.plan.updated"].includes(event)) {
      if (!email) {
        console.error("Email manquant dans le payload :", payload);
        return res.status(400).send("Email manquant dans le payload");
      }
      // Mise à jour (ou création) du document dans Firestore, identifié par payload.id
      await db.collection('users').doc(payload.id).set(userData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${payload.id} via l'événement ${event}`);
    } else if (event === "member.deleted") {
      await db.collection('users').doc(payload.id).delete();
      console.log(`Membre ${payload.id} supprimé via l'événement ${event}`);
    } else {
      console.log(`Événement non géré : ${event}`);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
