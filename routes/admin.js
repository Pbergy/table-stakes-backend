const express = require('express');
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Get all users
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, is_admin, balance, total_rake_earned, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) {
    console.error('Get users error:', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get admin earnings dashboard
router.get('/earnings', async (req, res) => {
  try {
    // Get current admin user
    const adminResult = await pool.query('SELECT id, balance, total_rake_earned FROM users WHERE id = $1 AND is_admin = true', [req.user.id]);
    
    if (adminResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not an admin user' });
    }

    const admin = adminResult.rows[0];

    // Get recent deposits
    const depositsResult = await pool.query(
      'SELECT * FROM admin_deposits WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );

    // Get rake by room (last 30 days)
    const rakeByRoomResult = await pool.query(
      `SELECT r.id, r.name, SUM(g.rake_collected) as total_rake, COUNT(g.id) as hands_played
       FROM games g
       JOIN rooms r ON g.room_id = r.id
       WHERE g.created_at > NOW() - INTERVAL '30 days'
       AND g.rake_collected > 0
       GROUP BY r.id, r.name
       ORDER BY total_rake DESC`,
      []
    );

    res.json({
      currentBalance: admin.balance,
      totalEarned: admin.total_rake_earned,
      recentDeposits: depositsResult.rows,
      rakeByRoom: rakeByRoomResult.rows
    });
  } catch (e) {
    console.error('Get earnings error:', e);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// Update user chips (admin gives chips)
router.post('/users/:userId/chips', async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, roomId } = req.body;

    // Update room player chips
    const result = await pool.query(
      'UPDATE room_players SET chips = chips + $1 WHERE user_id = $2 AND room_id = $3 RETURNING *',
      [amount, userId, roomId]
    );

    // Log transaction
    await pool.query(
      'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), userId, roomId, amount, 'admin', `Admin adjusted chips by ${amount}`]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Update chips error:', e);
    res.status(500).json({ error: 'Failed to update chips' });
  }
});

// Reset room
router.post('/rooms/:roomId/reset', async (req, res) => {
  try {
    const { roomId } = req.params;

    await pool.query('DELETE FROM room_players WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM games WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM game_log WHERE room_id = $1', [roomId]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Reset room error:', e);
    res.status(500).json({ error: 'Failed to reset room' });
  }
});

// Delete room
router.delete('/rooms/:roomId', async (req, res) => {
  try {
    await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.roomId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete room error:', e);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// Get all rooms
router.get('/rooms', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT r.*, COUNT(rp.id) as player_count, COALESCE(SUM(g.rake_collected), 0) as total_rake FROM rooms r LEFT JOIN room_players rp ON r.id = rp.room_id LEFT JOIN games g ON r.id = g.room_id GROUP BY r.id ORDER BY r.created_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get rooms error:', e);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

module.exports = router;
