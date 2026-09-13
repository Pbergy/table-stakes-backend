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

// Create the admin's private invite-only room
router.post('/rooms', async (req, res) => {
  try {
    const { name = "Admin's Table", maxPlayers = 9, settings = {} } = req.body;
    const roomId = uuidv4();
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const result = await pool.query(
      `INSERT INTO rooms (id, name, creator_id, room_code, is_private, is_admin_room, max_players, settings)
       VALUES ($1, $2, $3, $4, true, true, $5, $6) RETURNING *`,
      [roomId, name, req.user.id, roomCode, maxPlayers, JSON.stringify(settings)]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Create admin room error:', e);
    res.status(500).json({ error: 'Failed to create admin room' });
  }
});

// Invite a user (by username) to an admin private room
router.post('/rooms/:roomId/invite', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username required' });
    }

    const userExists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: 'No user with that username' });
    }

    const result = await pool.query(
      `INSERT INTO room_invites (id, room_id, username, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, username) DO UPDATE SET status = 'pending'
       RETURNING *`,
      [uuidv4(), roomId, username, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Invite user error:', e);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// List invites for a room
router.get('/rooms/:roomId/invites', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM room_invites WHERE room_id = $1 ORDER BY created_at DESC',
      [req.params.roomId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('List invites error:', e);
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});

// Revoke an invite
router.delete('/rooms/:roomId/invite/:username', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM room_invites WHERE room_id = $1 AND username = $2',
      [req.params.roomId, req.params.username]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Revoke invite error:', e);
    res.status(500).json({ error: 'Failed to revoke invite' });
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
