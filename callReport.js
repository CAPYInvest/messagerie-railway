// callReport.js
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const { SpeechClient } = require('@google-cloud/speech');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');

// --- ADC pour Vertex AI ---
if (process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT) {
  const creds = JSON.parse(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT);
  const tmpPath = '/tmp/vertex-service-account.json';
  fs.writeFileSync(tmpPath, JSON.stringify(creds));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  console.log('[callReport] Wrote AI creds to', tmpPath);
}

// --- Firebase ---
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

// --- GenAI ---
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

// --- Charger le template Word ---
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

// --- Speech-to-Text ---
const stCred = JSON.parse(process.env.GOOGLE_SPEECH_TO_TEXT_SERVICE_ACCOUNT);
stCred.private_key = stCred.private_key.replace(/\\n/g, '\n');
const speechClient = new SpeechClient({ credentials: stCred, projectId: stCred.project_id });

// --- Helpers (waitReady, getDownloadLink, downloadBuffer, saveBuffer) ---
async function waitReady(recId, tries = 10, delay = 6000) {
  console.log(`[callReport] Waiting for recording ${recId}`);
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  for (let i = 0; i < tries; i++) {
    const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}`, { headers });
    console.log(`[callReport] Try ${i+1}/${tries}, status=`, data.status);
    if (data.status === 'ready' || data.status === 'finished') return;
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error('Recording not ready');
}
async function getDownloadLink(recId) {
  console.log('[callReport] Generating download link');
  const headers = { Authorization: `Bearer ${process.env.DAILY_API_KEY}` };
  const { data } = await axios.get(`https://api.daily.co/v1/recordings/${recId}/access-link`, { headers });
  return data.download_link;
}
async function downloadBuffer(url) {
  console.log('[callReport] Downloading audio');
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}
async function saveBuffer(buf, path, contentType) {
  console.log(`[callReport] Saving ${path}`);
  const file = bucket.file(path);
  // extrait juste le nom final
  const filename = path.split('/').pop();
  await file.save(buf, {
    metadata: {
      contentType,
      // ce metadata sera utilisé par Firebase Console et par les signed URLs
      contentDisposition: `attachment; filename="${filename}"`
    }
  });
  return `gs://${bucket.name}/${path}`;
}

// --- Transcription ---
async function transcribe(gsUri) {
  console.log('[callReport] Transcribing', gsUri);
  const [op] = await speechClient.longRunningRecognize({
    audio: { uri: gsUri },
    config: { encoding:'WEBM_OPUS', sampleRateHertz:48000, languageCode:'fr-FR' }
  });
  const [res] = await op.promise();
  return res.results.map(r => r.alternatives[0].transcript).join('\n');
}

// --- Résumé structuré via GenAI ---
async function summarizeText(text) {
  console.log('[callReport] Summarizing via AI');
  const prompt = `
Tu es un assistant spécialisé en comptes rendus professionnels, expert en finance personnelle. 
À partir de la transcription ci-dessous, génère un objet JSON parfaitement formatté comprenant les clés suivantes :

  • titre            : chaîne. Titre concis du compte-rendu.
  • date             : chaîne au format JJ_MM_YYYY (date du jour).
  • heure            : chaîne au format HH:mm (heure du serveur).
  • objet            : chaîne. Contexte et objectif principal de la conversation.
  • participants     : liste de chaînes. Nom ou rôle de chaque intervenant.
  • pointsCles       : liste de chaînes. 3 à 5 points essentiels discutés.
  • prochainesEtapes : liste de chaînes. Actions à planifier suite à la réunion.
  • actionsARealiser : liste de chaînes. Tâches concrètes à réaliser immédiatement.
  • conclusion       : chaîne. Synthèse finale et recommandation.

**Contraintes de style** :  
- Rédige chaque valeur en phrases complètes, claires et professionnelles.  
- N’utilise pas de balises Markdown, ne renvoie que l’objet JSON.  
- Respecte strictement la syntaxe JSON (virgules, guillemets).  

Transcription :  
${text}
`.trim();
  const chat = ai.chats.create({ model:'gemini-2.0-flash-001', config:generationConfig });
  let out = '';
  for await (const chunk of await chat.sendMessageStream({ message:{ text:prompt } })) {
    if (chunk.text) out += chunk.text;
  }
  console.log('[callReport] Raw structured summary =', out);
  const clean = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  console.log('[callReport] Clean JSON =', clean);
  try { return JSON.parse(clean); }
  catch {
    const now = new Date();
    return {
      titre:'Compte Rendu',
      date: now.toLocaleDateString('fr-FR'),
      heure: now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}),
      objet:'', participants:[], pointsCles:[], prochainesEtapes:[], actionsARealiser:[], conclusion:text
    };
  }
}

// --- Route principale ---
const router = express.Router();
router.post('/', async (req, res) => {
  try {
    const { recordingId, conversationId, memberId } = req.body;
    if (!recordingId || !conversationId || !memberId) {
      return res.status(400).json({ error:'recordingId, conversationId et memberId sont requis' });
    }

    // 1) Wait → Download → Save audio
    await waitReady(recordingId);
    const dlUrl    = await getDownloadLink(recordingId);
    const audioBuf = await downloadBuffer(dlUrl);
    const audioPath = `temp_audio/${conversationId}_${Date.now()}.webm`;
    await saveBuffer(audioBuf, audioPath,'audio/webm');
    await db.collection('audioRecordings').add({
      conversationId, fileName:audioPath, mimeType:'audio/webm',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2) Transcription → DOCX
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

    // 3) Générer le résumé structuré
    const data = await summarizeText(transcription);

    // 1️⃣ On fixe la date de façon fiable
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth()+1).padStart(2, '0');
    const year = String(now.getFullYear());
    data.date = `${day}_${month}_${year}`;     // remplace data.date IA
    data.heure = now.toLocaleTimeString('fr-FR', { 
      hour:   '2-digit',
      minute: '2-digit'
      });

    // 2️⃣ On génère le rapport à partir du template
if (!templateBuffer) throw new Error('Template not loaded');

// 1) On dézippe le buffer et on nettoie word/document.xml
const zip = new PizZip(templateBuffer);
const docXmlPath = 'word/document.xml';
let xml = zip.file(docXmlPath).asText();

// Retirer les balises <w:proofErr ...>...</w:proofErr> et les formes self-closing
xml = xml
  .replace(/<w:proofErr\b[^>]*>[\s\S]*?<\/w:proofErr>/g, '')
  .replace(/<w:proofErr\b[^>]*\/>/g, '');

// On réinjecte le XML nettoyé dans le zip
zip.file(docXmlPath, xml);

// 2) On peut maintenant instancier Docxtemplater sans erreur de "proofErr"
const tpl = new Docxtemplater(zip, {
  paragraphLoop: true,
  linebreaks: true,
  delimiters: { start: '[%', end: '%]' }
});

// 3) On prépare nos listes en bullets et numéros
const points = (data.pointsCles||[]).map(p => `• ${p}`).join('\n');
const etapes = (data.prochainesEtapes||[])
  .map((step,i) => `${i+1}. ${step}`)
  .join('\n');

// 4) On renderise
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

// 5) On génère le buffer final
const bufOut = tpl.getZip().generate({ type: 'nodebuffer' });




    // 5) Enregistrer sous member-specific folder
    // -> on remplace les "/" et espaces de la date par "_"
    const reportName = `Rapport_IA_du_${data.date}.docx`;
    const reportPath = `Rapport_Daily_AI/Rapport_de_${req.body.memberId}/${reportName}`;

    // 4️⃣ Sauvegarde
    await saveBuffer(bufOut,
                reportPath,
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await db.collection('Rapport_Daily_AI')
        .add({ conversationId, fileName: reportPath, ...data,
               consent:true,
               createdAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ success:true, transcriptionDoc:txtPath, summaryDoc:reportPath });
  } catch (err) {
    console.error('[callReport] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
