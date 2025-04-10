const jwt = require('jsonwebtoken');
const axios = require('axios');

// Exemple de middleware requireAuth dans middlewareauth.js :
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  const token = authHeader.split(' ')[1];

  try {
    // Utilisez ici la clé pour vérifier le token personnalisé
    const decoded = jwt.verify(token, process.env.MEMBERSTACK_SECRET_TOKEN);
    req.member = decoded; // Par exemple, { uid: "mem_cm76iojn20avf0spj2h050pp9", iat: ..., exp: ... }
    next();
  } catch (err) {
    console.error("Token invalide :", err);
    return res.status(401).json({ error: 'Token invalide' });
  }
}

module.exports = { requireAuth };
