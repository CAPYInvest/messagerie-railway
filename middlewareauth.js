const axios = require('axios');

const API_KEY = process.env.MEMBERSTACK_SECRET; // Votre clé secrète Memberstack
const BASE_URL = 'https://admin.memberstack.com/members';

/**
 * Middleware pour vérifier l'authentification via Memberstack
 */
async function requireAuth(req, res, next) {
  try {
    // Extraire le token depuis l'en-tête Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    const token = authHeader.split(' ')[1];

    // Vérifier le token en appelant l'endpoint de vérification de Memberstack
    const response = await axios.post(`${BASE_URL}/verify-token`, {
      token: token
    }, {
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // En cas de succès, response.data.data contient les informations du membre
    req.member = response.data.data; // Par exemple, { id, exp, iat, aud, iss }
    next();
  } catch (error) {
    console.error('Erreur d\'authentification Memberstack:', error.response ? error.response.data : error.message);
    // Vous pouvez différencier selon le statut de l'erreur
    if (error.response && error.response.status === 401) {
      return res.status(401).json({ error: 'Token expiré ou invalide' });
    }
    return res.status(401).json({ error: 'Authentification invalide' });
  }
}

module.exports = { requireAuth };