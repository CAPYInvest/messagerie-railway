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
    // Vérification simple du token webhook via l'en-tête "x-webhook-token"
    const token = req.headers['x-webhook-token'];
    if (process.env.MS_WEBHOOK_TOKEN && token !== process.env.MS_WEBHOOK_TOKEN) {
      console.error("Token webhook invalide");
      return res.status(401).send('Unauthorized: token invalid');
    }
    
    // Extraction de l'événement et du payload depuis le corps de la requête
    const event = req.body.event;
    const payload = req.body.payload;
    if (!event || !payload || !payload.id) {
      console.error("Payload invalide :", req.body);
      return res.status(400).send("Payload invalide");
    }
    
    // Récupération de l'e-mail : soit dans payload.auth.email, soit dans payload.email
    const email = (payload.auth && payload.auth.email) ? payload.auth.email : payload.email;
    
    // Préparation de l'objet utilisateur à enregistrer dans Firestore. Pour les custom fields, on prend en compte ces 7 champs.
    const userData = {
      email: email,
      Adresse: payload.customFields && payload.customFields["Adresse"] ? payload.customFields["Adresse"] : null,
      CodePostal: payload.customFields && payload.customFields["Code postal"] ? payload.customFields["Code postal"] : null,
      // Si "Nom" n'est pas défini, on peut utiliser "last-name" s'il existe, et pareil pour "Prénom" avec "first-name".
      Nom: payload.customFields && payload.customFields["Nom"] ? payload.customFields["Nom"] : (payload.customFields && payload.customFields["last-name"] ? payload.customFields["last-name"] : null),
      Prenom: payload.customFields && payload.customFields["Prénom"] ? payload.customFields["Prénom"] : (payload.customFields && payload.customFields["first-name"] ? payload.customFields["first-name"] : null),
      Phone: payload.customFields && payload.customFields["Phone"] ? payload.customFields["Phone"] : null,
      Conseiller: payload.customFields && payload.customFields["Conseiller"] ? payload.customFields["Conseiller"] : null,
      Ville: payload.customFields && payload.customFields["Ville"] ? payload.customFields["Ville"] : null,
      plans: payload.planConnections || null
    };

    // Traitement selon l'événement
    if (["member.created", "member.updated", "member.plan.added", "member.plan.updated"].includes(event)) {
      if (!email) {
        console.error("Email manquant dans le payload :", payload);
        return res.status(400).send("Email manquant dans le payload");
      }
      // Création ou mise à jour du document dans Firestore avec l'ID du membre
      await db.collection('users').doc(payload.id).set(userData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${payload.id} via l'événement ${event}`);
    } else if (event === "member.deleted") {
      // Suppression du document correspondant dans Firestore
      await db.collection('users').doc(payload.id).delete();
      console.log(`Membre ${payload.id} supprimé via l'événement ${event}`);
    } else {
      console.log(`Événement non géré : ${event}`);
    }
    
    // Réponse 200 pour indiquer que le webhook a été traité avec succès
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
