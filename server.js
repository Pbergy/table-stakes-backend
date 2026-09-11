const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();

const db = require('./db');
const { authMiddleware, adminMiddleware } = require('./middleware/auth');
const gameEngine = require('./engine/gameEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3001', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' }
}));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', authMiddleware, require('./routes/rooms'));
app.use('/api/players', authMiddleware, require('./routes/players'));
app.use('/api/game', authMiddleware, require('./routes/game'));
app.use('/api/admin', authMiddleware, adminMiddleware, require('./routes/admin'));

// WebSocket connection handler
const connections = new Map(); // userId -> ws

wss.on('connection', (ws, req) => {
  let userId = null;
  let roomId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { type, userId: uid, roomId: rid, payload } = data;

      userId = uid;
      roomId = rid;

      if (!connections.has(userId)) {
        connections.set(userId, []);
      }
      connections.get(userId).push(ws);

      // Route message based on type
      if (type === 'action') {
        await gameEngine.handlePlayerAction(roomId, userId, payload);
        broadcastToRoom(roomId, { type: 'game_update', data: await gameEngine.getGameState(roomId) });
      } else if (type === 'chat') {
        broadcastToRoom(roomId, { type: 'chat', userId, message: payload.message, timestamp: Date.now() });
      } else if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  });

  ws.on('close', () => {
    if (userId && connections.has(userId)) {
      const conns = connections.get(userId);
      connections.set(userId, conns.filter(c => c !== ws));
    }
  });
});

function broadcastToRoom(roomId, message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ ...message, roomId }));
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
