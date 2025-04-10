// middlewareauth.js
const jwt = require('jsonwebtoken');

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log("Header Authorization reçu:", authHeader);  // Pour débogage

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  const token = authHeader.split(' ')[1];
  console.log("Token extrait :", token); // Vérifiez ici la valeur du token

  try {
    // Vérifier que le token est signé avec la bonne clé
    const decoded = jwt.verify(token, process.env.MEMBERSTACK_SECRET_TOKEN);
    req.member = decoded;  // Par exemple, { uid: "...", iat: ..., exp: ... }
    next();
  } catch (err) {
    console.error("Token invalide :", err);
    return res.status(401).json({ error: 'Token invalide' });
  }
}

module.exports = { requireAuth };

