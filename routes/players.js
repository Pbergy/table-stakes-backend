const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Get room players
router.get('/room/:roomId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT rp.*, u.username FROM room_players rp JOIN users u ON rp.user_id = u.id WHERE rp.room_id = $1 ORDER BY rp.seat',
      [req.params.roomId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get players error:', e);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Get player
router.get('/:playerId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT rp.*, u.username FROM room_players rp JOIN users u ON rp.user_id = u.id WHERE rp.id = $1',
      [req.params.playerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Get player error:', e);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

module.exports = router;
