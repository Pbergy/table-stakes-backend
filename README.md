# Table Stakes Backend

Production-ready backend poker game with private rooms, real-time multiplayer, and admin controls.

## Features

✅ **Multi-room poker** — Create private rooms with room codes  
✅ **Real-time gameplay** — WebSocket-based live updates  
✅ **Admin dashboard** — Manage players, adjust chips, reset games  
✅ **Persistent accounts** — Users log in and reclaim their chip balance  
✅ **Game engine** — Full Texas Hold'em implementation (preflop, flop, turn, river, showdown)  
✅ **Production-ready** — Database persistence, error handling, security  

## Tech Stack

- **Node.js + Express** — REST API server
- **PostgreSQL** — Game state and player data
- **WebSocket (ws)** — Real-time multiplayer
- **bcryptjs** — Password hashing
- **JWT** — Authentication

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up PostgreSQL

```bash
creatdb table_stakes
```

### 3. Create `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your database URL and other settings:

```
DATABASE_URL=postgresql://user:password@localhost:5432/table_stakes
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123
SESSION_SECRET=your-secret-key
CLIENT_URL=http://localhost:3001
```

### 4. Initialize database

```bash
node -e "require('./db').init()"
```

### 5. Start server

```bash
npm start
# or for development with auto-reload
npm run dev
```

## API Endpoints

### Authentication

**POST `/api/auth/register`**
```json
{ "username": "john", "email": "john@example.com", "password": "secret123" }
```

**POST `/api/auth/login`**
```json
{ "username": "john", "password": "secret123" }
```

### Rooms

**POST `/api/rooms`** — Create room
```json
{ "name": "Friday Night", "maxPlayers": 9, "settings": { "bigBlind": 20 } }
```

**GET `/api/rooms`** — List public rooms

**GET `/api/rooms/:roomCode`** — Get room details

**POST `/api/rooms/:roomId/join`** — Join room

**POST `/api/rooms/:roomId/leave`** — Leave room

### Game

**POST `/api/game/rooms/:roomId/deal`** — Start hand (admin only)

**GET `/api/game/rooms/:roomId/state`** — Get current game state

**POST `/api/game/rooms/:roomId/action`** — Make player action (fold/check/call/raise)

**GET `/api/game/rooms/:roomId/log`** — Get hand history

### Admin

**GET `/api/admin/users`** — List all users

**POST `/api/admin/users/:userId/chips`** — Give chips to player
```json
{ "amount": 500, "roomId": "room-uuid" }
```

**POST `/api/admin/rooms/:roomId/reset`** — Reset room (clear players & games)

**DELETE `/api/admin/rooms/:roomId`** — Delete room

## WebSocket Events

Connect to `ws://localhost:3000`

**Client → Server:**
```json
{ "type": "action", "userId": "uuid", "roomId": "uuid", "payload": { "type": "raise", "amount": 100 } }
{ "type": "chat", "userId": "uuid", "roomId": "uuid", "payload": { "message": "nice hand!" } }
```

**Server → Client:**
```json
{ "type": "game_update", "roomId": "uuid", "data": { ...game state } }
{ "type": "chat", "userId": "uuid", "message": "nice hand!", "timestamp": 1234567890 }
```

## Admin Dashboard

Serve `public/admin-dashboard.html` at `/admin`

- View stats (users, rooms, players)
- Search and manage users
- Give chips to players
- Delete rooms
- Monitor active games

## Deployment

### Heroku

```bash
heroku create your-app-name
heroku addons:create heroku-postgresql:hobby-dev
git push heroku main
```

### Environment Variables

Set these on your hosting platform:
- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — Random string for session encryption
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — Your admin credentials
- `CLIENT_URL` — Your frontend origin for CORS

## Security Notes

- Passwords are hashed with bcryptjs (10 rounds)
- JWT tokens require valid session secret
- Admin endpoints require admin flag in token
- WebSocket messages validate user ownership
- HTTPS recommended in production

## TODO / Future Features

- [ ] Frontend React client
- [ ] Hand strength evaluation UI
- [ ] Replay/hand history viewer
- [ ] Leaderboard
- [ ] Chat system improvements
- [ ] Mobile-responsive dashboard
- [ ] Multi-table tournaments
- [ ] Payment integration (optional)

## License

MIT
