// sync_memberstack_firebase.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

if (!admin.apps.length) {
  console.warn("Initialisation de Firebase Admin depuis le module webhook.");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}

const db = admin.firestore();

// Middleware JSON (déjà fait dans server.js, mais on le laisse par sécurité)
router.use(express.json());

/** 
 * Fonctions utilitaires pour gérer le tableau "plans" dans Firestore
 */

// Lit le document utilisateur, retourne l'objet data ou {} s'il n'existe pas
async function getUserData(userId) {
  const ref = db.collection('users').doc(userId);
  const snap = await ref.get();
  return snap.exists ? snap.data() : {};
}

// Remplace intégralement le tableau plans par planConnections
async function setPlansFull(userId, planConnections) {
  const ref = db.collection('users').doc(userId);
  await ref.set({ plans: planConnections }, { merge: true });
}

// Ajoute une nouvelle planConnection au tableau "plans"
async function addPlanConnection(userId, planConnection) {
  const userDoc = await getUserData(userId);
  const existingPlans = userDoc.plans || [];

  // On pourrait vérifier si le planConnection existe déjà. 
  // Pour faire simple, on l'ajoute en doublon si c'est la même planId, 
  // à adapter selon la logique souhaitée.
  existingPlans.push(planConnection);

  await db.collection('users').doc(userId).set({ plans: existingPlans }, { merge: true });
}

// Met à jour un plan existant dans le tableau "plans" (ex. si status a changé)
async function updatePlanConnection(userId, updatedPlanConnection) {
  const userDoc = await getUserData(userId);
  const existingPlans = userDoc.plans || [];

  // On tente de trouver l'index correspondant par planId ou planConnectionId
  // Adaptez la clé de recherche selon votre logique (planId ? planConnectionId ?)
  const planIndex = existingPlans.findIndex(
    p => (p.planConnectionId && p.planConnectionId === updatedPlanConnection.planConnectionId)
      || (p.planId && p.planId === updatedPlanConnection.planId)
  );

  if (planIndex >= 0) {
    // On fusionne l'ancien plan et le nouveau
    existingPlans[planIndex] = { 
      ...existingPlans[planIndex], 
      ...updatedPlanConnection 
    };
  } else {
    // Si on ne trouve pas le plan, on l'ajoute 
    existingPlans.push(updatedPlanConnection);
  }

  await db.collection('users').doc(userId).set({ plans: existingPlans }, { merge: true });
}

// Supprime (ou marque comme annulé) un plan dans le tableau "plans"
async function removePlanConnection(userId, planConnection) {
  const userDoc = await getUserData(userId);
  let existingPlans = userDoc.plans || [];

  // On identifie le plan à enlever sur un critère (planConnectionId, planId, etc.)
  existingPlans = existingPlans.filter(
    p => !(
      (p.planConnectionId && p.planConnectionId === planConnection.planConnectionId)
      || (p.planId && p.planId === planConnection.planId)
    )
  );

  await db.collection('users').doc(userId).set({ plans: existingPlans }, { merge: true });
}

/**
 * Endpoint pour traiter les webhooks de MemberStack
 * URL configurée dans MemberStack : /api/webhook/memberstack
 */
router.post('/memberstack', async (req, res) => {
  try {
    const event = req.body.event;
    const payload = req.body.payload;
    console.log("Webhook reçu. event =", event, " payload =", JSON.stringify(payload, null, 2));

    if (!event || !payload) {
      return res.status(400).send("Payload invalide");
    }

    /**
     * 1) Récupérer l'ID membre selon la structure
     *  - Pour member.created / member.updated : payload.id
     *  - Pour member.plan.added / updated : payload.member.id
     *  - ...
     */
    let memberId = null;
    let email = null;

    // Pour member.created, member.updated, member.deleted
    if (payload.id) {
      memberId = payload.id;
      email = payload.auth?.email || payload.email;
    }

    // Pour plan events : member.plan.added, member.plan.updated, etc.
    if (!memberId && payload.member && payload.member.id) {
      memberId = payload.member.id;
      email = payload.member.email;
    }

    if (!memberId) {
      return res.status(400).send("Impossible de déterminer l'ID du membre");
    }

    /**
     * 2) Gérer les customFields et champs de base s'ils existent.
     *    Sur certain events (plan.added, plan.updated, etc.), la structure est différente.
     *    On fait un merge minimal.
     */
    // Lecture du document existant ou création d'un nouvel objet
    const userDocData = await getUserData(memberId);

    // Merge minimal sur l'email
    if (email) {
      userDocData.email = email;
    }

    // Ajout des custom fields si structure du webhook le permet
    // (Comme dans member.created / updated : payload.customFields)
    if (payload.customFields) {
      // Gérer vos propres clés (adresse, code-postal, etc.)
      // Ex : 
      if (payload.customFields["adresse"]) userDocData.Adresse = payload.customFields["adresse"];
      if (payload.customFields["code-postal"]) userDocData.CodePostal = payload.customFields["code-postal"];
      if (payload.customFields["first-name"]) userDocData.Prenom = payload.customFields["first-name"];
      if (payload.customFields["last-name"]) userDocData.Nom = payload.customFields["last-name"];
      if (payload.customFields["phone"]) userDocData.Phone = payload.customFields["phone"];
      if (payload.customFields["ville"]) userDocData.Ville = payload.customFields["ville"];

      // Ajoutez ici si vous avez d'autres champs.
    }

    /**
     * 3) Traitement des différents events
     */
    switch (event) {
      case "member.created":
      case "member.updated":
        // S'il y a planConnections, on remplace / on set
        if (payload.planConnections) {
          userDocData.plans = payload.planConnections;
        }
        // On met à jour Firestore avec userDocData
        await db.collection('users').doc(memberId).set(userDocData, { merge: true });
        console.log(`Synchronisation OK pour event=${event}, memberId=${memberId}`);
        break;

      case "member.plan.added":
        // On dispose de payload.planConnection et payload.member.id
        // MàJ des champs de base si besoin
        await db.collection('users').doc(memberId).set(userDocData, { merge: true });

        if (payload.planConnection) {
          await addPlanConnection(memberId, payload.planConnection);
        }
        console.log(`Plan ajouté pour memberId=${memberId}`);
        break;

      case "member.plan.updated":
        // On dispose de payload.member et souvent payload.prevPlanConnection ou payload.planConnection
        // MàJ des champs de base
        await db.collection('users').doc(memberId).set(userDocData, { merge: true });
        
        // Dans l'exemple, on n'a que prevPlanConnection. 
        // Vous pouvez stocker la nouvelle planConnection si MemberStack l'envoie 
        // ou mettre à jour l'existant. Ex :
        if (payload.planConnection) {
          // Ex : On met à jour
          await updatePlanConnection(memberId, payload.planConnection);
        } else if (payload.prevPlanConnection) {
          // Cas particulier : on met à jour en se basant sur prevPlanConnection
          // ou on crée un nouveau plan. À adapter à votre logique
          await updatePlanConnection(memberId, payload.prevPlanConnection);
        }
        console.log(`Plan mis à jour pour memberId=${memberId}`);
        break;

      case "member.plan.canceled":
        // On dispose de payload.member et payload.planConnection
        await db.collection('users').doc(memberId).set(userDocData, { merge: true });

        if (payload.planConnection) {
          // Soit on supprime complètement, soit on met un champ status = 'CANCELED'
          // Ex : On le retire du tableau
          await removePlanConnection(memberId, payload.planConnection);
        }
        console.log(`Plan annulé pour memberId=${memberId}`);
        break;

      case "member.deleted":
        // On supprime purement et simplement le document
        await db.collection('users').doc(memberId).delete();
        console.log(`Membre supprimé : memberId=${memberId}`);
        break;

      default:
        console.log(`Événement non géré : ${event}`);
        break;
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("Erreur lors du traitement du webhook MemberStack :", err);
    return res.status(500).send("Erreur serveur lors du traitement du webhook");
  }
});

module.exports = { router };
