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
const bucket = admin.storage().bucket();

//////////////////////////
// Fonction pour sauvegarder le fichier audio dans Firebase Storage et renvoyer son URI gs://
//////////////////////////
async function saveAudioToStorage(audioBuffer, conversationId) {
  const fileName = `temp_audio/${conversationId}_${Date.now()}.webm`;
  const file = bucket.file(fileName);
  await file.save(audioBuffer, {
    metadata: {
      contentType: "audio/webm",
    }
  });
  // Générer une URL signée peut être utile pour le debug, mais pour l'API Google, on a besoin du gs:// URL
  return `gs://${bucket.name}/${fileName}`;
}

//////////////////////////
// Endpoint pour traiter le rapport
//////////////////////////
router.post('/', upload.single('audioFile'), async (req, res) => {
  try {
    const { conversationId, callerType } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    }
    console.log(`[Server] Fichier reçu pour conversation ${conversationId}, callerType: ${callerType}`);
    const audioBuffer = req.file.buffer;

    // Pour déterminer la durée, on pourrait utiliser la taille du buffer ou analyser les métadonnées.
    // Ici, nous supposerons qu'un fichier de plus de 60 secondes nécessitera LongRunningRecognize.
    // Par exemple, vous pouvez définir un seuil de taille (en bytes) à vérifier.
    // Pour l'exemple, on forcera toujours LongRunningRecognize.
    const useLongRunning = true;

    let transcription = "";
    if (useLongRunning) {
      // Sauvegarder le fichier audio dans Storage et récupérer son URI gs://
      const gsUri = await saveAudioToStorage(audioBuffer, conversationId);
      console.log("[Server] Fichier audio sauvegardé dans Storage:", gsUri);

      // Préparer la requête pour LongRunningRecognize avec l'URI
      const requestSpeech = {
        audio: { uri: gsUri },
        config: {
          encoding: 'WEBM_OPUS', // Adapter selon le format
          sampleRateHertz: 48000,
          languageCode: 'fr-FR',
        },
      };

      console.log("[Server] Envoi du fichier audio à Google Speech-to-Text (Long Running)...");
      const [operation] = await speechClient.longRunningRecognize(requestSpeech);
      const [response] = await operation.promise();
      transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join('\n');
      console.log("[Server] Transcription obtenue :", transcription);
    } else {
      // Si le fichier était court, on utiliserait la méthode synchrone (ce bloc est rarement atteint ici)
      const audio = { content: audioBuffer.toString('base64') };
      const config = {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'fr-FR',
      };
      const requestSpeech = { audio, config };
      console.log("[Server] Envoi de l'audio à Google Speech-to-Text (Sync)...");
      const [response] = await speechClient.recognize(requestSpeech);
      transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join('\n');
      console.log("[Server] Transcription obtenue :", transcription);
    }

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

    // Stocker le document DOCX dans Firebase Storage
    const docFileName = `call_reports/${conversationId}_${Date.now()}.docx`;
    const docFile = bucket.file(docFileName);
    await docFile.save(docBuffer, {
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    });
    console.log(`[Server] Document DOCX sauvegardé sous ${docFileName}`);
    res.json({ success: true, docFileName, transcription });
  } catch (error) {
    console.error("[Server] Erreur lors du traitement du rapport :", error);
    res.status(500).json({ error: "Erreur interne lors du traitement du rapport." });
  }
});

// Endpoint pour générer une URL signé pour télécharger le document (pour tests ou interface plus tard)
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
