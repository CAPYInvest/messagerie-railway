// callReport.js
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { SpeechClient } = require('@google-cloud/speech');
const { VertexAI }     = require('@google-cloud/vertexai');
const admin   = require('firebase-admin');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const router = express.Router();

// ---------- Init Firebase Admin ----------
const fbCred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
fbCred.private_key = fbCred.private_key.replace(/\n/g, '');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(fbCred),
    storageBucket: process.env.FIREBASE_BUCKET    // ex: "capy-invest.appspot.com"
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

// ---------- Init Vertex AI (env vars updated) ----------
console.log("[callReport] Vertex AI init: project=", process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
            "region=", process.env.GOOGLE_VERTEX_AI_LOCATION);
const vertex = new VertexAI({
  project : process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
  location: process.env.GOOGLE_VERTEX_AI_LOCATION || 'us-central1',
  credentials: JSON.parse(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT)
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
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'fr-FR',
    },
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
  console.log(`[callReport] Summarizing text (length=${text.length}) via Vertex AI`);
  const response = await vertex.preview.generateContent({
    model: 'models/gemini-2.0-flash-lite',
    contents: [{ role: 'user', parts: [{ text: `Résume en français :\n${text}` }] }]
  });
  const summary = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[callReport] Summary received (length=', summary.length, ')');
  return summary;
}

router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId, callerType } = req.body;
    console.log('[callReport] Received request', req.body);
    if (!recordingId || !conversationId) {
      return res.status(400).json({ error: 'recordingId et conversationId requis' });
    }

    await waitReady(recordingId);
    const downloadUrl = await getDownloadLink(recordingId);
    const audioBuf = await downloadBuffer(downloadUrl);
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    const gsUri = await saveToStorage(audioBuf, audioPath, 'audio/webm');
    await db.collection('audioRecordings').add({
      conversationId,
      fileName: audioPath,
      mimeType: 'audio/webm',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const transcription = await transcribe(gsUri);
    const txtPath = `transcriptions/${conversationId}_${Date.now()}.docx`;
    await generateDocx([{ children: [
      new Paragraph({ children:[ new TextRun({ text: 'Transcription brute', bold:true }), new TextRun({ text: `\nConversation ID : ${conversationId}\n\n` }) ] }),
      new Paragraph({ children:[ new TextRun(transcription) ] })
    ] }], txtPath);
    await db.collection('transcriptions').add({
      conversationId,
      fileName: txtPath,
      transcription,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const summary = await summarizeText(transcription);
    const summaryPath = `reports/${conversationId}_${Date.now()}.docx`;
    await generateDocx([{ children: [
      new Paragraph({ children:[ new TextRun({ text: 'Résumé IA', bold:true }), new TextRun({ text: `\nConversation ID : ${conversationId}\n\n` }) ] }),
      new Paragraph({ children:[ new TextRun(summary) ] })
    ] }], summaryPath);
    await db.collection('aiReports').add({
      conversationId,
      fileName: summaryPath,
      summary,
      consent: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('[callReport] All steps completed successfully');
    res.json({ success: true, transcriptionDoc: txtPath, summaryDoc: summaryPath });

  } catch (err) {
    console.error('[callReport] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
