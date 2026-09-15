const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.SESSION_SECRET || 'dev-secret');
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Re-checks is_admin against the database rather than trusting the JWT's claim, which is
// only as fresh as whenever the token was issued — a promotion that happens after login
// (like the ADMIN_USERNAME bootstrap) would otherwise be invisible until the token expires.
const adminMiddleware = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user.is_admin = true;
    next();
  } catch (e) {
    console.error('Admin check error:', e);
    res.status(500).json({ error: 'Failed to verify admin status' });
  }
};

module.exports = { authMiddleware, adminMiddleware };
