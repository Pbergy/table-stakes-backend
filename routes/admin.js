const express = require('express');
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');
const gameEngine = require('../engine/gameEngine');

const router = express.Router();

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

// Ban or unban a user. This is deliberately a ban rather than a hard delete — the user
// may be referenced by historical hands, transactions, and rooms they created, and
// removing those rows would corrupt everyone else's game history.
router.post('/users/:username/ban', async (req, res) => {
  try {
    const { username } = req.params;
    const { banned = true } = req.body;

    const user = await pool.query('SELECT id, is_admin FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'No user with that username' });
    if (user.rows[0].is_admin) return res.status(400).json({ error: "Can't ban an admin account" });

    await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [banned, user.rows[0].id]);
    res.json({ username, banned });
  } catch (e) {
    console.error('Ban user error:', e);
    res.status(500).json({ error: 'Failed to update ban status' });
  }
});

// List all users so the admin can manage account-wide chip balances directly
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, balance, is_admin, is_banned, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('List users error:', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Give (or take, with a negative amount) chips on a user's account-wide balance.
// New accounts start at 0 — this is the only way anyone gets chips outside of winning them.
router.post('/users/:username/give-chips', async (req, res) => {
  try {
    const { username } = req.params;
    const { amount } = req.body;

    if (!Number.isFinite(Number(amount)) || Number(amount) === 0) {
      return res.status(400).json({ error: 'A non-zero numeric amount is required' });
    }

    const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'No user with that username' });

    const result = await pool.query(
      'UPDATE users SET balance = GREATEST(balance + $1, 0) WHERE id = $2 RETURNING balance',
      [Number(amount), user.rows[0].id]
    );

    await pool.query(
      'INSERT INTO transactions (id, user_id, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
      [uuidv4(), user.rows[0].id, Number(amount), Number(amount) > 0 ? 'admin_grant' : 'admin_deduction',
       `${Number(amount) > 0 ? 'Granted' : 'Deducted'} ${Math.abs(amount)} chips by admin`]
    );

    res.json({ username, balance: result.rows[0].balance });
  } catch (e) {
    console.error('Give account chips error:', e);
    res.status(500).json({ error: 'Failed to update balance' });
  }
});

// Give (or take) chips for a player at your private table — the admin acts as the bank.
router.post('/rooms/:roomId/give-chips', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { username, amount } = req.body;

    if (!username || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: 'Username and a numeric amount are required' });
    }

    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Room not found' });
    if (!room.rows[0].is_admin_room || room.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner of a private table can grant chips there' });
    }

    const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'No user with that username' });

    const seat = await pool.query('SELECT * FROM room_players WHERE room_id = $1 AND user_id = $2', [roomId, user.rows[0].id]);
    if (seat.rows.length === 0) {
      return res.status(400).json({ error: 'That player hasn\'t joined this table yet' });
    }

    const result = await pool.query(
      'UPDATE room_players SET chips = GREATEST(chips + $1, 0) WHERE room_id = $2 AND user_id = $3 RETURNING chips',
      [Number(amount), roomId, user.rows[0].id]
    );

    await pool.query(
      'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), user.rows[0].id, roomId, Number(amount), Number(amount) > 0 ? 'admin_grant' : 'admin_deduction',
       `${Number(amount) > 0 ? 'Granted' : 'Deducted'} ${Math.abs(amount)} chips at ${room.rows[0].name}`]
    );

    res.json({ username, chips: result.rows[0].chips });
  } catch (e) {
    console.error('Give chips error:', e);
    res.status(500).json({ error: 'Failed to update chips' });
  }
});

// Kick a player from a private table: force-folds them out of any in-progress hand,
// cashes their table chips back to their account balance, then removes their seat.
router.post('/rooms/:roomId/kick', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Room not found' });
    if (!room.rows[0].is_admin_room || room.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner of a private table can kick players there' });
    }

    const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'No user with that username' });

    const seat = await pool.query('SELECT chips FROM room_players WHERE room_id = $1 AND user_id = $2', [roomId, user.rows[0].id]);
    if (seat.rows.length === 0) return res.status(400).json({ error: 'That player is not seated at this table' });

    await gameEngine.forceFoldFromHand(roomId, user.rows[0].id);

    const cashedOut = seat.rows[0].chips || 0;
    if (cashedOut > 0) {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [cashedOut, user.rows[0].id]);
      await pool.query(
        'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), user.rows[0].id, roomId, cashedOut, 'cash_out', `Kicked from ${room.rows[0].name}, cashed out ${cashedOut} chips`]
      );
    }

    await pool.query('DELETE FROM room_players WHERE room_id = $1 AND user_id = $2', [roomId, user.rows[0].id]);

    try {
      const { broadcastToRoom, broadcastPerClient } = require('../server');
      const state = await gameEngine.getGameState(roomId);
      broadcastPerClient(roomId, (clientUserId) => ({
        type: 'game_update',
        data: gameEngine.maskGameStateForUser(state, clientUserId)
      }));
      broadcastToRoom(roomId, { type: 'presence', userId: user.rows[0].id, joined: false, kicked: true });
    } catch (broadcastErr) {
      console.error('Kick broadcast error:', broadcastErr);
    }

    res.json({ username, cashedOut });
  } catch (e) {
    console.error('Kick player error:', e);
    res.status(500).json({ error: 'Failed to kick player' });
  }
});

// Rename a private table
router.patch('/rooms/:roomId/rename', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'A name is required' });

    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Room not found' });
    if (!room.rows[0].is_admin_room || room.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner of a private table can rename it' });
    }

    const result = await pool.query('UPDATE rooms SET name = $1 WHERE id = $2 RETURNING *', [name.trim(), roomId]);
    res.json(result.rows[0]);
  } catch (e) {
    console.error('Rename room error:', e);
    res.status(500).json({ error: 'Failed to rename room' });
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

// List invites for a room (includes each invited player's current chip stack, if seated)
router.get('/rooms/:roomId/invites', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ri.*, rp.chips
       FROM room_invites ri
       LEFT JOIN room_players rp ON rp.room_id = ri.room_id
         AND rp.user_id = (SELECT id FROM users WHERE username = ri.username)
       WHERE ri.room_id = $1
       ORDER BY ri.created_at DESC`,
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
