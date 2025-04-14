// callReport.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { SpeechClient } = require('@google-cloud/speech');
const { Document, Packer, Paragraph, TextRun } = require("docx");
const admin = require('firebase-admin');

const router = express.Router();

// Configure multer pour stocker les fichiers en mémoire
const upload = multer({ storage: multer.memoryStorage() });

// Initialisation du client Google Speech-to-Text
// Le JSON de votre compte de service est stocké dans la variable d'environnement "GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT"
const serviceAccount = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

const speechClient = new SpeechClient({
  credentials: serviceAccount,
  projectId: serviceAccount.project_id,
});

// Endpoint pour recevoir le fichier audio et générer le compte rendu
// On s'attend à recevoir le fichier audio dans le champ "audioFile"
// ainsi que les métadonnées "conversationId" et "callerType"
router.post('/', upload.single('audioFile'), async (req, res) => {
  try {
    const { conversationId, callerType } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    }
    console.log(`[Server] Fichier reçu pour conversation ${conversationId}, callerType: ${callerType}`);
    const audioBuffer = req.file.buffer;

    // Préparer la requête pour Google Speech-to-Text
    // Ici, nous supposons que le format est audio/webm avec le codec Opus.
    const audio = {
      content: audioBuffer.toString('base64'),
    };
    const config = {
      encoding: 'WEBM_OPUS', // Adapter si nécessaire selon votre navigateur
      sampleRateHertz: 48000, // Valeur typique pour audio/webm; ajustez si besoin
      languageCode: 'fr-FR',   // Langue de la transcription
    };
    const requestSpeech = {
      audio: audio,
      config: config,
    };

    console.log("[Server] Envoi de l'audio à Google Speech-to-Text...");
    const [response] = await speechClient.recognize(requestSpeech);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    console.log("[Server] Transcription obtenue :", transcription);

    // Générer un document DOCX contenant la transcription
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: "Compte Rendu de l'Appel", bold: true, size: 28 }),
              new TextRun({ text: `\nConversation ID: ${conversationId}\n`, bold: true, size: 24 }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: transcription, size: 24 }),
            ],
          }),
        ]
      }],
    });
    const docBuffer = await Packer.toBuffer(doc);
    
    // Stocker le document DOCX dans Firebase Storage
    const bucket = admin.storage().bucket();
    const docFileName = `call_reports/${conversationId}_${Date.now()}.docx`;
    const file = bucket.file(docFileName);
    await file.save(docBuffer, {
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    });
    console.log(`[Server] Document DOCX sauvegardé sous ${docFileName}`);
    res.json({ success: true, docFileName: docFileName, transcription: transcription });
  } catch (error) {
    console.error("[Server] Erreur lors du traitement du rapport :", error);
    res.status(500).json({ error: "Erreur interne lors du traitement du rapport." });
  }
});

module.exports = router;
