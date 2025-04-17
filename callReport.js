// callReport.js
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const { SpeechClient } = require('@google-cloud/speech');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

// Auth GoogleGenAI via ADC
if (process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT) {
  const creds = JSON.parse(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT);
  const tmpPath = '/tmp/vertex-service-account.json';
  fs.writeFileSync(tmpPath, JSON.stringify(creds));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  console.log(`[callReport] Wrote AI creds to ${tmpPath}`);
}

// Init GenAI client
const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
  location: process.env.GOOGLE_VERTEX_AI_LOCATION
});
// Generation configuration
const generationConfig = {
  maxOutputTokens: 8192,
  temperature: 1,
  topP: 0.95,
  responseModalities: ['TEXT'],
  safetySettings: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }
  ]
};

const router = express.Router();

// Init Firebase Admin
const fbCred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
fbCred.private_key = fbCred.private_key.replace(/\\n/g, '\n');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(fbCred),
    storageBucket: process.env.FIREBASE_BUCKET
  });
}
const bucket = admin.storage().bucket();
const db = admin.firestore();

// Init Speech-to-Text
const stCred = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
stCred.private_key = stCred.private_key.replace(/\\n/g, '\n');
const speechClient = new SpeechClient({ credentials: stCred, projectId: stCred.project_id });

// Helper: Poll until recording is ready
async function waitReady(recId, maxTries = 10, delayMs = 6000) {
  console.log(`[callReport] Waiting for recording ${recId} to be ready...`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  for (let i = 0; i < maxTries; i++) {
    const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}`, { headers });
    console.log(`[callReport] Try ${i+1}/${maxTries}, status=`, data.status);
    if (data.status === 'ready' || data.status === 'finished') return;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Recording not ready after timeout');
}

// Helper: get signed download link
async function getDownloadLink(recId) {
  console.log(`[callReport] Generating download link`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}/access-link`, { headers });
  return data.download_link;
}

// Helper: download binary
async function downloadBuffer(url) {
  console.log(`[callReport] Downloading audio buffer`);
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

// Helper: save buffer to Firebase Storage
async function saveBuffer(buffer, path, contentType) {
  console.log(`[callReport] Saving ${path}`);
  const file = bucket.file(path);
  await file.save(buffer, { metadata: { contentType } });
  return `gs://${bucket.name}/${path}`;
}

// Transcription
async function transcribe(gsUri) {
  console.log(`[callReport] Transcribing ${gsUri}`);
  const [op] = await speechClient.longRunningRecognize({
    audio: { uri: gsUri },
    config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'fr-FR' }
  });
  const [res] = await op.promise();
  return res.results.map(r => r.alternatives[0].transcript).join('\n');
}

// Generate DOCX helper
async function generateDocx(sections, path) {
  console.log(`[callReport] Generating DOCX ${path}`);
  const doc = new Document({ sections });
  const buf = await Packer.toBuffer(doc);
  await saveBuffer(buf, path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

// Summarization using GoogleGenAI
async function summarizeText(text) {
  console.log('[callReport] Summarizing via GoogleGenAI');
  const prompt = `A partir de cette transcription, génère un Rapport / Compte rendu de réunion académique avec date du jour:\n${text}`;
  const msg = { text: prompt };
  const chat = ai.chats.create({ model: 'gemini-2.0-flash-001', config: generationConfig });
  let summary = '';
  for await (const chunk of await chat.sendMessageStream({ message: msg })) {
    if (chunk.text) summary += chunk.text;
  }
  if (!summary) summary = text;
  return summary;
}

// Main route
router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId } = req.body;
    console.log('[callReport] Request', req.body);
    if (!recordingId || !conversationId) return res.status(400).json({ error: 'Missing data' });

    // wait and download
    await waitReady(recordingId);
    const dl = await getDownloadLink(recordingId);
    const bufAudio = await downloadBuffer(dl);

    // store raw audio
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    const gsAudio = await saveBuffer(bufAudio, audioPath, 'audio/webm');
    await db.collection('audioRecordings').add({ conversationId, fileName: audioPath, mimeType: 'audio/webm', createdAt: admin.firestore.FieldValue.serverTimestamp() });

    // transcription
    const transcription = await transcribe(gsAudio);
    const txtPath = `transcriptions/${conversationId}_${Date.now()}.docx`;
    await generateDocx([{
      children: [
        new Paragraph({ text: 'Transcription brute', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: `Conversation ID : ${conversationId}`, spacing: { after: 200 } }),
        new Paragraph({ text: transcription })
      ]
    }], txtPath);
    await db.collection('transcriptions').add({ conversationId, fileName: txtPath, transcription, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    // summarize
    const summary = await summarizeText(transcription);
    // format date for filename and doc
    const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    const safeDate = today.replace(/\s+/g, '_');
    const summaryPath = `Rapport_Daily_AI/Rapport_du_${safeDate}_${conversationId}.docx`;

    await generateDocx([{
      children: [
        new Paragraph({ text: `Compte Rendu du ${today}`, heading: HeadingLevel.TITLE, thematicBreak: true }),
        new Paragraph({ text: `Conversation ID : ${conversationId}`, spacing: { after: 300 } }),
        new Paragraph({ text: summary })
      ]
    }], summaryPath);
    await db.collection('Rapport_Daily_AI').add({ conversationId, fileName: summaryPath, summary, consent: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    console.log('[callReport] Success');
    res.json({ success: true, transcriptionDoc: txtPath, summaryDoc: summaryPath });
  } catch (err) {
    console.error('[callReport] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
