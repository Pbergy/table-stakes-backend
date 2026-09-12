const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

const RANK_CHAR = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };

function makeDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  const deck = [];
  for (const s of suits) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ r, s });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function startHand(roomId) {
  try {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) throw new Error('Room not found');

    const players = await pool.query(
      'SELECT * FROM room_players WHERE room_id = $1 AND chips > 0 ORDER BY seat',
      [roomId]
    );

    if (players.rows.length < 2) throw new Error('Need at least 2 players');

    const settings = room.rows[0].settings;
    const deck = makeDeck();
    const gameId = uuidv4();
    const handNumber = (await pool.query('SELECT COUNT(*) as count FROM games WHERE room_id = $1', [roomId])).rows[0].count + 1;

    const gameState = {
      deck: deck.map(c => `${RANK_CHAR[c.r]}${SUIT_CHAR[c.s]}`),
      players: players.rows.map((p, i) => ({
        id: p.user_id,
        seat: p.seat,
        chips: p.chips,
        holeCards: [deck.pop(), deck.pop()],
        committed: 0,
        folded: false,
        allIn: false
      })),
      community: [],
      stage: 'preflop',
      pot: 0,
      currentTurnSeat: 0
    };

    const result = await pool.query(
      'INSERT INTO games (id, room_id, hand_number, stage, game_state) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [gameId, roomId, handNumber, 'preflop', JSON.stringify(gameState)]
    );

    await pool.query(
      'INSERT INTO game_log (id, room_id, hand_number, message) VALUES ($1, $2, $3, $4)',
      [uuidv4(), roomId, handNumber, `Hand #${handNumber} started`]
    );

    return result.rows[0];
  } catch (e) {
    console.error('Start hand error:', e);
    throw e;
  }
}

async function getGameState(roomId) {
  try {
    const result = await pool.query(
      'SELECT * FROM games WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1',
      [roomId]
    );

    if (result.rows.length === 0) {
      return { status: 'no_game' };
    }

    return result.rows[0];
  } catch (e) {
    console.error('Get game state error:', e);
    throw e;
  }
}

async function handlePlayerAction(roomId, userId, action) {
  try {
    const game = await pool.query(
      'SELECT * FROM games WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1',
      [roomId]
    );

    if (game.rows.length === 0) throw new Error('No active game');

    const gameState = game.rows[0].game_state;
    const player = gameState.players.find(p => p.id === userId);

    if (!player) throw new Error('Player not in game');

    const { type, amount } = action;

    if (type === 'fold') {
      player.folded = true;
    } else if (type === 'check') {
      // Valid only if no bet to call
    } else if (type === 'call') {
      const amountNeeded = gameState.currentBet - player.committed;
      const actualAmount = Math.min(amountNeeded, player.chips);
      player.chips -= actualAmount;
      player.committed += actualAmount;
      if (player.chips === 0) player.allIn = true;
    } else if (type === 'raise') {
      const actualAmount = Math.min(amount, player.chips);
      player.chips -= actualAmount;
      player.committed += actualAmount;
      gameState.currentBet = actualAmount;
      if (player.chips === 0) player.allIn = true;
    }

    await pool.query(
      'UPDATE games SET game_state = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(gameState), game.rows[0].id]
    );

    await pool.query(
      'INSERT INTO game_log (id, room_id, message) VALUES ($1, $2, $3)',
      [uuidv4(), roomId, `Player action: ${type}`]
    );

    return gameState;
  } catch (e) {
    console.error('Handle action error:', e);
    throw e;
  }
}

// Finalize hand winner and collect rake
async function finalizeHand(roomId, winnerId, potAmount) {
  try {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) throw new Error('Room not found');

    const rakePercent = room.rows[0].admin_rake_percent || 8;
    const rakeAmount = Math.floor(potAmount * (rakePercent / 100));
    const winnerPayout = potAmount - rakeAmount;

    // Update game with winner and rake
    await pool.query(
      'UPDATE games SET winner_id = $1, rake_collected = $2, stage = $3 WHERE room_id = $4 ORDER BY created_at DESC LIMIT 1',
      [winnerId, rakeAmount, 'complete', roomId]
    );

    // Give winner their payout (minus rake)
    await pool.query(
      'UPDATE room_players SET chips = chips + $1 WHERE user_id = $2 AND room_id = $3',
      [winnerPayout, winnerId, roomId]
    );

    // Record transaction for winner
    await pool.query(
      'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), winnerId, roomId, winnerPayout, 'win', `Won hand, pot was ${potAmount}`]
    );

    // Add rake to admin's pending balance
    await pool.query(
      'UPDATE users SET balance = balance + $1, total_rake_earned = total_rake_earned + $2 WHERE is_admin = true',
      [rakeAmount, rakeAmount]
    );

    // Log the rake collection
    const adminUser = await pool.query('SELECT id FROM users WHERE is_admin = true LIMIT 1');
    if (adminUser.rows.length > 0) {
      await pool.query(
        'INSERT INTO game_log (id, room_id, message) VALUES ($1, $2, $3)',
        [uuidv4(), roomId, `Admin collected rake: ${rakeAmount} chips (${rakePercent}% of ${potAmount})`]
      );
    }

    return { winnerId, potAmount, rakeAmount, winnerPayout };
  } catch (e) {
    console.error('Finalize hand error:', e);
    throw e;
  }
}

// Get all pending rake for admin (when they sign in)
async function getPendingRakeForAdmin(adminId) {
  try {
    const result = await pool.query(
      'SELECT balance, total_rake_earned FROM users WHERE id = $1 AND is_admin = true',
      [adminId]
    );

    if (result.rows.length === 0) {
      throw new Error('Not an admin user');
    }

    return result.rows[0];
  } catch (e) {
    console.error('Get pending rake error:', e);
    throw e;
  }
}

// Deposit pending rake to admin account (when they sign in)
async function depositPendingRakeToAdmin(adminId) {
  try {
    const admin = await pool.query(
      'SELECT id, balance FROM users WHERE id = $1 AND is_admin = true',
      [adminId]
    );

    if (admin.rows.length === 0) {
      throw new Error('Not an admin user');
    }

    const pendingBalance = admin.rows[0].balance;

    if (pendingBalance <= 0) {
      return { message: 'No pending rake to deposit', amount: 0 };
    }

    // Create deposit record
    await pool.query(
      'INSERT INTO admin_deposits (id, admin_id, amount, source, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [uuidv4(), adminId, pendingBalance, 'rake_collection']
    );

    // Record transaction
    await pool.query(
      'INSERT INTO transactions (id, user_id, amount, type, description, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [uuidv4(), adminId, pendingBalance, 'deposit', `Rake deposit: ${pendingBalance} chips`]
    );

    return {
      success: true,
      depositedAmount: pendingBalance,
      message: `Successfully deposited ${pendingBalance} chips from rake earnings`
    };
  } catch (e) {
    console.error('Deposit rake error:', e);
    throw e;
  }
}

module.exports = {
  startHand,
  getGameState,
  handlePlayerAction,
  finalizeHand,
  getPendingRakeForAdmin,
  depositPendingRakeToAdmin,
  makeDeck
};
