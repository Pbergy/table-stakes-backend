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

// Get game state (hole cards of other players are masked until showdown)
router.get('/rooms/:roomId/state', async (req, res) => {
  try {
    const state = await gameEngine.getGameState(req.params.roomId);
    res.json(gameEngine.maskGameStateForUser(state, req.user.id));
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

    res.json(gameEngine.maskGameStateForUser(state, req.user.id));
  } catch (e) {
    console.error('Player action error:', e);
    res.status(400).json({ error: e.message });
  }
});

// Finalize hand (mark winner and collect rake)
router.post('/rooms/:roomId/finalize', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { winnerId, potAmount } = req.body;

    if (!winnerId || !potAmount) {
      return res.status(400).json({ error: 'Winner ID and pot amount required' });
    }

    const result = await gameEngine.finalizeHand(roomId, winnerId, potAmount);
    res.json(result);
  } catch (e) {
    console.error('Finalize hand error:', e);
    res.status(500).json({ error: 'Failed to finalize hand' });
  }
});

// Get full hand-by-hand results (winners, pots, rake) for a room
router.get('/rooms/:roomId/history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM hand_results WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.roomId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get hand history error:', e);
    res.status(500).json({ error: 'Failed to fetch hand history' });
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
