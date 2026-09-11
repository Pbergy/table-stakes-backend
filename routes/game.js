const express = require('express');
const { pool } = require('../db');
const gameEngine = require('../engine/gameEngine');

const router = express.Router();

// Start hand
router.post('/rooms/:roomId/deal', async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);

    if (room.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const game = await gameEngine.startHand(roomId);
    res.json(game);
  } catch (e) {
    console.error('Deal hand error:', e);
    res.status(500).json({ error: 'Failed to deal hand' });
  }
});

// Get game state
router.get('/rooms/:roomId/state', async (req, res) => {
  try {
    const state = await gameEngine.getGameState(req.params.roomId);
    res.json(state);
  } catch (e) {
    console.error('Get game state error:', e);
    res.status(500).json({ error: 'Failed to fetch game state' });
  }
});

// Player action
router.post('/rooms/:roomId/action', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { type, amount } = req.body;

    await gameEngine.handlePlayerAction(roomId, req.user.id, { type, amount });
    const state = await gameEngine.getGameState(roomId);

    res.json(state);
  } catch (e) {
    console.error('Player action error:', e);
    res.status(400).json({ error: e.message });
  }
});

// Get hand log
router.get('/rooms/:roomId/log', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM game_log WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.roomId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get log error:', e);
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

module.exports = router;
