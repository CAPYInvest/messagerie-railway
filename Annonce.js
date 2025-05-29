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



// ---------------------------------------------------------------------------------
// Endpoint pour récupérer les annonces dans une bounding box (visible sur la carte)
// ---------------------------------------------------------------------------------
router.get("/list-in-bounds", async (req, res) => {
  try {
    const { neLat, neLng, swLat, swLng } = req.query;
    if (
      !neLat || !neLng || !swLat || !swLng
      || isNaN(parseFloat(neLat)) || isNaN(parseFloat(neLng))
      || isNaN(parseFloat(swLat)) || isNaN(parseFloat(swLng))
    ) {
      return res.status(400).json({ success: false, error: "Coordonnées invalides" });
    }
    // Firestore requête
    const annoncesRef = db.collection("annonces")
      .where("step5.statutPublication", "==", "Oui"); // On affiche que les publiées

    const snapshot = await annoncesRef.get();
    const annonces = [];
    snapshot.forEach(doc => {
      const annonce = doc.data();
      if (
        annonce.step3
        && typeof annonce.step3.latitude === "number"
        && typeof annonce.step3.longitude === "number"
      ) {
        const { latitude, longitude } = annonce.step3;
        // Vérifie que la coordonnée est bien dans la zone affichée par la carte
        if (
          latitude <= parseFloat(neLat) && latitude >= parseFloat(swLat) &&
          longitude >= parseFloat(swLng) && longitude <= parseFloat(neLng)
        ) {
          annonces.push({ ...annonce, id: doc.id });
        }
      }
    });
    res.json({ success: true, annonces });
  } catch (err) {
    console.error("[Annonce] Erreur /list-in-bounds :", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---------------------------------------------------------------------------------
// --------------Endpoint pour la recherche par localisation & filtres--------------
// ---------------------------------------------------------------------------------

// Fonction Haversine pour la distance en km
function haversine(lat1, lng1, lat2, lng2) {
  function toRad(x) { return x * Math.PI / 180; }
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Recherche multi-critères
router.post('/search', async (req, res) => {
  try {
    const {
      texte,
      fonction,
      tri,
      domaines,
      esg,
      typeRDV,
      localisation, // {lat, lng, rayon}
      mapBounds // {neLat, neLng, swLat, swLng}
    } = req.body;

    let ref = db.collection('annonces');
    ref = ref.where('step5.statutPublication', '==', 'Oui');

    if (fonction && fonction !== "empty")
      ref = ref.where('step1.fonction', '==', fonction);

    if (esg === "Oui" || esg === "Non")
      ref = ref.where('step1.esg', '==', esg);

    // Domaines d'expertise
    if (domaines && domaines.length > 0)
      ref = ref.where('step1.domainesExpertise', 'array-contains-any', domaines);

    // Map bounds pour limiter les requêtes Firestore
    if (mapBounds) {
      ref = ref
        .where('step3.latitude', '>=', mapBounds.swLat)
        .where('step3.latitude', '<=', mapBounds.neLat)
        .where('step3.longitude', '>=', mapBounds.swLng)
        .where('step3.longitude', '<=', mapBounds.neLng);
    }

    // Récupère les annonces
    const snapshot = await ref.get();
    let annonces = [];
    snapshot.forEach(doc => {
      let data = doc.data();
      data.id = doc.id;
      annonces.push(data);
    });

    // Texte recherche (multi-champ)
    if (texte && texte.trim()) {
      const texteLC = texte.trim().toLowerCase();
      annonces = annonces.filter(annonce =>
        (annonce.step0?.nom || '').toLowerCase().includes(texteLC) ||
        (annonce.step0?.prenom || '').toLowerCase().includes(texteLC) ||
        (annonce.step3?.ville || '').toLowerCase().includes(texteLC) ||
        (annonce.step1?.fonction || '').toLowerCase().includes(texteLC) ||
        (annonce.step3?.typeRdv || '').toLowerCase().includes(texteLC) ||
        (annonce.step2?.accroche || '').toLowerCase().includes(texteLC) ||
        (annonce.step4?.tarifHoraire || '').toString().includes(texteLC) ||
        (annonce.step1?.domainesExpertise || []).some(d => d.toLowerCase().includes(texteLC)) ||
        (annonce.step4?.propositionService || '').toLowerCase().includes(texteLC)
      );
    }

    // Filtre RDV types
    if (typeRDV) {
      if (typeRDV === "Presentiel") {
        annonces = annonces.filter(a =>
          a.step3 &&
          (
            a.step3.typeRdv === "Presentiel" ||
            a.step3.typeRdv === "Presentiel-ou-Visioconference" ||
            a.step3.typeRdv === "Présentiel" || // gestion majuscules/accents éventuels
            a.step3.typeRdv === "Présentiel ou visioconférence"
          )
        );
      } else if (typeRDV === "Visioconference") {
        annonces = annonces.filter(a =>
          a.step3 &&
          (
            a.step3.typeRdv === "Visioconference" ||
            a.step3.typeRdv === "Presentiel-ou-Visioconference" ||
            a.step3.typeRdv === "Visioconférence" ||
            a.step3.typeRdv === "Présentiel ou visioconférence"
          )
        );
      }
      // Si null, on ne filtre pas.
    }

    // Filtre localisation/rayon (vrai cercle)
    if (localisation && localisation.lat && localisation.lng && localisation.rayon) {
      annonces = annonces.filter(annonce => {
        const lat = annonce.step3?.latitude;
        const lng = annonce.step3?.longitude;
        if (typeof lat !== 'number' || typeof lng !== 'number') return false;
        return haversine(localisation.lat, localisation.lng, lat, lng) <= localisation.rayon;
      });
    }

    // Tri
    if (tri === "Tarif-croissant") {
      annonces = annonces.sort((a, b) =>
        (parseFloat(a.step4?.tarifHoraire) || 0) - (parseFloat(b.step4?.tarifHoraire) || 0)
      );
    } else if (tri === "Tarif-decroissant") {
      annonces = annonces.sort((a, b) =>
        (parseFloat(b.step4?.tarifHoraire) || 0) - (parseFloat(a.step4?.tarifHoraire) || 0)
      );
    }

    res.json({ success: true, annonces });
  } catch (err) {
    console.error("[Annonce][search] Erreur : ", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
