// Annonce.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult, query } = require('express-validator');
const upload = multer({storage: multer.memoryStorage(), limits : { fileSize: 2 * 1024 * 1024 }  });    // 2 MiB
const sharp      = require('sharp');
const mime       = require('mime-types');





// ---- Firestore et Storage déjà initialisés dans ton app principale ----
const db = admin.firestore();
const bucket = admin.storage().bucket();






/* ------------------------  Sécurité globale  ------------------------ */





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
router.post('/upload-photo',
  upload.single('photo'),
  async (req, res) => {
    try {
      const { memberId } = req.body;
      const file = req.file;

      /* ---- 1) Vérifications de base ---- */
      if (!memberId)   return res.status(400).json({ success:false, error:'memberId requis' });
      if (!file)       return res.status(400).json({ success:false, error:'Fichier manquant' });

      const mimeOk = ['image/jpeg','image/png','image/webp'].includes(file.mimetype);
      if (!mimeOk)     return res.status(415).json({ success:false, error:'Format non autorisé' });

      /* ---- 2) Traitement image (strip EXIF, resize) ---- */
      const transformer = sharp(file.buffer)
        .rotate()                       // respecte l'orientation EXIF puis…
        .resize({ width: 800, height: 800, fit: 'inside' })
        .toFormat('webp', { quality: 85 })      // convertit tout en WebP

      const processedBuffer = await transformer.toBuffer();
      const ext             = 'webp';
      const fileName        = `annonces/${memberId}/photo_profil.${ext}`;
      const blob            = bucket.file(fileName);

      /* ---- 3) Upload vers Firebase Storage ---- */
      await blob.save(processedBuffer, {
        metadata: { contentType: 'image/webp' },
        predefinedAcl: 'publicRead'
      });

      /* ---- 4) Génération URL signée ---- */
      const [url] = await blob.getSignedUrl({
        action: 'read',
        expires: '03-01-2500' // Date très lointaine pour une URL "permanente"
      });

      /* ---- 5) Mise à jour Firestore ---- */
      await db.collection('annonces').doc(memberId).set({
        photoURL: url
      }, { merge:true });

      res.json({ success:true, photoURL:url });

    } catch (err) {
      console.error('[Annonce] Erreur upload-photo sécurisé :', err);
      res.status(500).json({ success:false, error:err.message });
    }
  }
);



//-----------------------------------------------------------------
//-----  route pour récupérer toutes les annonces publiées --------
//--------Liste paginée/filtrée des annonces publiées--------------
//-----------------------------------------------------------------


router.get("/list", async (req, res) => {
  try {
    // Extraction des filtres & pagination (à adapter plus tard !)
    // const { page = 1, limit = 20, tri, ... } = req.query;

    // 1. On récupère TOUTES les annonces "publiées"
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

const searchValidators = [
  body('texte').optional().isString().isLength({ max: 200 }),
  body('fonction').optional().isString().isLength({ max: 60 }),
  body('tri').optional().isIn(['Tarif-croissant','Tarif-decroissant','']),
  body('domaines').optional().isArray({ max: 14 }),
  body('esg').optional().isIn(['Oui','Non','']),
  body('typeRDV').optional().isIn(['Presentiel','Visioconference','']),
  body('localisation').optional().custom(loc => {
    if (!loc) return true;
    const { lat, lng, rayon } = loc;
    return typeof lat === 'number' && lat >= -90 && lat <= 90 &&
           typeof lng === 'number' && lng >= -180 && lng <= 180 &&
           typeof rayon === 'number' && rayon > 0 && rayon <= 100;
  }),
  body('mapBounds').optional().custom(b => {
    if (!b) return true;
    const { neLat, neLng, swLat, swLng } = b;
    return [neLat, neLng, swLat, swLng].every(
      v => typeof v === 'number' && !Number.isNaN(v)
    );
  })
];



// Fonction de "normalisation" Supprimer accents, minusculiser, enlever ponctuation pour matcher plus large
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")                // Supprime accents
    .replace(/[\u0300-\u036f]/g, "") // Supprime diacritiques
    .replace(/[-_]/g, " ")           // Tirets/underscores => espace
    .replace(/[^\w\s]/g, "")         // Supprime ponctuation
    .replace(/\s+/g, " ")            // Espace unique
    .trim();
}


//Distance de Levenshtein (pour fuzzy matching)
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let matrix = [];
  let i;
  for (i = 0; i <= b.length; i++) matrix[i] = [i];
  let j;
  for (j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (i = 1; i <= b.length; i++) {
    for (j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}



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

    /* ───── Résultat validation ───── */
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success:false, errors: errors.array() });
  }



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

    // Texte recherche (multi-champ) avec normalisation 

    if (texte && texte.trim()) {
  const texteNorm = normalize(texte);
  annonces = annonces.filter(annonce => {
    // Liste de champs à tester (tu peux adapter)
    const champs = [
      annonce.step0?.nom,
      annonce.step0?.prenom,
      annonce.step3?.ville,
      annonce.step1?.fonction,
      annonce.step3?.typeRdv,
      annonce.step2?.accroche,
      (annonce.step4?.tarifHoraire || "").toString(),
      ...(annonce.step1?.domainesExpertise || []),
      annonce.step4?.propositionService
    ];
    // Pour chaque champ, on normalise puis compare
    return champs.some(val => {
      const valNorm = normalize(val);
      if (!valNorm) return false;
      // 1. Match exact (large, accents retirés)
      if (valNorm.includes(texteNorm)) return true;
      // 2. Fuzzy : distance <= 2 sur des mots courts
      if (texteNorm.length >= 4 && valNorm.length >= 4 && levenshtein(valNorm, texteNorm) <= 2) return true;
      return false;
    });
  });
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
