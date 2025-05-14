// callReport.js
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
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

// Load Word template once at startup
let templateBuffer = null;
(async () => {
  try {
    console.log('[callReport] Loading Word template');
    const [buf] = await bucket.file('templates/Rapport_Daily_AI_Template.docx').download();
    templateBuffer = buf;
    console.log('[callReport] Template loaded');
  } catch (err) {
    console.error('[callReport] Failed to load template:', err);
  }
})();

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

// Summarization using GoogleGenAI with structured JSON output
async function summarizeText(text) {
  console.log('[callReport] Summarizing via GoogleGenAI with structured format');
  const prompt = `Tu es un assistant expert en rédaction de comptes rendus. À partir de cette transcription, génère un rapport structuré au format JSON avec les clés suivantes :
titre: chaîne, date: chaîne (format JJ MMMM YYYY), objet: chaîne, participants: liste de chaînes, pointsCles: liste de chaînes, prochainesEtapes: liste de chaînes, actionsARealiser (liste), conclusion: chaîne.
Transcription :
${text}`;
  const msg = { text: prompt };
  const chat = ai.chats.create({ model: 'gemini-2.0-flash-001', config: generationConfig });
  let result = '';
  for await (const chunk of await chat.sendMessageStream({ message: msg })) {
    if (chunk.text) result += chunk.text;
  }
  console.log('[callReport] Raw structured summary =', result);

  // On nettoie d’éventuels blocs Markdown ```json … ```
  let clean = result.trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  console.log('[callReport] Clean JSON string =', clean);

  let data;
  try {
    data = JSON.parse(clean);
  } catch (e) {
    console.warn('[callReport] JSON parsing failed, using fallback summary');
    data = {
      titre: 'Compte Rendu',
      date: new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }),
      objet: '',
      participants: [],
      pointsCles: [],
      prochainesEtapes: [],
      actionsARealiser: [],
      conclusion: clean || text
    };
  }
  return data;
}



// Main route
router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId } = req.body;
    if (!recordingId || !conversationId) return res.status(400).json({ error: 'Missing data' });

    // 1) Poll & download
    await waitReady(recordingId);
    const dlUrl = await getDownloadLink(recordingId);
    const audioBuf = await downloadBuffer(dlUrl);
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    await saveBuffer(audioBuf, audioPath, 'audio/webm');
    await db.collection('audioRecordings').add({ conversationId, fileName: audioPath, mimeType:'audio/webm', createdAt: admin.firestore.FieldValue.serverTimestamp() });

    // 2) Transcription
    const transcription = await transcribe(`gs://${bucket.name}/${audioPath}`);
    const txtPath = `transcriptions/${conversationId}_${Date.now()}.docx`;
    await generateDocx([
      { children: [ new Paragraph({ text: 'Transcription', heading: HeadingLevel.HEADING_2 }), new Paragraph({ text: transcription }) ] }
    ], txtPath);
    await db.collection('transcriptions').add({ conversationId, fileName: txtPath, transcription, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    // 3) Summarization
    const data = await summarizeText(transcription);

    // 4) Populate template
    if (!templateBuffer) throw new Error('Template not loaded');
    const zip = new PizZip(templateBuffer);
    const docxTemplate = new Docxtemplater(zip, { paragraphLoop:true, linebreaks:true });
    docxTemplate.setData({
      TITRE: data.titre,
      DATE: data.date,
      HEURE: data.heure,
      OBJET: data.objet,
      PARTICIPANTS: data.participants.join('\n'),
      POINTS_CLES: data.pointsCles.join('\n'),
      PROCHAINES_ETAPES: data.prochainesEtapes.join('\n'),
      ACTIONS_A_REALISER: data.actionsARealiser.join('\n'),
      CONCLUSION: data.conclusion,
      CONVERSATION_ID: conversationId
    });
    docxTemplate.render();
    const bufOut = docxTemplate.getZip().generate({ type:'nodebuffer' });

    // 5) Save final report
    const safeDate = data.date.replace(/\s+/g,'_');
    const summaryPath = `Rapport_Daily_AI/Rapport_du_${safeDate}_${conversationId}.docx`;
    await saveBuffer(bufOut, summaryPath, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await db.collection('Rapport_Daily_AI').add({ conversationId, fileName: summaryPath, ...data, consent:true, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ success:true, transcriptionDoc: txtPath, summaryDoc: summaryPath });
  } catch (err) {
    console.error('[callReport] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
