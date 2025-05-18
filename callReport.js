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
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');

// ——— Auth Google VertexAI via ADC ———
if (process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT) {
  const creds = JSON.parse(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT);
  const tmpPath = '/tmp/vertex.json';
  fs.writeFileSync(tmpPath, JSON.stringify(creds));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  console.log('[callReport] VertexAI creds written to', tmpPath);
}

// ——— Firebase Admin init ———
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

// ——— GenAI init ———
const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_VERTEX_AI_PROJECT_ID,
  location: process.env.GOOGLE_VERTEX_AI_LOCATION
});
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

// ——— Chargement du template Word ———
let templateBuffer = null;
(async () => {
  try {
    console.log('[callReport] Loading Word template');
    const [buf] = await bucket.file('templates/Rapport_Daily_AI_Template.docx').download();
    templateBuffer = buf;
    console.log('[callReport] Template loaded');
  } catch (err) {
    console.error('[callReport] Could not load template:', err);
  }
})();

// ——— Speech-to-Text client ———
const stCred = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
stCred.private_key = stCred.private_key.replace(/\\n/g, '\n');
const speechClient = new SpeechClient({ credentials: stCred, projectId: stCred.project_id });

// ——— Helpers ———
async function waitReady(recId, tries = 10, delay = 6000) {
  console.log(`[callReport] Waiting for recording ${recId}`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  for (let i = 0; i < tries; i++) {
    const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}`, { headers });
    console.log(`[callReport] Try ${i+1}/${tries}, status=`, data.status);
    if (['ready','finished'].includes(data.status)) return;
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error('Recording not ready in time');
}

async function getDownloadLink(recId) {
  console.log('[callReport] Generating download link');
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}/access-link`, { headers });
  return data.download_link;
}

async function downloadBuffer(url) {
  console.log('[callReport] Downloading audio buffer');
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

async function saveBuffer(buf, path, contentType) {
  console.log(`[callReport] Saving ${path}`);
  const file = bucket.file(path);
  await file.save(buf, { metadata:{ contentType } });
  return `gs://${bucket.name}/${path}`;
}

async function transcribe(gsUri) {
  console.log('[callReport] Transcribing', gsUri);
  const [op] = await speechClient.longRunningRecognize({
    audio: { uri: gsUri },
    config:{ encoding:'WEBM_OPUS', sampleRateHertz:48000, languageCode:'fr-FR' }
  });
  const [res] = await op.promise();
  return res.results.map(r=>r.alternatives[0].transcript).join('\n');
}

// --- Résumé structuré via GenAI ---
async function summarizeText(text) {
  console.log('[callReport] Summarizing via AI');
  const prompt = `
Tu es un assistant expert en comptes rendus professionnels.
À partir de cette transcription, renvoie **uniquement** un objet JSON parfaitement valide, sans balises Markdown, contenant :
  • titre            : chaîne.
  • objet            : chaîne.
  • participants     : tableau de chaînes.
  • pointsCles       : tableau de chaînes.
  • prochainesEtapes : tableau de chaînes.
  • actionsARealiser : tableau de chaînes.
  • conclusion       : chaîne.

Transcription :
${text}
`.trim();

  // envoi au modèle
  const chat = ai.chats.create({ model:'gemini-2.0-flash-001', config:generationConfig });
  let raw = '';
  for await (const chunk of await chat.sendMessageStream({ message:{ text:prompt } })) {
    if (chunk.text) raw += chunk.text;
  }
  console.log('[callReport] Raw structured summary =', raw);

  // on enlève d’éventuels ```json … ```
  let clean = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();

  // on extrait JUSTE le bloc JSON {…}
  const m = clean.match(/\{[\s\S]*\}/);
  const jsonString = m ? m[0] : clean;
  console.log('[callReport] Extracted JSON =', jsonString);

  // données de secours
  const fallback = {
    titre:            'Compte Rendu',
    objet:            '',
    participants:     [],
    pointsCles:       [],
    prochainesEtapes: [],
    actionsARealiser: [],
    conclusion:       text
  };

  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (err) {
    console.warn('[callReport] JSON.parse failed, using fallback:', err);
    data = { ...fallback };
  }

  // on s’assure que chaque clé existe et est du bon type
  return {
    titre:            typeof data.titre === 'string'      ? data.titre            : fallback.titre,
    objet:            typeof data.objet === 'string'      ? data.objet            : fallback.objet,
    participants:     Array.isArray(data.participants)    ? data.participants     : fallback.participants,
    pointsCles:       Array.isArray(data.pointsCles)      ? data.pointsCles       : fallback.pointsCles,
    prochainesEtapes: Array.isArray(data.prochainesEtapes)? data.prochainesEtapes : fallback.prochainesEtapes,
    actionsARealiser: Array.isArray(data.actionsARealiser)? data.actionsARealiser : fallback.actionsARealiser,
    conclusion:       typeof data.conclusion === 'string'? data.conclusion       : fallback.conclusion,
    // date & heure seront recalc ultérieurement côté serveur
    date:             data.date,
    heure:            data.heure
  };
}

// ——— Express router ———
const router = express.Router();
router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId, memberId } = req.body;
    if (!recordingId || !conversationId || !memberId) {
      return res.status(400).json({ error:'recordingId, conversationId et memberId requis' });
    }

    // 1) attendre + télécharger + sauvegarder audio
    await waitReady(recordingId);
    const dlUrl = await getDownloadLink(recordingId);
    const audioBuf = await downloadBuffer(dlUrl);
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    await saveBuffer(audioBuf, audioPath,'audio/webm');
    await db.collection('audioRecordings').add({
      conversationId, fileName:audioPath, mimeType:'audio/webm',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2) transcription → DOCX
    const transcription = await transcribe(`gs://${bucket.name}/${audioPath}`);
    const txtPath = `transcriptions/${conversationId}_${Date.now()}.docx`;
    const docTrans = new Document({
      sections:[{
        children:[
          new Paragraph({ text:'Transcription', heading:HeadingLevel.HEADING_2 }),
          new Paragraph({ text:transcription })
        ]
      }]
    });
    const bufDoc = await Packer.toBuffer(docTrans);
    await saveBuffer(bufDoc, txtPath,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await db.collection('transcriptions').add({
      conversationId, fileName:txtPath, transcription,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3) résumé structuré
    const data = await summarizeText(transcription);

    // 4) date & heure 100 % serveurs
    const now = new Date();
    const day   = String(now.getDate()).padStart(2,'0');
    const month = String(now.getMonth()+1).padStart(2,'0');
    const year  = String(now.getFullYear());
    data.date  = `${day}_${month}_${year}`;
    data.heure = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

    // 5) rendu du template
    if (!templateBuffer) throw new Error('Template non chargé');
    const zip = new PizZip(templateBuffer);
    let xml = zip.file('word/document.xml').asText();
    // nettoyage des balises gênantes
    xml = xml
      .replace(/<w:proofErr\b[^>]*>[\s\S]*?<\/w:proofErr>/g,'')
      .replace(/<w:proofErr\b[^>]*\/>/g,'')
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g,'')
      .replace(/<w:fldSimple\b[^>]*\/>/g,'');
    zip.file('word/document.xml', xml);

    const tpl = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start:'[%', end:'%]' }
    });

    // listes formatées
    const points = (data.pointsCles||[]).map(p=>'• '+p).join('\n');
    const etapes = (data.prochainesEtapes||[]).map((s,i)=>(i+1)+'. '+s).join('\n');

    tpl.render({
      TITRE:             data.titre,
      DATE:              data.date.replace(/_/g,'/'),
      HEURE:             data.heure,
      OBJET:             data.objet,
      PARTICIPANTS:      (data.participants||[]).join('\n'),
      POINTS_CLES:       points,
      PROCHAINES_ETAPES: etapes,
      ACTIONS_A_REALISER:(data.actionsARealiser||[]).join('\n'),
      CONCLUSION:        data.conclusion
    });

    const bufOut = tpl.getZip().generate({ type:'nodebuffer' });

    // 6) sauvegarde dans dossier member-specific
    const reportName = `Rapport_IA_du_${data.date}.docx`;
    const reportPath = `Rapport_Daily_AI/Rapport_de_${memberId}/${reportName}`;
    await saveBuffer(bufOut, reportPath,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await db.collection('Rapport_Daily_AI').add({
      conversationId, fileName:reportPath, memberId,
      ...data, consent:true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success:true, transcriptionDoc:txtPath, summaryDoc:reportPath });

  } catch (err) {
    console.error('[callReport] ERROR', err);
    return res.status(500).json({ error: err.message || err.toString() });
  }
});

module.exports = router;
