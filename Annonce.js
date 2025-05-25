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
    let { stepIndex, data, memberId } = req.body;
    if (!memberId) return res.status(400).json({ success: false, error: "memberId requis" });

    const annonceRef = db.collection("annonces").doc(memberId);

    let docData = {
      memberId: memberId,
      [`step${stepIndex}`]: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (parseInt(stepIndex) === 5) {
      docData.nomAnnonce = data.nomAnnonce || "";
      docData.statutPublication = "Oui";
    } else {
      docData.statutPublication = "Non";
    }

    await annonceRef.set(docData, { merge: true });

    res.json({ success: true, annonceId: memberId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



//---------------------------------------------------------------
// ---- Route : Récupération d'une annonce pour pré-remplissage -
//---------------------------------------------------------------
router.get("/get/:memberId", async (req, res) => {
  try {
    const memberId = req.params.memberId;
    if (!memberId) return res.status(400).json({ success: false, error: "memberId manquant" });

    const doc = await db.collection("annonces").doc(memberId).get();
    if (!doc.exists) {
      // Au lieu d'une erreur, on retourne une réponse normale mais vide
      return res.json({ success: true, annonce: null });
    }

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
    const { memberId } = req.body;
    const file = req.file;
    if (!memberId) return res.status(400).json({ success: false, error: "memberId requis" });
    if (!file) return res.status(400).json({ success: false, error: "Fichier manquant" });

    // Utilise memberId comme clé de doc et dossier storage
    const ext = file.originalname.split('.').pop();
    const fileName = `annonces/${memberId}/photo_profil.${ext}`;
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
      await db.collection("annonces").doc(memberId).set({
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
//-----  route pour récupérer toutes les annonces publiées --------
//--------Liste paginée/filtrée des annonces publiées--------------
//-----------------------------------------------------------------


router.get("/list", async (req, res) => {
  try {
    // Extraction des filtres & pagination (à adapter plus tard !)
    // const { page = 1, limit = 20, tri, ... } = req.query;

    // 1. On récupère TOUTES les annonces “publiées”
    const snapshot = await db.collection("annonces")
      .where("step5.statutPublication", "==", "Oui")
      .orderBy("updatedAt", "desc") // plus récent en premier
      //.limit(parseInt(limit)) // à décommenter pour paginer
      .get();

    // 2. On mappe les résultats
    const annonces = [];
    snapshot.forEach(doc => {
      annonces.push(doc.data());
    });

    res.json({ success: true, annonces });
  } catch (error) {
    console.error("[Annonce] Erreur /list :", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


module.exports = router;
