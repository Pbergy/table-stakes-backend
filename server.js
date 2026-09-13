const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
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
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static('public'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', authMiddleware, require('./routes/rooms'));
app.use('/api/players', authMiddleware, require('./routes/players'));
app.use('/api/game', authMiddleware, require('./routes/game'));
app.use('/api/admin', authMiddleware, adminMiddleware, require('./routes/admin'));

// WebSocket connection handler.
// Each socket tracks its own userId/roomId so broadcasts only go to clients
// actually sitting at that table (previously this fanned out to every open
// connection on the server, leaking one room's cards/actions into another's).
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { type, userId, roomId, payload } = data;

      ws.userId = userId;
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

app.get('/health', (req, res) => res.json({ ok: true }));

server.listen(process.env.PORT || 3000, async () => {
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`);
  await db.init();
  console.log('✅ Database initialized');
});

module.exports = { app, wss, broadcastToRoom };
