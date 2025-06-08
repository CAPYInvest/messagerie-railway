/**
 * Middleware d'authentification
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');

/**
 * Middleware pour vérifier le token JWT
 */
const verifyToken = (req, res, next) => {
    try {
        // Récupérer le token du header Authorization
        const authHeader = req.headers.authorization;
        console.log('[Auth] Header Authorization reçu:', authHeader);

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.error('[Auth] Token manquant ou format invalide');
            return res.status(401).json({ error: 'Token d\'authentification manquant' });
        }

        // Extraire le token
        const token = authHeader.split(' ')[1];
        console.log('[Auth] Token extrait:', token);

        // Vérifier le token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('[Auth] Token décodé:', decoded);

        // Ajouter les informations du membre à la requête
        req.member = {
            uid: decoded.uid
        };

        next();
    } catch (error) {
        console.error('[Auth] Erreur de vérification du token:', error);
        return res.status(401).json({ error: 'Token invalide' });
    }
};

module.exports = {
    verifyToken
}; 