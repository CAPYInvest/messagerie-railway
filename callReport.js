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
  projectId: serviceAccount.project_id,
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



//////////////////////////
// Fonction pour sauvegarder le fichier audio dans Firebase Storage et renvoyer son URI gs://
//////////////////////////
/**
 * Sauvegarde un fichier audio dans le dossier "temp_audio" du Storage et enregistre ses métadonnées dans Firestore.
 * @param {Buffer} audioBuffer - Le buffer du fichier audio.
 * @param {string} conversationId - ID unique de la conversation.
 * @returns {Promise<string>} - URI gs:// du fichier sauvegardé.
 */
async function saveAudioToStorage(audioBuffer, conversationId) {
  const fileName = `temp_audio/${conversationId}_${Date.now()}.webm`;
  const file = bucket.file(fileName);
  await file.save(audioBuffer, {
    metadata: {
      contentType: "audio/webm",
    }
  });
  console.log(`[Server] Fichier audio sauvegardé sous ${fileName}`);
  // Enregistrer les métadonnées dans la collection "audioRecordings"
  await db.collection('audioRecordings').add({
    conversationId,
    fileName,
    mimeType: "audio/webm",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return `gs://${bucket.name}/${fileName}`;
}

/**
 * Sauvegarde les métadonnées du document de transcription dans la collection "transcriptions" de Firestore.
 * @param {string} conversationId - ID de la conversation.
 * @param {string} docFileName - Nom du fichier DOCX sauvegardé.
 * @param {string} transcription - Texte de la transcription.
 */
async function saveTranscriptionMetadata(conversationId, docFileName, transcription) {
  await db.collection('transcriptions').add({
    conversationId,
    fileName: docFileName,
    transcription,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

/**
 * Endpoint pour recevoir un fichier audio et générer une transcription (au format DOCX).
 * Pour les fichiers audio de plus d'une minute, on utilise longRunningRecognize.
 */
router.post('/', upload.single('audioFile'), async (req, res) => {
  try {
    const { conversationId, callerType } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    }
    console.log(`[Server] Fichier reçu pour conversation ${conversationId}, callerType: ${callerType}`);
    const audioBuffer = req.file.buffer;

    // Pour simplifier, on force ici l'utilisation de longRunningRecognize (adaptable selon la durée réelle)
    const gsUri = await saveAudioToStorage(audioBuffer, conversationId);
    console.log("[Server] URI gs:// du fichier audio :", gsUri);

    // Préparer la requête pour longRunningRecognize
    const requestSpeech = {
      audio: { uri: gsUri },
      config: {
        encoding: 'WEBM_OPUS', // Adaptez en fonction du format réel de votre audio
        sampleRateHertz: 48000, // Ajustez selon votre source audio
        languageCode: 'fr-FR',
      },
    };

    console.log("[Server] Envoi du fichier audio à Google Speech-to-Text (Long Running)...");
    const [operation] = await speechClient.longRunningRecognize(requestSpeech);
    const [response] = await operation.promise();
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    console.log("[Server] Transcription obtenue :", transcription);

    // Générer un document DOCX avec la transcription
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

    // Renommer le dossier de transcription en "transcriptions" (au lieu de "call_reports")
    const docFileName = `transcriptions/${conversationId}_${Date.now()}.docx`;
    const docFile = bucket.file(docFileName);
    await docFile.save(docBuffer, {
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    });
    console.log(`[Server] Document DOCX sauvegardé sous ${docFileName}`);
    
    // Enregistrer les métadonnées de la transcription dans la collection "transcriptions"
    await saveTranscriptionMetadata(conversationId, docFileName, transcription);
    
    res.json({ success: true, docFileName, transcription });
  } catch (error) {
    console.error("[Server] Erreur lors du traitement du rapport :", error);
    res.status(500).json({ error: "Erreur interne lors du traitement du rapport." });
  }
});

/**
 * Endpoint pour générer une URL signée pour télécharger le document généré.
 */
router.get('/download-call-report', async (req, res) => {
  try {
    const { fileName } = req.query;
    if (!fileName) {
      return res.status(400).json({ error: "Paramètre 'fileName' requis" });
    }
    const file = bucket.file(fileName);
    const options = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // Lien valable 15 minutes
    };
    const [signedUrl] = await file.getSignedUrl(options);
    console.log(`[Server] URL signé généré pour ${fileName}: ${signedUrl}`);
    res.json({ url: signedUrl });
  } catch (error) {
    console.error("[Download] Erreur lors de la génération du lien:", error);
    res.status(500).json({ error: "Erreur interne lors de la génération du lien de téléchargement." });
  }
});

module.exports = router;