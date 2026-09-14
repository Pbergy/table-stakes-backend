const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

const router = express.Router();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Create room
router.post('/', async (req, res) => {
  try {
    const { name, maxPlayers = 9, settings = {} } = req.body;
    const roomId = uuidv4();
    const roomCode = generateRoomCode();

    const result = await pool.query(
      'INSERT INTO rooms (id, name, creator_id, room_code, max_players, settings) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [roomId, name, req.user.id, roomCode, maxPlayers, JSON.stringify(settings)]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Create room error:', e);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Get rooms
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms WHERE is_private = false ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) {
    console.error('Get rooms error:', e);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Get rooms I've been invited to (admin private tables)
router.get('/invited', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, ri.status as invite_status
       FROM room_invites ri
       JOIN rooms r ON r.id = ri.room_id
       WHERE ri.username = $1
       ORDER BY ri.created_at DESC`,
      [req.user.username]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Get invited rooms error:', e);
    res.status(500).json({ error: 'Failed to fetch invited rooms' });
  }
});

// Get room by code
router.get('/:roomCode', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT r.*, COUNT(rp.id) as player_count FROM rooms r LEFT JOIN room_players rp ON r.id = rp.room_id WHERE r.room_code = $1 GROUP BY r.id',
      [req.params.roomCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Get room error:', e);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// Join room
router.post('/:roomId/join', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { seat = null } = req.body;

    const roomResult = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const room = roomResult.rows[0];

    // Admin private rooms require an invite (added by the admin from the dashboard)
    if (room.is_admin_room) {
      const invite = await pool.query(
        'SELECT * FROM room_invites WHERE room_id = $1 AND username = $2',
        [roomId, req.user.username]
      );
      if (invite.rows.length === 0 && room.creator_id !== req.user.id) {
        return res.status(403).json({ error: 'This room is invite-only. Ask the admin to invite you.' });
      }
      if (invite.rows.length > 0) {
        await pool.query('UPDATE room_invites SET status = $1 WHERE id = $2', ['joined', invite.rows[0].id]);
      }
    }

    const startingChips = (room.settings && room.settings.startingChips) || 1000;

    const result = await pool.query(
      'INSERT INTO room_players (id, room_id, user_id, seat, chips) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [uuidv4(), roomId, req.user.id, seat, startingChips]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('Join room error:', e);
    res.status(400).json({ error: 'Failed to join room' });
  }
});

// Get chat history for a room
router.get('/:roomId/chat', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.roomId]
    );
    res.json(result.rows.reverse());
  } catch (e) {
    console.error('Get chat error:', e);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// Leave room
router.post('/:roomId/leave', async (req, res) => {
  try {
    await pool.query('DELETE FROM room_players WHERE room_id = $1 AND user_id = $2', [req.params.roomId, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Leave room error:', e);
    res.status(500).json({ error: 'Failed to leave room' });
  }
});

module.exports = router;
