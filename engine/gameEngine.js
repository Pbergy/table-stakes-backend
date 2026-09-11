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

module.exports = {
  startHand,
  getGameState,
  handlePlayerAction,
  makeDeck
};
