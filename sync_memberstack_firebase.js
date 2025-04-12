// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

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

const db = admin.firestore();

router.use(express.json());

/**
 * Endpoint pour traiter les webhooks MemberStack.
 * L'URL doit être configurée dans MemberStack comme :
 * https://messagerie-railway-production-4894.up.railway.app/api/webhook/memberstack
 *
 * Exemple de payload pour member.updated incluant profileImage :
 * {
 *   "event": "member.updated",
 *   "payload": {
 *      "auth": { "email": "gfgnfnf@gmail.com" },
 *      "customFields": {
 *         "adresse": "11 rue de Médicis",
 *         "code-postal": "63000",
 *         "first-name": "rfgnfgn",
 *         "last-name": "fgnfnfgnf",
 *         "phone": "0787097135",
 *         "ville": "Clermont-Ferrand"
 *      },
 *      "id": "mem_cm9ehhh2j0nav0wsrg4c5gmlz",
 *      "metaData": {},
 *      "profileImage": "https://ms-application-assets.s3.amazonaws.com/member-profile-images/1744478575046Starship_SpaceX.jpg",
 *      "stripeCustomerId": null,
 *      "verified": false
 *   },
 *   "reason": ["customFields.updated"],
 *   "timestamp": 1744478582757
 * }
 */
router.post('/memberstack', async (req, res) => {
  try {
    const event = req.body.event;
    const payload = req.body.payload;
    
    console.log("Webhook reçu. event =", event, " payload =", JSON.stringify(payload, null, 2));

    if (!event || !payload || (!payload.id && !(payload.member && payload.member.id))) {
      console.error("Payload invalide :", req.body);
      return res.status(400).send("Payload invalide");
    }
    
    
    // Récupération de l'email : soit dans payload.auth.email, soit dans payload.email
    const email = (payload.auth && payload.auth.email) ? payload.auth.email : payload.email;
    
    // Lecture du document existant ou création d'un objet vide
    const userDocData = await (async () => {
      const docRef = db.collection('users').doc(payload.id);
      const snap = await docRef.get();
      return snap.exists ? snap.data() : {};
    })();
    
    // Mise à jour des champs de base à partir du payload (si disponibles)
    if (email) {
      userDocData.email = email;
    }
    
    // Mise à jour des custom fields
    if (payload.customFields) {
      if (payload.customFields["adresse"] || payload.customFields["Adresse"])
        userDocData.Adresse = payload.customFields["adresse"] || payload.customFields["Adresse"];
      if (payload.customFields["code-postal"] || payload.customFields["Code postal"])
        userDocData.CodePostal = payload.customFields["code-postal"] || payload.customFields["Code postal"];
      if (payload.customFields["first-name"] || payload.customFields["Prénom"])
        userDocData.Prenom = payload.customFields["first-name"] || payload.customFields["Prénom"];
      if (payload.customFields["last-name"] || payload.customFields["Nom"])
        userDocData.Nom = payload.customFields["last-name"] || payload.customFields["Nom"];
      if (payload.customFields["phone"] || payload.customFields["Phone"])
        userDocData.Phone = payload.customFields["phone"] || payload.customFields["Phone"];
      if (payload.customFields["ville"] || payload.customFields["Ville"])
        userDocData.Ville = payload.customFields["ville"] || payload.customFields["Ville"];
      // Vous pouvez ajouter ici d'autres champs custom si nécessaire.
    }
    
    // Mise à jour du champ profileImage (s'il est présent)
    if (payload.profileImage) {
      userDocData.profileImage = payload.profileImage;
    }
    
    /**
     * Traitement en fonction de l'événement
     */
    if (["member.created", "member.updated"].includes(event)) {
      // Pour member.created ou member.updated, si le payload inclut un tableau planConnections,
      // nous le copions directement dans userDocData.plans.
      if (payload.planConnections) {
        userDocData.plans = payload.planConnections;
      }
      // Mise à jour ou création du document dans Firestore
      await db.collection('users').doc(payload.id).set(userDocData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${payload.id} via l'événement ${event}`);
    } else if (event === "member.plan.added") {
      // Lorsqu'un plan est ajouté, on s'assure de mettre à jour les informations de base puis on ajoute le nouveau plan
      await db.collection('users').doc(payload.member.id).set(userDocData, { merge: true });
      if (payload.planConnection) {
        // Fonction utilitaire définie ci-dessous pour ajouter le plan dans le tableau
        await addPlanConnection(payload.member.id, payload.planConnection);
        console.log(`Plan ajouté pour le membre ${payload.member.id}`);
      }
    } else if (event === "member.plan.updated") {
      await db.collection('users').doc(payload.member.id).set(userDocData, { merge: true });
      if (payload.planConnection) {
        await updatePlanConnection(payload.member.id, payload.planConnection);
        console.log(`Plan mis à jour pour le membre ${payload.member.id}`);
      } else if (payload.prevPlanConnection) {
        await updatePlanConnection(payload.member.id, payload.prevPlanConnection);
        console.log(`Plan (prev) mis à jour pour le membre ${payload.member.id}`);
      }
    } else if (event === "member.plan.canceled") {
      await db.collection('users').doc(payload.member.id).set(userDocData, { merge: true });
      if (payload.planConnection) {
        await removePlanConnection(payload.member.id, payload.planConnection);
        console.log(`Plan annulé pour le membre ${payload.member.id}`);
      }
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

/**
 * Fonction utilitaire : Ajoute une planConnection au tableau 'plans'
 */
async function addPlanConnection(memberId, planConnection) {
  const userData = await getUserData(memberId);
  const existingPlans = userData.plans || [];
  existingPlans.push(planConnection);
  await db.collection('users').doc(memberId).set({ plans: existingPlans }, { merge: true });
}

/**
 * Fonction utilitaire : Met à jour une planConnection existante dans le tableau 'plans'
 */
async function updatePlanConnection(memberId, updatedPlan) {
  const userData = await getUserData(memberId);
  const existingPlans = userData.plans || [];
  const index = existingPlans.findIndex(p => 
    (p.planConnectionId && p.planConnectionId === updatedPlan.planConnectionId) ||
    (p.planId && p.planId === updatedPlan.planId)
  );
  if (index >= 0) {
    existingPlans[index] = { ...existingPlans[index], ...updatedPlan };
  } else {
    existingPlans.push(updatedPlan);
  }
  await db.collection('users').doc(memberId).set({ plans: existingPlans }, { merge: true });
}

/**
 * Fonction utilitaire : Supprime une planConnection du tableau 'plans'
 */
async function removePlanConnection(memberId, planConnection) {
  const userData = await getUserData(memberId);
  let existingPlans = userData.plans || [];
  existingPlans = existingPlans.filter(p => 
    !((p.planConnectionId && p.planConnectionId === planConnection.planConnectionId) ||
      (p.planId && p.planId === planConnection.planId))
  );
  await db.collection('users').doc(memberId).set({ plans: existingPlans }, { merge: true });
}

/**
 * Fonction utilitaire : Récupère les données utilisateur ou un objet vide
 */
async function getUserData(memberId) {
  const doc = await db.collection('users').doc(memberId).get();
  return doc.exists ? doc.data() : {};
}

module.exports = { router };
