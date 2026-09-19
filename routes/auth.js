const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { depositPendingRakeToAdmin } = require('../engine/gameEngine');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    const result = await pool.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, username, is_admin',
      [userId, username, email, passwordHash]
    );

    const token = jwt.sign({ id: userId, username, is_admin: false }, process.env.SESSION_SECRET || 'dev-secret', { expiresIn: '30d' });
    res.json({ token, user: result.rows[0] });
  } catch (e) {
    console.error('Register error:', e);
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.is_banned) {
      return res.status(403).json({ error: 'This account has been banned' });
    }

    // If admin, deposit pending rake earnings
    let depositResult = null;
    if (user.is_admin) {
      try {
        depositResult = await depositPendingRakeToAdmin(user.id);
        console.log('✅ Admin rake deposited:', depositResult);
      } catch (e) {
        console.error('Rake deposit error:', e);
        // Don't fail login if rake deposit fails
      }
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      process.env.SESSION_SECRET || 'dev-secret',
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        is_admin: user.is_admin,
        balance: user.balance,
        totalRakeEarned: user.total_rake_earned
      },
      depositNotification: depositResult?.message || null
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
