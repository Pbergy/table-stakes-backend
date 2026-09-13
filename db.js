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

    // Safety net for databases created before this column/table existed
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_admin_room BOOLEAN DEFAULT false;`);

    console.log('✅ Tables initialized');
    client.release();
  } catch (e) {
    console.error('❌ Database init error:', e);
  }
}

module.exports = { pool, init };
