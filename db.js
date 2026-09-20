const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/table_stakes'
});

async function init() {
  try {
    const client = await pool.connect();
    
    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT false,
        balance INT DEFAULT 0,
        total_rake_earned INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        creator_id UUID NOT NULL REFERENCES users(id),
        room_code VARCHAR(10) UNIQUE NOT NULL,
        is_private BOOLEAN DEFAULT true,
        is_admin_room BOOLEAN DEFAULT false,
        max_players INT DEFAULT 9,
        status VARCHAR(20) DEFAULT 'waiting',
        settings JSONB DEFAULT '{}',
        admin_rake_percent FLOAT DEFAULT 8.0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS room_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        username VARCHAR(50) NOT NULL,
        invited_by UUID REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, username)
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id),
        username VARCHAR(50),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hand_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        game_id UUID REFERENCES games(id) ON DELETE CASCADE,
        hand_number INT,
        pot_amount INT,
        rake_amount INT,
        rake_percent FLOAT,
        community_cards JSONB,
        results JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS room_players (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id),
        seat INT,
        chips INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'waiting',
        folded BOOLEAN DEFAULT false,
        all_in BOOLEAN DEFAULT false,
        is_ready BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(room_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS games (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        hand_number INT NOT NULL,
        stage VARCHAR(20) DEFAULT 'preflop',
        dealer_seat INT,
        community_cards JSONB DEFAULT '[]',
        pot INT DEFAULT 0,
        side_pots JSONB DEFAULT '[]',
        game_state JSONB DEFAULT '{}',
        winner_id UUID REFERENCES users(id),
        rake_collected INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS game_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        hand_number INT,
        message TEXT,
        user_id UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        room_id UUID REFERENCES rooms(id),
        amount INT NOT NULL,
        type VARCHAR(20),
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_deposits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL REFERENCES users(id),
        amount INT NOT NULL,
        source VARCHAR(50),
        game_ids UUID[],
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safety net: CREATE TABLE IF NOT EXISTS is a no-op when the table already exists,
    // so if this database's tables were first created by an older version of this schema,
    // newer columns silently never get added — that's exactly what happened here (this
    // database was missing users.balance and games.rake_collected, columns that should
    // have existed from day one). Cover every column explicitly so this can't recur.
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_rake_earned INT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,

      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_admin_room BOOLEAN DEFAULT false`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT true`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_players INT DEFAULT 9`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'waiting'`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS admin_rake_percent FLOAT DEFAULT 8.0`,
      `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,

      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS is_ready BOOLEAN DEFAULT false`,
      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS wants_to_play BOOLEAN DEFAULT true`,
      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS chips INT DEFAULT 0`,
      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'waiting'`,
      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS folded BOOLEAN DEFAULT false`,
      `ALTER TABLE room_players ADD COLUMN IF NOT EXISTS all_in BOOLEAN DEFAULT false`,

      `ALTER TABLE games ADD COLUMN IF NOT EXISTS stage VARCHAR(20) DEFAULT 'preflop'`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS dealer_seat INT`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS community_cards JSONB DEFAULT '[]'`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS pot INT DEFAULT 0`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS side_pots JSONB DEFAULT '[]'`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS game_state JSONB DEFAULT '{}'`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS winner_id UUID REFERENCES users(id)`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS rake_collected INT DEFAULT 0`,
      `ALTER TABLE games ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`
    ];
    for (const sql of migrations) {
      await client.query(sql);
    }

    console.log('✅ Tables initialized');
    client.release();

    await ensureAdminAccount();
  } catch (e) {
    console.error('❌ Database init error:', e);
  }
}

// Create (or promote) the admin account from ADMIN_USERNAME/ADMIN_PASSWORD env vars.
// Without this, is_admin is never true for anyone and rake has nowhere to go.
async function ensureAdminAccount() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.log('ℹ️  ADMIN_USERNAME/ADMIN_PASSWORD not set — skipping admin bootstrap');
    return;
  }

  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  const existing = await pool.query('SELECT id, is_admin FROM users WHERE username = $1', [username]);

  if (existing.rows.length === 0) {
    const passwordHash = await bcrypt.hash(password, 10);
    const adminId = uuidv4();
    await pool.query(
      'INSERT INTO users (id, username, password_hash, is_admin) VALUES ($1, $2, $3, true)',
      [adminId, username, passwordHash]
    );
    console.log(`✅ Created admin account "${username}"`);
    await ensureDefaultPrivateRoom(adminId);
  } else if (!existing.rows[0].is_admin) {
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [existing.rows[0].id]);
    console.log(`✅ Promoted existing account "${username}" to admin`);
    await ensureDefaultPrivateRoom(existing.rows[0].id);
  } else {
    await ensureDefaultPrivateRoom(existing.rows[0].id);
  }
}

// Give the admin a ready-made invite-only table ("Private 1") so they don't have to
// create one manually before inviting anyone.
async function ensureDefaultPrivateRoom(adminId) {
  // System-wide check (not just this exact admin id) — there's only ever one admin in this
  // app, so this is a stronger guarantee against ever creating a second "Private 1" table.
  const existingRoom = await pool.query(
    'SELECT id FROM rooms WHERE is_admin_room = true LIMIT 1'
  );
  if (existingRoom.rows.length > 0) return;

  const { v4: uuidv4 } = require('uuid');
  const roomId = uuidv4();
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  await pool.query(
    `INSERT INTO rooms (id, name, creator_id, room_code, is_private, is_admin_room, max_players, settings)
     VALUES ($1, 'Private 1', $2, $3, true, true, 9, '{}')`,
    [roomId, adminId, roomCode]
  );
  console.log(`✅ Created default private room "Private 1" for admin`);
}

module.exports = { pool, init };
