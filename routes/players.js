const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Get room players
router.get('/room/:roomId', async (req, res) => {
  try {
    const room = await pool.query('SELECT is_admin_room FROM rooms WHERE id = $1', [req.params.roomId]);
    const isAdminRoom = room.rows[0]?.is_admin_room;

    const result = isAdminRoom
      ? await pool.query(
          `SELECT rp.id, rp.room_id, rp.user_id, rp.seat, rp.is_ready, rp.wants_to_play, rp.status, rp.created_at,
                  u.username, rp.chips
           FROM room_players rp JOIN users u ON rp.user_id = u.id WHERE rp.room_id = $1 ORDER BY rp.seat`,
          [req.params.roomId]
        )
      : await pool.query(
          `SELECT rp.id, rp.room_id, rp.user_id, rp.seat, rp.is_ready, rp.wants_to_play, rp.status, rp.created_at,
                  u.username, u.balance as chips
           FROM room_players rp JOIN users u ON rp.user_id = u.id WHERE rp.room_id = $1 ORDER BY rp.seat`,
          [req.params.roomId]
        );
    res.json(result.rows);
  } catch (e) {
    console.error('Get players error:', e);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Leaderboard: net chips won/lost across all rooms, all time
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.username,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('win','loss')), 0) as net_result,
              COUNT(*) FILTER (WHERE t.type = 'win') as hands_won
       FROM users u LEFT JOIN transactions t ON t.user_id = u.id
       WHERE u.is_admin = false
       GROUP BY u.id, u.username
       ORDER BY net_result DESC`
    );
    res.json(result.rows.map(r => ({
      username: r.username,
      netResult: Number(r.net_result),
      handsWon: Number(r.hands_won)
    })));
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Get my transaction/hand history (wins, losses, admin adjustments)
router.get('/me/history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get my history error:', e);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get my overall stats (hands played, net won/lost)
router.get('/me/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'win') as hands_won,
         COUNT(*) FILTER (WHERE type = 'loss') as hands_lost,
         COALESCE(SUM(amount) FILTER (WHERE type IN ('win','loss')), 0) as net_result
       FROM transactions WHERE user_id = $1`,
      [req.user.id]
    );
    const balanceResult = await pool.query('SELECT balance, is_admin FROM users WHERE id = $1', [req.user.id]);
    res.json({
      ...result.rows[0],
      hands_won: Number(result.rows[0].hands_won),
      hands_lost: Number(result.rows[0].hands_lost),
      net_result: Number(result.rows[0].net_result),
      balance: balanceResult.rows[0]?.balance ?? 0,
      is_admin: balanceResult.rows[0]?.is_admin ?? false
    });
  } catch (e) {
    console.error('Get my stats error:', e);
    res.status(500).json({ error: 'Failed to fetch stats' });
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
