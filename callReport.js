// callReport.js
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios   = require('axios');
const { SpeechClient } = require('@google-cloud/speech');
const { VertexAI }     = require('@google-cloud/vertexai');
const admin   = require('firebase-admin');
const { Document, Packer, Paragraph, TextRun } = require('docx');

// Si clé Vertex AI passée en JSON, on l'écrit dans un fichier et on configure ADC
if (process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT) {
  const vertexCreds = JSON.parse(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT);
  const tmpPath = '/tmp/vertex-service-account.json';
  fs.writeFileSync(tmpPath, JSON.stringify(vertexCreds));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  console.log(`[callReport] Wrote Vertex AI creds to ${tmpPath}`);
}

const router = express.Router();

// ---------- Init Firebase Admin ----------
const fbCred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
fbCred.private_key = fbCred.private_key.replace(/\\n/g, '\n');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(fbCred),
    storageBucket: process.env.FIREBASE_BUCKET
  });
}
const bucket = admin.storage().bucket();
const db     = admin.firestore();

// ---------- Init Speech‐to‐Text ----------
const stCred = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
stCred.private_key = stCred.private_key.replace(/\\n/g, '\n');
const speechClient = new SpeechClient({
  credentials: stCred,
  projectId: stCred.project_id,
});

// ---------- Init Vertex AI (ADC) ----------
console.log("[callReport] Vertex AI init: project=", process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
            "location=", process.env.GOOGLE_VERTEX_AI_LOCATION);
const vertex = new VertexAI({
  project : process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
  location: process.env.GOOGLE_VERTEX_AI_LOCATION || 'us-central1'
});

// ---------- Helpers ----------
async function waitReady(recId, maxTries = 10, delayMs = 6000) {
  console.log(`[callReport] Waiting for recording ${recId} to be ready...`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  for (let i = 0; i < maxTries; i++) {
    const { data } = await axios.get(
      `https://api.daily.co/v1/recordings/${recId}`, { headers }
    );
    console.log(`[callReport] Try ${i+1}/${maxTries}, status=`, data.status);
    if (data.status === 'ready' || data.status === 'finished') {
      console.log(`[callReport] Recording ${recId} is ready.`);
      return data;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Enregistrement Daily toujours en cours après délai.');
}

async function getDownloadLink(recId) {
  console.log(`[callReport] Generating download link for ${recId}`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  const { data } = await axios.get(
    `https://api.daily.co/v1/recordings/${recId}/access-link`, { headers }
  );
  console.log(`[callReport] Download link generated.`);
  return data.download_link;
}

async function downloadBuffer(url) {
  console.log(`[callReport] Downloading audio buffer from URL`);
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

async function saveToStorage(buffer, path, contentType) {
  console.log(`[callReport] Saving to storage at ${path}`);
  const file = bucket.file(path);
  await file.save(buffer, { metadata: { contentType } });
  return `gs://${bucket.name}/${path}`;
}

async function transcribe(gsUri) {
  console.log(`[callReport] Starting transcription for ${gsUri}`);
  const [op] = await speechClient.longRunningRecognize({
    audio: { uri: gsUri },
    config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'fr-FR' },
  });
  const [res] = await op.promise();
  const text = res.results.map(r => r.alternatives[0].transcript).join('\n');
  console.log(`[callReport] Transcription completed (length=${text.length})`);
  return text;
}

async function generateDocx(sections, destPath) {
  console.log(`[callReport] Generating DOCX at ${destPath}`);
  const doc = new Document({ sections });
  const buffer = await Packer.toBuffer(doc);
  await saveToStorage(buffer, destPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

async function summarizeText(text) {
  console.log(`[callReport] Summarizing text (length=${text.length}) via Vertex AI using Gemini Flash`);
  // Choix du modèle Gemini Flash pour un bon ratio qualité/coût
  const genModel = vertex.preview.getGenerativeModel({ model: 'models/gemini-2.0-flash' });
  // Construction du prompt avec message système et utilisateur
  const contents = [
    { role: 'system', parts: [ { text: 'Tu es un assistant formel et académique. Génère un résumé concis et clair du dialogue suivant.' } ] },
    { role: 'user', parts: [ { text: `Dialogue :
${text}` } ] }
  ];
  const resp = await genModel.generateContent({ contents });
  console.log('[callReport] Raw summary candidates =', JSON.stringify(resp.candidates));
  // Extraction du résumé ou fallback
  let summary = resp.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!summary) {
    console.log('[callReport] Summary empty, using transcription as fallback');
    summary = text;
  }
  console.log('[callReport] Summary received (length=', summary.length, ')');
  return summary;
}

// ---------- Route principale ----------
router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId } = req.body;
    console.log('[callReport] Received request', req.body);
    if (!recordingId || !conversationId) {
      return res.status(400).json({ error: 'recordingId et conversationId requis' });
    }
    await waitReady(recordingId);
    const downloadUrl = await getDownloadLink(recordingId);
    const audioBuf = await downloadBuffer(downloadUrl);
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    const gsUri = await saveToStorage(audioBuf, audioPath, 'audio/webm');
    await db.collection('audioRecordings').add({ conversationId, fileName: audioPath, mimeType: 'audio/webm', createdAt: admin.firestore.FieldValue.serverTimestamp() });

    const transcription = await transcribe(gsUri);
    const txtPath = `transcriptions/${conversationId}_${Date.now()}.docx`;
    await generateDocx([{
      children: [
        new Paragraph({ children:[ new TextRun({ text: 'Transcription brute', bold:true }), new TextRun({ text: `\nConversation ID : ${conversationId}\n\n` }) ] }),
        new Paragraph({ children:[ new TextRun(transcription) ] })
      ]
    }], txtPath);
    await db.collection('transcriptions').add({ conversationId, fileName: txtPath, transcription, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    const summary = await summarizeText(transcription);
    const summaryPath = `Rapport_Daily_AI/${conversationId}_${Date.now()}.docx`;
    await generateDocx([{
      children: [
        new Paragraph({ children:[ new TextRun({ text: 'Résumé IA', bold:true }), new TextRun({ text: `\nConversation ID : ${conversationId}\n\n` }) ] }),
        new Paragraph({ children:[ new TextRun(summary) ] })
      ]
    }], summaryPath);
    await db.collection('Rapport_Daily_AI').add({ conversationId, fileName: summaryPath, summary, consent: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    console.log('[callReport] All steps completed successfully');
    res.json({ success: true, transcriptionDoc: txtPath, summaryDoc: summaryPath });
  } catch (err) {
    console.error('[callReport] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
