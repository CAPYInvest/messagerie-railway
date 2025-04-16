// callReport.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { SpeechClient } = require('@google-cloud/speech');
const { Document, Packer, Paragraph, TextRun } = require("docx");
const admin = require('firebase-admin');
const path = require('path');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Initialisation du client Google Speech-to-Text
const serviceAccount = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

const speechClient = new SpeechClient({
  credentials: serviceAccount,
  projectId:  serviceAccount.project_id
});


// Assurez-vous que Firebase Admin est initialisé (voir votre code existant)
if (!admin.apps.length) {
  const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  firebaseServiceAccount.private_key = firebaseServiceAccount.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    storageBucket: "capy-invest.firebasestorage.app"
  });
}


// Définir le client Storage et Firestore
const bucket = admin.storage().bucket();
const db = admin.firestore();

router.post("/", express.json(), async (req, res) => {
  try {
    const { conversationId, instanceId } = req.body;
    if (!conversationId || !instanceId) {
      return res.status(400).json({ error: "conversationId et instanceId requis" });
    }

    // 1) Récupère la liste des fichiers de cet enregistrement
    const DAILY_KEY = process.env.DAILY_API_KEY;
    const rec = await axios.get(
      `https://api.daily.co/v1/recordings/instances/${instanceId}`,
      { headers: { Authorization: `Bearer ${DAILY_KEY}` } }
    );
    const files = rec.data.recording.files || [];
    const audioFile = files.find(f => f.fileType === "audio_only" || f.fileMimeType.startsWith("audio/"));
    if (!audioFile) {
      return res.status(500).json({ error: "Aucun fichier audio trouvé dans cette instance." });
    }

    // 2) Télécharge cet URL en Buffer
    const audioResp = await axios.get(audioFile.url, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(audioResp.data);

    // 3) Sauvegarde dans Firebase Storage / Firestore
    const tempName = `temp_audio/${conversationId}_${Date.now()}.webm`;
    const fileRef  = bucket.file(tempName);
    await fileRef.save(audioBuffer, { metadata:{ contentType: audioFile.fileMimeType } });
    await db.collection("audioRecordings").add({
      conversationId, fileName: tempName,
      mimeType: audioFile.fileMimeType,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4) Transcription longue via URI gs://
    const gsUri = `gs://${bucket.name}/${tempName}`;
    const [op] = await speechClient.longRunningRecognize({
      audio: { uri: gsUri },
      config: { encoding:"WEBM_OPUS", sampleRateHertz:48000, languageCode:"fr-FR" }
    });
    const [speechResponse] = await op.promise();
    const transcription = speechResponse.results
      .map(r => r.alternatives[0].transcript).join("\n");

    // 5) Génère le DOCX
    const doc = new Document({
      sections:[{
        children:[
          new Paragraph({
            children:[
              new TextRun({ text:"Compte Rendu de l'Appel", bold:true, size:28 }),
              new TextRun({ text:`\nConversation ID: ${conversationId}\n`, bold:true, size:24 })
            ]
          }),
          new Paragraph({ children:[ new TextRun({ text:transcription, size:24 }) ]})
        ]
      }]
    });
    const docBuffer = await Packer.toBuffer(doc);
    const docName = `transcriptions/${conversationId}_${Date.now()}.docx`;
    const docRef  = bucket.file(docName);
    await docRef.save(docBuffer, {
      metadata:{ contentType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
    });
    await db.collection("transcriptions").add({
      conversationId, fileName:docName, transcription,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ success:true, docFileName:docName });
  } catch (err) {
    console.error("[Server] call-report error:", err);
    return res.status(500).json({ error:"Erreur interne lors du traitement du rapport." });
  }
});

// GET /api/call-report/download-call-report
router.get("/download-call-report", async (req, res) => {
  try {
    const { fileName } = req.query;
    if (!fileName) return res.status(400).json({ error:"fileName requis" });
    const file = bucket.file(fileName);
    const [url] = await file.getSignedUrl({
      version: "v4", action:"read", expires: Date.now()+15*60*1000
    });
    return res.json({ url });
  } catch (err) {
    console.error("[Server] download error:", err);
    return res.status(500).json({ error:"Impossible de générer le lien." });
  }
});

module.exports = router;

