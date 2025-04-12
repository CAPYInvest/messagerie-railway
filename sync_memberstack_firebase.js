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

router.post('/memberstack', async (req, res) => {
  try {
    const event = req.body.event;
    const payload = req.body.payload;
    
    console.log("Webhook reçu. event =", event, " payload =", JSON.stringify(payload, null, 2));

    if (!event || !payload) {
      console.error("Payload invalide :", req.body);
      return res.status(400).send("Payload invalide");
    }
    
    // Extraction de l'ID membre et de l'email.
    let memberId = null;
    let email = null;
    
    if (payload.id) {
      memberId = payload.id;
      email = payload.auth && payload.auth.email ? payload.auth.email : payload.email;
    }
    if (!memberId && payload.member && payload.member.id) {
      memberId = payload.member.id;
      email = payload.member.email;
    }

    // Vérification renforcée : on doit disposer d'un ID non vide.
    if (!memberId || typeof memberId !== 'string' || memberId.trim() === "") {
      console.error("ID du membre invalide :", memberId, "Payload :", JSON.stringify(payload, null, 2));
      return res.status(400).send("Impossible de déterminer l'ID du membre");
    }
    
    // Pour la mise à jour des champs de base et des custom fields
    const userDocData = await (async () => {
      const docRef = db.collection('users').doc(memberId);
      const snap = await docRef.get();
      return snap.exists ? snap.data() : {};
    })();
    
    if (email) {
      userDocData.email = email;
    }
    
    // Mise à jour des custom fields (adaptation selon vos structures)
    if (payload.customFields) {
      userDocData.Adresse = payload.customFields["Adresse"] || payload.customFields["adresse"] || null;
      userDocData.CodePostal = payload.customFields["Code postal"] || payload.customFields["code-postal"] || null;
      userDocData.Prenom = payload.customFields["Prénom"] || payload.customFields["first-name"] || null;
      userDocData.Nom = payload.customFields["Nom"] || payload.customFields["last-name"] || null;
      userDocData.Phone = payload.customFields["Phone"] || payload.customFields["phone"] || null;
      userDocData.Ville = payload.customFields["Ville"] || payload.customFields["ville"] || null;
      // Vous pouvez ajouter d'autres champs personnalisés ici si besoin.
    }
    
    // Prise en compte du lien de l'image de profil
    if (payload.profileImage) {
      userDocData.profileImage = payload.profileImage;
    }
    
    // Traitement par type d'événement
    if (["member.created", "member.updated"].includes(event)) {
      // Pour les événements de base, on remplace éventuellement le tableau plans si présent
      if (payload.planConnections) {
        userDocData.plans = payload.planConnections;
      }
      await db.collection('users').doc(memberId).set(userDocData, { merge: true });
      console.log(`Synchronisation réussie pour le membre ${memberId} via l'événement ${event}`);
    } else if (event === "member.plan.added") {
      await db.collection('users').doc(memberId).set(userDocData, { merge: true });
      if (payload.planConnection) {
        await addPlanConnection(memberId, payload.planConnection);
      }
      console.log(`Plan ajouté pour le membre ${memberId}`);
    } else if (event === "member.plan.updated") {
      await db.collection('users').doc(memberId).set(userDocData, { merge: true });
      if (payload.planConnection) {
        await updatePlanConnection(memberId, payload.planConnection);
      } else if (payload.prevPlanConnection) {
        await updatePlanConnection(memberId, payload.prevPlanConnection);
      }
      console.log(`Plan mis à jour pour le membre ${memberId}`);
    } else if (event === "member.plan.canceled") {
      await db.collection('users').doc(memberId).set(userDocData, { merge: true });
      if (payload.planConnection) {
        await removePlanConnection(memberId, payload.planConnection);
      }
      console.log(`Plan annulé pour le membre ${memberId}`);
    } else if (event === "member.deleted") {
      await db.collection('users').doc(memberId).delete();
      console.log(`Membre ${memberId} supprimé via l'événement ${event}`);
    } else {
      console.log(`Événement non géré : ${event}`);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur lors du traitement du webhook MemberStack :", error);
    res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

// Fonctions utilitaires pour gérer le tableau "plans"
async function getUserData(memberId) {
  const docRef = db.collection('users').doc(memberId);
  const snap = await docRef.get();
  return snap.exists ? snap.data() : {};
}

async function addPlanConnection(memberId, planConnection) {
  const userData = await getUserData(memberId);
  const existingPlans = userData.plans || [];
  existingPlans.push(planConnection);
  await db.collection('users').doc(memberId).set({ plans: existingPlans }, { merge: true });
}

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

async function removePlanConnection(memberId, planConnection) {
  const userData = await getUserData(memberId);
  let existingPlans = userData.plans || [];
  existingPlans = existingPlans.filter(p => 
    !((p.planConnectionId && p.planConnectionId === planConnection.planConnectionId) ||
      (p.planId && p.planId === planConnection.planId))
  );
  await db.collection('users').doc(memberId).set({ plans: existingPlans }, { merge: true });
}

module.exports = { router };
