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
    let { annonceId, stepIndex, data, memberId } = req.body;
    if (!annonceId) annonceId = uuidv4();
    const annonceRef = db.collection("annonces").doc(annonceId);

    let docData = {
      annonceId: annonceId,
      memberId: memberId,
      [`step${stepIndex}`]: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Ajoute nomAnnonce à la racine si on est à l'étape 6
    if (parseInt(stepIndex) === 5 && data.nomAnnonce) {
      docData.nomAnnonce = data.nomAnnonce;
    }
    await annonceRef.set(docData, { merge: true });

    res.json({ success: true, annonceId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

module.exports = router;
