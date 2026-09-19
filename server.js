const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const db = require('./db');
const { pool } = db;
const { authMiddleware, adminMiddleware } = require('./middleware/auth');
const gameEngine = require('./engine/gameEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3001', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Auth uses signed JWTs, not cookies, so there's no session store to maintain here —
// this app previously ran an unused express-session instance whose in-memory store was
// actively warning about production memory leaks in the logs for no benefit.

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts — please wait a few minutes and try again' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/rooms', authMiddleware, require('./routes/rooms'));
app.use('/api/players', authMiddleware, require('./routes/players'));
app.use('/api/game', authMiddleware, require('./routes/game'));
app.use('/api/admin', authMiddleware, adminMiddleware, require('./routes/admin'));

// WebSocket connection handler.
// The connection itself is authenticated with a verified JWT (passed as a query param)
// rather than trusting whatever userId a message claims — previously any client could
// send an action or chat message as any userId with zero verification.
wss.on('connection', async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) { ws.close(4001, 'No token provided'); return; }

    const decoded = jwt.verify(token, process.env.SESSION_SECRET || 'dev-secret');
    const userCheck = await pool.query('SELECT is_banned FROM users WHERE id = $1', [decoded.id]);
    if (userCheck.rows.length === 0 || userCheck.rows[0].is_banned) {
      ws.close(4003, 'Unauthorized');
      return;
    }
    ws.userId = decoded.id; // verified identity — every handler below uses this, never a client-supplied value
  } catch (e) {
    ws.close(4001, 'Invalid or expired token');
    return;
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { type, roomId, payload } = data;
      const userId = ws.userId;

      ws.roomId = roomId;

      if (type === 'action') {
        await gameEngine.handlePlayerAction(roomId, userId, payload);
        const state = await gameEngine.getGameState(roomId);
        // Each client gets its own hole cards masked/unmasked appropriately —
        // never broadcast one shared payload that reveals everyone's cards.
        broadcastPerClient(roomId, (clientUserId) => ({
          type: 'game_update',
          data: gameEngine.maskGameStateForUser(state, clientUserId)
        }));
        if (state.stage === 'complete') {
          broadcastToRoom(roomId, { type: 'hand_complete', data: state.game_state?.potBreakdown || null });
        }
      } else if (type === 'chat') {
        const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
        const username = userRes.rows[0]?.username || 'unknown';
        await pool.query(
          'INSERT INTO chat_messages (id, room_id, user_id, username, message) VALUES ($1, $2, $3, $4, $5)',
          [uuidv4(), roomId, userId, username, payload.message]
        );
        broadcastToRoom(roomId, { type: 'chat', userId, username, message: payload.message, timestamp: Date.now() });
      } else if (type === 'join') {
        broadcastToRoom(roomId, { type: 'presence', userId, joined: true }, ws);
      } else if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message || 'Invalid message' }));
    }
  });

  ws.on('close', () => {
    if (ws.roomId) broadcastToRoom(ws.roomId, { type: 'presence', userId: ws.userId, joined: false }, ws);
  });
});

function broadcastToRoom(roomId, message, excludeWs = null) {
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      client.send(JSON.stringify({ ...message, roomId }));
    }
  });
}

// Like broadcastToRoom, but builds a distinct payload per recipient (used so hole cards
// can be masked per-viewer instead of sending one identical object to the whole table).
function broadcastPerClient(roomId, buildMessageForUser) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      client.send(JSON.stringify({ ...buildMessageForUser(client.userId), roomId }));
    }
  });
}

// Turn clock: any player who sits on their turn past the time limit gets auto-folded (or
// auto-checked if there's nothing to call) so one slow/AFK player can't stall the table.
setInterval(async () => {
  try {
    const active = await pool.query(
      `SELECT DISTINCT ON (room_id) room_id, stage, game_state
       FROM games ORDER BY room_id, created_at DESC`
    );
    for (const row of active.rows) {
      if (['complete', 'showdown'].includes(row.stage)) continue;
      const gs = row.game_state;
      if (!gs || !gs.turnStartedAt) continue;
      if (Date.now() - gs.turnStartedAt < gameEngine.TURN_TIME_LIMIT_MS) continue;

      const player = gs.players[gs.currentTurnPos];
      if (!player) continue;
      const actionType = gs.currentBet > player.committed ? 'fold' : 'check';

      try {
        await gameEngine.handlePlayerAction(row.room_id, player.id, { type: actionType });
        const state = await gameEngine.getGameState(row.room_id);
        broadcastPerClient(row.room_id, (clientUserId) => ({
          type: 'game_update',
          data: gameEngine.maskGameStateForUser(state, clientUserId)
        }));
        broadcastToRoom(row.room_id, { type: 'chat', username: 'Table', message: `${actionType === 'fold' ? 'Folded' : 'Checked'} — time expired` });
        if (state.stage === 'complete') {
          broadcastToRoom(row.room_id, { type: 'hand_complete', data: state.game_state?.potBreakdown || null });
        }
      } catch (actionErr) {
        console.error('Auto-fold error for room', row.room_id, actionErr.message);
      }
    }
  } catch (e) {
    console.error('Turn timer sweep error:', e);
  }
}, 3000);

app.get('/health', (req, res) => res.json({ ok: true }));

server.listen(process.env.PORT || 3000, async () => {
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`);
  await db.init();
  console.log('✅ Database initialized');
});

module.exports = { app, wss, broadcastToRoom, broadcastPerClient };
