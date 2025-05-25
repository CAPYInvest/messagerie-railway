// Annonce.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

const upload = multer({ storage: multer.memoryStorage() });

// ---- Firestore et Storage déjà initialisés dans ton app principale ----
const db = admin.firestore();
const bucket = admin.storage().bucket();


//-----------------------------------------------------------------------------
// ---- Route : Enregistrement progressif d'une annonce (par étape) -----------
//-----------------------------------------------------------------------------
router.post("/save-step", async (req, res) => {
  try {
    console.log(`[BACK] Body reçu étape ${req.body.stepIndex}:`, req.body);

    let { annonceId, stepIndex, data, memberId } = req.body;
    if (!annonceId) annonceId = uuidv4();
    const annonceRef = db.collection("annonces").doc(annonceId);

    let docData = {
      annonceId: annonceId,
      memberId: memberId,
      [`step${stepIndex}`]: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Gestion du statut de publication :
    if (parseInt(stepIndex) === 5) { // Étape publication
      docData.nomAnnonce = data.nomAnnonce || ""; // à la racine pour le listing
      docData.statutPublication = "Oui";
    } else {
      docData.statutPublication = "Non";
    }

    console.log(`[BACK] Données enregistrées en Firestore (annonceId ${annonceId}) :`, docData);

    await annonceRef.set(docData, { merge: true });

    res.json({ success: true, annonceId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


//---------------------------------------------------------------
// ---- Route : Récupération d'une annonce pour pré-remplissage -
//---------------------------------------------------------------
router.get("/get/:annonceId", async (req, res) => {
  try {
    const annonceId = req.params.annonceId;
    if (!annonceId) return res.status(400).json({ success: false, error: "annonceId manquant" });

    const doc = await db.collection("annonces").doc(annonceId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Annonce introuvable" });

    res.json({ success: true, annonce: doc.data() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});





//---------------------------------------------------
// ---- Route : Upload de la photo de profil --------
//---------------------------------------------------
router.post("/upload-photo", upload.single("photo"), async (req, res) => {
  try {
    const { annonceId } = req.body;
    const file = req.file;
    if (!annonceId) return res.status(400).json({ success: false, error: "annonceId requis" });
    if (!file) return res.status(400).json({ success: false, error: "Fichier manquant" });

    // Détermine l'extension
    const ext = file.originalname.split('.').pop();
    const fileName = `annonces/${annonceId}/photo_profil.${ext}`;
    const blob = bucket.file(fileName);

    // Upload dans Firebase Storage
    const blobStream = blob.createWriteStream({
      metadata: { contentType: file.mimetype }
    });

    blobStream.end(file.buffer);

    blobStream.on("finish", async () => {
      // Génère une URL signée valable longtemps
      const [url] = await blob.getSignedUrl({
        action: "read",
        expires: "03-09-2100"
      });

      // Mets à jour Firestore avec l'URL de la photo
      await db.collection("annonces").doc(annonceId).set({
        photoURL: url
      }, { merge: true });

      res.json({ success: true, photoURL: url });
    });

    blobStream.on("error", (err) => {
      console.error("[Annonce] Erreur upload photo :", err);
      res.status(500).json({ success: false, error: err.message });
    });
  } catch (err) {
    console.error("[Annonce] Erreur upload-photo :", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



//-----------------------------------------------------------------
// ----  route pour récupérer toutes les annonces publiées --------
//-----------------------------------------------------------------


router.get("/list-publiques", async (req, res) => {
  try {
    const snapshot = await db.collection("annonces")
      .where("statutPublication", "==", "Oui")
      .get();
    const annonces = snapshot.docs.map(doc => doc.data());
    res.json({ success: true, annonces });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
