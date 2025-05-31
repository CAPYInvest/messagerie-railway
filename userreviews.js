// userreviews.js
const express = require('express');
const router = express.Router();
const admin = require("firebase-admin");
const { requireAuth } = require('./middlewareauth'); // Ton middleware !

const db = admin.firestore();
const reviewsCollection = db.collection("user_reviews");





// 1. Liste des avis pour un conseiller
router.get('/list/:conseillerId', async (req, res) => {
  try {
    const { conseillerId } = req.params;
    const snapshot = await reviewsCollection
      .where("conseillerId", "==", conseillerId)
      .orderBy("createdAt", "desc")
      .get();

    let reviews = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      reviews.push({
        id: doc.id,
        userId: data.userId,
        userName: data.userName,
        note: data.note,
        text: data.text,
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
      });
    });
    res.json({ success: true, reviews });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});





// 2. Ajouter / modifier un avis (auth obligatoire)
router.post('/add', requireAuth, async (req, res) => {
  try {
    const { conseillerId, note, text } = req.body;
    const userId = req.member.uid;  // uid Memberstack (depuis le token)
    const userName = req.member.name || "Utilisateur";

    if (!conseillerId || !userId || !note || !text)
      return res.status(400).json({ success: false, error: "Champs manquants" });

    // Un seul avis par user/conseiller
    const snapshot = await reviewsCollection
      .where("conseillerId", "==", conseillerId)
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      // Mise à jour
      const docId = snapshot.docs[0].id;
      await reviewsCollection.doc(docId).set({
        note,
        text,
        userName,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ success: true, update: true });
    } else {
      // Ajout
      await reviewsCollection.add({
        conseillerId,
        userId,
        userName,
        note,
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, update: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});






// 3. Supprimer SON avis (auth obligatoire)
router.delete('/delete', requireAuth, async (req, res) => {
  try {
    const { conseillerId } = req.body;
    const userId = req.member.uid;

    if (!conseillerId || !userId)
      return res.status(400).json({ success: false, error: "Champs manquants" });

    // On trouve le bon doc
    const snapshot = await reviewsCollection
      .where("conseillerId", "==", conseillerId)
      .where("userId", "==", userId)
      .limit(1)
      .get();
    if (snapshot.empty)
      return res.status(404).json({ success: false, error: "Avis non trouvé" });

    await reviewsCollection.doc(snapshot.docs[0].id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
