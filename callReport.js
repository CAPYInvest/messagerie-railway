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

const speechClient = new SpeechClient({ credentials: gService, projectId: gService.project_id });


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


// Sauvegarde du buffer audio et métadonnées
async function saveAudioToStorage(audioBuffer, conversationId) {
  const fileName = `temp_audio/${conversationId}_${Date.now()}.webm`;
  const file = bucket.file(fileName);
  await file.save(audioBuffer, { metadata: { contentType: "audio/webm" } });
  console.log(`[Server] Audio sauvegardé sous ${fileName}`);
  await db.collection('audioRecordings').add({
    conversationId, fileName, mimeType: "audio/webm",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return `gs://${bucket.name}/${fileName}`;
}

// Enregistre métadonnées de transcription
async function saveTranscriptionMetadata(conversationId, docFileName, transcription) {
  await db.collection('transcriptions').add({
    conversationId, fileName: docFileName, transcription,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// POST /call-report
router.post('/', upload.single('audioFile'), async (req, res) => {
  try {
    const { conversationId, callerType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    console.log(`[Server] Reçu audio pour conversation ${conversationId}, callerType=${callerType}`);

    // Stocke l’audio
    const gsUri = await saveAudioToStorage(req.file.buffer, conversationId);

    // Prépare et lance la transcription asynchrone
    const requestSpeech = {
      audio: { uri: gsUri },
      config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'fr-FR' },
    };
    console.log("[Server] Envoi à Google Speech-to-Text longRunningRecognize...");
    const [operation] = await speechClient.longRunningRecognize(requestSpeech);
    const [response] = await operation.promise();
    const transcription = response.results
      .map(r => r.alternatives[0].transcript).join('\n');
    console.log("[Server] Transcription obtenue.");

    // Génère le DOCX
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: "Compte Rendu de l'Appel", bold: true, size: 28 }),
              new TextRun({ text: `\nConversation ID: ${conversationId}\n`, bold: true, size: 24 }),
            ],
          }),
          new Paragraph({ children: [ new TextRun({ text: transcription, size: 24 }) ] }),
        ]
      }]
    });
    const docBuffer = await Packer.toBuffer(doc);

    // Sauvegarde dans "transcriptions/"
    const docFileName = `transcriptions/${conversationId}_${Date.now()}.docx`;
    const docFile = bucket.file(docFileName);
    await docFile.save(docBuffer, {
      metadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
    });
    console.log(`[Server] DOCX sauvegardé sous ${docFileName}`);

    await saveTranscriptionMetadata(conversationId, docFileName, transcription);

    return res.json({ success: true, docFileName, transcription });
  } catch (error) {
    console.error("[Server] Erreur callReport:", error);
    return res.status(500).json({ error: "Erreur interne lors du traitement du rapport." });
  }
});

// GET /call-report/download-call-report?fileName=...
router.get('/download-call-report', async (req, res) => {
  try {
    const { fileName } = req.query;
    if (!fileName) return res.status(400).json({ error: "Paramètre 'fileName' requis" });
    const file = bucket.file(fileName);
    const options = { version: 'v4', action: 'read', expires: Date.now() + 15*60*1000 };
    const [signedUrl] = await file.getSignedUrl(options);
    console.log(`[Server] Signed URL pour ${fileName}: ${signedUrl}`);
    return res.json({ url: signedUrl });
  } catch (error) {
    console.error("[Server] Erreur génération lien signé:", error);
    return res.status(500).json({ error: "Erreur interne lors de la génération du lien de téléchargement." });
  }
});

module.exports = router;

module.exports = router;