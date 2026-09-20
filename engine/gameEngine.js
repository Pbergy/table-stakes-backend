const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');
const handEvaluator = require('./handEvaluator');

const RANK_CHAR = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const TURN_TIME_LIMIT_MS = 45000;

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

function cardStr(c) {
  return `${RANK_CHAR[c.r]}${SUIT_CHAR[c.s]}`;
}

// --- Turn-order helpers -----------------------------------------------

function nextActivePos(players, fromPos, { includeAllIn = false } = {}) {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const pos = (fromPos + i) % n;
    const p = players[pos];
    if (!p.folded && (includeAllIn || !p.allIn)) return pos;
  }
  return null;
}

function activeCount(players) {
  return players.filter(p => !p.folded).length;
}

function contestingCount(players) {
  return players.filter(p => !p.folded && !p.allIn).length;
}

// --- Side pot calculation ------------------------------------------------

// Side pots should only fragment around actual ALL-IN thresholds — not around wherever
// someone happened to fold. Folding just removes a player from contention for everything
// in the pot; it never creates a legitimate boundary. (A previous version of this used
// every distinct commitment level as a tier, which orphaned money with zero eligible
// winners whenever a fold happened after committing more than the remaining player did —
// a completely normal situation, not just an all-in edge case.)
function computeSidePots(players) {
  const contributors = players.filter(p => p.totalCommitted > 0);
  const allInLevels = [...new Set(contributors.filter(p => p.allIn).map(p => p.totalCommitted))].sort((a, b) => a - b);

  if (allInLevels.length === 0) {
    const amount = contributors.reduce((sum, p) => sum + p.totalCommitted, 0);
    const eligiblePlayerIds = contributors.filter(p => !p.folded).map(p => p.id);
    return amount > 0 ? [{ amount, eligiblePlayerIds }] : [];
  }

  const remaining = contributors.map(p => ({ id: p.id, totalCommitted: p.totalCommitted, folded: p.folded }));
  const rawPots = [];
  let prevLevel = 0;
  for (const level of [...allInLevels, Infinity]) {
    const tierSize = level === Infinity ? null : level - prevLevel;
    let amount = 0;
    const eligibleSet = new Set();
    for (const p of remaining) {
      if (p.totalCommitted <= 0) continue;
      const take = tierSize === null ? p.totalCommitted : Math.min(p.totalCommitted, tierSize);
      if (take <= 0) continue;
      amount += take;
      p.totalCommitted -= take;
      if (!p.folded) eligibleSet.add(p.id);
    }
    if (amount > 0) rawPots.push({ amount, eligiblePlayerIds: [...eligibleSet] });
    if (level !== Infinity) prevLevel = level;
  }

  // Merge adjacent tiers that share the exact same eligible winners — can still happen
  // when a fold occurs between two all-in levels without changing who's eligible.
  const merged = [];
  for (const pot of rawPots) {
    const last = merged[merged.length - 1];
    const sameEligibility = last &&
      last.eligiblePlayerIds.length === pot.eligiblePlayerIds.length &&
      last.eligiblePlayerIds.every(id => pot.eligiblePlayerIds.includes(id));
    if (sameEligibility) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligiblePlayerIds: pot.eligiblePlayerIds });
    }
  }
  return merged;
}

// --- Hand lifecycle --------------------------------------------------

async function startHand(roomId) {
  try {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) throw new Error('Room not found');

    const playersRes = room.rows[0].is_admin_room
      ? await pool.query(
          `SELECT rp.id, rp.room_id, rp.user_id, rp.seat, rp.chips
           FROM room_players rp
           WHERE rp.room_id = $1 AND rp.chips > 0 AND rp.wants_to_play = true ORDER BY rp.seat`,
          [roomId]
        )
      : await pool.query(
          `SELECT rp.id, rp.room_id, rp.user_id, rp.seat, u.balance as chips
           FROM room_players rp JOIN users u ON u.id = rp.user_id
           WHERE rp.room_id = $1 AND u.balance > 0 ORDER BY rp.seat`,
          [roomId]
        );

    if (playersRes.rows.length < 2) throw new Error('Need at least 2 players');

    const settings = room.rows[0].settings || {};
    const smallBlind = settings.smallBlind || 10;
    const bigBlind = settings.bigBlind || 20;
    const rakePercent = room.rows[0].admin_rake_percent ?? 8;

    const deck = makeDeck();
    const gameId = uuidv4();
    const handNumber = Number((await pool.query('SELECT COUNT(*) as count FROM games WHERE room_id = $1', [roomId])).rows[0].count) + 1;

    const players = playersRes.rows.map(p => ({
      id: p.user_id,
      seat: p.seat,
      chips: p.chips,
      holeCards: [cardStr(deck.pop()), cardStr(deck.pop())],
      committed: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false
    }));

    const n = players.length;
    const dealerPos = (handNumber - 1) % n;
    const sbPos = n === 2 ? dealerPos : (dealerPos + 1) % n;
    const bbPos = n === 2 ? (dealerPos + 1) % n : (dealerPos + 2) % n;

    function postBlind(pos, amount) {
      const actual = Math.min(amount, players[pos].chips);
      players[pos].chips -= actual;
      players[pos].committed += actual;
      players[pos].totalCommitted += actual;
      if (players[pos].chips === 0) players[pos].allIn = true;
      return actual;
    }
    postBlind(sbPos, smallBlind);
    postBlind(bbPos, bigBlind);

    const firstToAct = n === 2 ? sbPos : nextActivePos(players, bbPos);

    const gameState = {
      deck: deck.map(cardStr),
      players,
      community: [],
      stage: 'preflop',
      pot: 0,
      currentBet: bigBlind,
      smallBlind,
      bigBlind,
      rakePercent,
      dealerPos,
      sbPos,
      bbPos,
      currentTurnPos: firstToAct,
      turnStartedAt: Date.now(),
      needsToAct: players.map((p, i) => i).filter(i => !players[i].folded && !players[i].allIn),
      handNumber,
      roomId,
      isAdminRoom: room.rows[0].is_admin_room
    };

    const result = await pool.query(
      'INSERT INTO games (id, room_id, hand_number, stage, dealer_seat, game_state) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [gameId, roomId, handNumber, 'preflop', players[dealerPos].seat, JSON.stringify(gameState)]
    );

    await pool.query(
      'INSERT INTO game_log (id, room_id, hand_number, message) VALUES ($1, $2, $3, $4)',
      [uuidv4(), roomId, handNumber, `Hand #${handNumber} started — blinds ${smallBlind}/${bigBlind}`]
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
    const gameRow = game.rows[0];
    const gameState = gameRow.game_state;

    if (gameState.stage === 'complete' || gameState.stage === 'showdown') {
      throw new Error('Hand is already finished');
    }

    const pos = gameState.currentTurnPos;
    const player = gameState.players[pos];

    if (!player || player.id !== userId) throw new Error('Not your turn');
    if (player.folded || player.allIn) throw new Error('You cannot act');

    const { type, amount } = action;

    if (type === 'fold') {
      player.folded = true;
    } else if (type === 'check') {
      if (gameState.currentBet > player.committed) throw new Error('Cannot check, there is a bet to call');
    } else if (type === 'call') {
      const amountNeeded = gameState.currentBet - player.committed;
      const actual = Math.max(0, Math.min(amountNeeded, player.chips));
      player.chips -= actual;
      player.committed += actual;
      player.totalCommitted += actual;
      if (player.chips === 0) player.allIn = true;
    } else if (type === 'raise' || type === 'bet') {
      const targetTotal = Number(amount); // total committed this street after the raise
      if (!(targetTotal > gameState.currentBet)) throw new Error('Raise must exceed the current bet');
      const actual = Math.min(targetTotal - player.committed, player.chips);
      player.chips -= actual;
      player.committed += actual;
      player.totalCommitted += actual;
      gameState.currentBet = player.committed;
      if (player.chips === 0) player.allIn = true;
    } else {
      throw new Error('Unknown action type');
    }

    gameState.needsToAct = gameState.needsToAct.filter(p => p !== pos);
    if (type === 'raise' || type === 'bet') {
      gameState.needsToAct = gameState.players
        .map((p, i) => i)
        .filter(i => i !== pos && !gameState.players[i].folded && !gameState.players[i].allIn);
    }

    await pool.query(
      'INSERT INTO game_log (id, room_id, hand_number, message) VALUES ($1, $2, $3, $4)',
      [uuidv4(), roomId, gameState.handNumber, `Player action: ${type}`]
    );

    if (activeCount(gameState.players) === 1) {
      await closeStreetAndAdvance(gameState, gameRow.id, true);
    } else if (gameState.needsToAct.length === 0) {
      await closeStreetAndAdvance(gameState, gameRow.id, false);
    } else {
      gameState.currentTurnPos = nextActivePos(gameState.players, pos);
      gameState.turnStartedAt = Date.now();
    }

    await pool.query(
      'UPDATE games SET game_state = $1, stage = $2, updated_at = NOW() WHERE id = $3',
      [JSON.stringify(gameState), gameState.stage, gameRow.id]
    );

    return gameState;
  } catch (e) {
    console.error('Handle action error:', e);
    throw e;
  }
}

// Moves committed chips into the pot and either deals the next street or runs the showdown.
async function closeStreetAndAdvance(gameState, gameId, singleWinner) {
  const streetTotal = gameState.players.reduce((sum, p) => sum + p.committed, 0);
  gameState.pot += streetTotal;
  gameState.players.forEach(p => { p.committed = 0; });
  gameState.currentBet = 0;

  if (singleWinner) {
    await runShowdown(gameState, gameId);
    return;
  }

  if (gameState.stage === 'preflop') {
    gameState.community.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
    gameState.stage = 'flop';
  } else if (gameState.stage === 'flop') {
    gameState.community.push(gameState.deck.pop());
    gameState.stage = 'turn';
  } else if (gameState.stage === 'turn') {
    gameState.community.push(gameState.deck.pop());
    gameState.stage = 'river';
  } else if (gameState.stage === 'river') {
    await runShowdown(gameState, gameId);
    return;
  }

  if (contestingCount(gameState.players) <= 1) {
    await closeStreetAndAdvance(gameState, gameId, false);
    return;
  }

  gameState.needsToAct = gameState.players
    .map((p, i) => i)
    .filter(i => !gameState.players[i].folded && !gameState.players[i].allIn);
  gameState.currentTurnPos = nextActivePos(gameState.players, gameState.dealerPos);
  gameState.turnStartedAt = Date.now();
}

async function runShowdown(gameState, gameId) {
  gameState.stage = 'showdown';

  const pots = computeSidePots(gameState.players);
  const rakePercent = gameState.rakePercent ?? 8;
  const nonFoldedCount = activeCount(gameState.players);

  let totalRake = 0;
  const potBreakdown = [];

  for (const pot of pots) {
    const rakeAmount = Math.floor(pot.amount * (rakePercent / 100));
    const distributable = pot.amount - rakeAmount;
    totalRake += rakeAmount;

    let winners;
    if (nonFoldedCount === 1) {
      winners = pot.eligiblePlayerIds.map(id => ({ id }));
    } else {
      const eligiblePlayers = gameState.players.filter(p => pot.eligiblePlayerIds.includes(p.id));
      const ranked = handEvaluator.rankPlayers(eligiblePlayers, gameState.community);
      const topEval = ranked[0].evaluation._compareKey;
      winners = ranked
        .filter(r => handEvaluator.compareEvals(r.evaluation._compareKey, topEval) === 0)
        .map(r => ({ id: r.id, handCategory: r.evaluation.categoryName }));
    }

    const share = Math.floor(distributable / winners.length);
    let remainder = distributable - share * winners.length;
    winners.forEach(w => {
      const payout = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const player = gameState.players.find(p => p.id === w.id);
      if (player) player.chips += payout;
      w.payout = payout;
    });

    potBreakdown.push({ amount: pot.amount, rakeAmount, distributable, winners });
  }

  gameState.stage = 'complete';
  gameState.rakeCollected = totalRake;
  gameState.potBreakdown = potBreakdown;

  await persistHandResult(gameState, gameId, totalRake, potBreakdown);
}

async function persistHandResult(gameState, gameId, totalRake, potBreakdown) {
  const roomId = gameState.roomId;

  // Regular rooms use the account-wide bankroll (users.balance) so winnings follow the
  // player everywhere. Admin private rooms use their own per-table chip pool instead —
  // players start at 0 there and only the admin can grant them chips.
  for (const p of gameState.players) {
    if (gameState.isAdminRoom) {
      await pool.query('UPDATE room_players SET chips = $1 WHERE room_id = $2 AND user_id = $3', [p.chips, roomId, p.id]);
    } else {
      await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [p.chips, p.id]);
    }
  }

  // Record a win/loss transaction per participant for hand-history purposes
  for (const p of gameState.players) {
    const won = potBreakdown.reduce((sum, pb) => sum + (pb.winners.find(w => w.id === p.id)?.payout || 0), 0);
    const net = won - p.totalCommitted;
    if (net !== 0) {
      await pool.query(
        'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), p.id, roomId, net, net > 0 ? 'win' : 'loss', `Hand #${gameState.handNumber}: ${net > 0 ? 'won' : 'lost'} ${Math.abs(net)} chips`]
      );
    }
  }

  if (totalRake > 0) {
    await pool.query(
      'UPDATE users SET balance = balance + $1, total_rake_earned = total_rake_earned + $2 WHERE is_admin = true',
      [totalRake, totalRake]
    );
    await pool.query(
      'INSERT INTO game_log (id, room_id, hand_number, message) VALUES ($1, $2, $3, $4)',
      [uuidv4(), roomId, gameState.handNumber, `Admin collected rake: ${totalRake} chips`]
    );
  }

  const totalPot = potBreakdown.reduce((s, p) => s + p.amount, 0);
  const allWinners = potBreakdown.flatMap(p => p.winners.map(w => ({ ...w, potAmount: p.amount })));

  const usernames = await pool.query('SELECT id, username FROM users WHERE id = ANY($1)', [gameState.players.map(p => p.id)]);
  const usernameById = Object.fromEntries(usernames.rows.map(u => [u.id, u.username]));

  const results = {
    players: gameState.players.map(p => ({
      id: p.id,
      username: usernameById[p.id],
      holeCards: p.holeCards,
      folded: p.folded,
      totalCommitted: p.totalCommitted,
      finalChips: p.chips
    })),
    pots: potBreakdown.map(pb => ({
      amount: pb.amount,
      rakeAmount: pb.rakeAmount,
      winners: pb.winners.map(w => ({ id: w.id, username: usernameById[w.id], payout: w.payout, handCategory: w.handCategory }))
    }))
  };

  await pool.query(
    `INSERT INTO hand_results (id, room_id, game_id, hand_number, pot_amount, rake_amount, rake_percent, community_cards, results)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv4(), roomId, gameId, gameState.handNumber, totalPot, totalRake, gameState.rakePercent ?? 8, JSON.stringify(gameState.community), JSON.stringify(results)]
  );

  await pool.query(
    'UPDATE games SET winner_id = $1, rake_collected = $2, community_cards = $3, pot = $4, game_state = $5, stage = $6, updated_at = NOW() WHERE id = $7',
    [allWinners[0]?.id || null, totalRake, JSON.stringify(gameState.community), totalPot, JSON.stringify(gameState), 'complete', gameId]
  );

  await pool.query(
    'INSERT INTO game_log (id, room_id, hand_number, message) VALUES ($1, $2, $3, $4)',
    [uuidv4(), roomId, gameState.handNumber, `Hand #${gameState.handNumber} complete — pot ${totalPot}, rake ${totalRake}`]
  );
}

// Manual override — mark a hand's winner/pot directly (kept for admin/manual use).
async function finalizeHand(roomId, winnerId, potAmount) {
  try {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (room.rows.length === 0) throw new Error('Room not found');

    const rakePercent = room.rows[0].admin_rake_percent || 8;
    const rakeAmount = Math.floor(potAmount * (rakePercent / 100));
    const winnerPayout = potAmount - rakeAmount;

    await pool.query(
      'UPDATE games SET winner_id = $1, rake_collected = $2, stage = $3 WHERE room_id = $4 AND id = (SELECT id FROM games WHERE room_id = $4 ORDER BY created_at DESC LIMIT 1)',
      [winnerId, rakeAmount, 'complete', roomId]
    );

    if (room.rows[0].is_admin_room) {
      await pool.query(
        'UPDATE room_players SET chips = chips + $1 WHERE room_id = $2 AND user_id = $3',
        [winnerPayout, roomId, winnerId]
      );
    } else {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [winnerPayout, winnerId]
      );
    }

    await pool.query(
      'INSERT INTO transactions (id, user_id, room_id, amount, type, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), winnerId, roomId, winnerPayout, 'win', `Won hand, pot was ${potAmount}`]
    );

    await pool.query(
      'UPDATE users SET balance = balance + $1, total_rake_earned = total_rake_earned + $2 WHERE is_admin = true',
      [rakeAmount, rakeAmount]
    );

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

async function getPendingRakeForAdmin(adminId) {
  try {
    const result = await pool.query(
      'SELECT balance, total_rake_earned FROM users WHERE id = $1 AND is_admin = true',
      [adminId]
    );
    if (result.rows.length === 0) throw new Error('Not an admin user');
    return result.rows[0];
  } catch (e) {
    console.error('Get pending rake error:', e);
    throw e;
  }
}

async function depositPendingRakeToAdmin(adminId) {
  try {
    const admin = await pool.query('SELECT id, balance FROM users WHERE id = $1 AND is_admin = true', [adminId]);
    if (admin.rows.length === 0) throw new Error('Not an admin user');

    const pendingBalance = admin.rows[0].balance;
    if (pendingBalance <= 0) return { message: 'No pending rake to deposit', amount: 0 };

    await pool.query(
      'INSERT INTO admin_deposits (id, admin_id, amount, source, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [uuidv4(), adminId, pendingBalance, 'rake_collection']
    );

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

// Hide other players' hole cards from a given viewer. Cards are only revealed for
// players who reached showdown without folding (everyone else stays hidden forever).
function maskGameStateForUser(gameRow, userId) {
  if (!gameRow || !gameRow.game_state || !gameRow.game_state.players) return gameRow;
  const revealAll = gameRow.game_state.stage === 'complete' || gameRow.game_state.stage === 'showdown';
  const masked = {
    ...gameRow,
    game_state: {
      ...gameRow.game_state,
      players: gameRow.game_state.players.map(p => {
        const isMine = p.id === userId;
        const showdownReveal = revealAll && !p.folded;
        return isMine || showdownReveal ? p : { ...p, holeCards: p.holeCards.map(() => '??') };
      })
    }
  };
  return masked;
}

// Force-folds a player out of whatever hand is in progress (used when the admin kicks
// someone from a private table) without requiring it to be their turn. Safe to call even
// if they're not currently in a hand.
async function forceFoldFromHand(roomId, userId) {
  const game = await pool.query(
    'SELECT * FROM games WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1',
    [roomId]
  );
  if (game.rows.length === 0) return;
  const gameRow = game.rows[0];
  const gameState = gameRow.game_state;
  if (!gameState || ['complete', 'showdown'].includes(gameState.stage)) return;

  const pos = gameState.players.findIndex(p => p.id === userId);
  if (pos === -1 || gameState.players[pos].folded) return;

  gameState.players[pos].folded = true;
  gameState.needsToAct = gameState.needsToAct.filter(p => p !== pos);

  if (activeCount(gameState.players) === 1) {
    await closeStreetAndAdvance(gameState, gameRow.id, true);
  } else {
    if (gameState.currentTurnPos === pos) {
      gameState.currentTurnPos = nextActivePos(gameState.players, pos);
    }
    if (gameState.needsToAct.length === 0) {
      await closeStreetAndAdvance(gameState, gameRow.id, false);
    }
  }

  await pool.query(
    'UPDATE games SET game_state = $1, stage = $2, updated_at = NOW() WHERE id = $3',
    [JSON.stringify(gameState), gameState.stage, gameRow.id]
  );
}

module.exports = {
  startHand,
  getGameState,
  handlePlayerAction,
  finalizeHand,
  getPendingRakeForAdmin,
  depositPendingRakeToAdmin,
  maskGameStateForUser,
  forceFoldFromHand,
  makeDeck,
  TURN_TIME_LIMIT_MS
};
