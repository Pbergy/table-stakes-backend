// Texas Hold'em hand evaluator
// Cards are strings like "A♠", "10♥", "K♦", "2♣" (matches gameEngine.js card format)

const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14
};
const SUITS = ['♠', '♥', '♦', '♣'];

const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8
};

const CATEGORY_NAME = {
  0: 'High Card', 1: 'Pair', 2: 'Two Pair', 3: 'Three of a Kind',
  4: 'Straight', 5: 'Flush', 6: 'Full House', 7: 'Four of a Kind', 8: 'Straight Flush'
};

function parseCard(card) {
  const suit = card.slice(-1);
  const rankStr = card.slice(0, -1);
  return { rank: RANK_VALUE[rankStr], suit };
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) {
      results.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

// Evaluate exactly 5 parsed cards -> { category, tiebreakers: [...] } comparable lexicographically
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;

  const groups = Object.entries(counts)
    .map(([rank, count]) => ({ rank: Number(rank), count }))
    .sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

  const isFlush = suits.every(s => s === suits[0]);

  // Straight detection (handles wheel: A-2-3-4-5)
  const uniqueRanks = [...new Set(ranks)];
  let straightHigh = null;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) {
      straightHigh = uniqueRanks[0];
    } else if (uniqueRanks.join(',') === '14,5,4,3,2') {
      straightHigh = 5; // wheel: 5-high straight
    }
  }

  if (straightHigh && isFlush) {
    return { category: CATEGORY.STRAIGHT_FLUSH, tiebreakers: [straightHigh] };
  }
  if (groups[0].count === 4) {
    const kicker = groups.find(g => g.count === 1).rank;
    return { category: CATEGORY.QUADS, tiebreakers: [groups[0].rank, kicker] };
  }
  if (groups[0].count === 3 && groups[1] && groups[1].count >= 2) {
    return { category: CATEGORY.FULL_HOUSE, tiebreakers: [groups[0].rank, groups[1].rank] };
  }
  if (isFlush) {
    return { category: CATEGORY.FLUSH, tiebreakers: ranks };
  }
  if (straightHigh) {
    return { category: CATEGORY.STRAIGHT, tiebreakers: [straightHigh] };
  }
  if (groups[0].count === 3) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
    return { category: CATEGORY.TRIPS, tiebreakers: [groups[0].rank, ...kickers] };
  }
  if (groups[0].count === 2 && groups[1] && groups[1].count === 2) {
    const pairs = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const kicker = groups.find(g => g.count === 1).rank;
    return { category: CATEGORY.TWO_PAIR, tiebreakers: [...pairs, kicker] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
    return { category: CATEGORY.PAIR, tiebreakers: [groups[0].rank, ...kickers] };
  }
  return { category: CATEGORY.HIGH_CARD, tiebreakers: ranks };
}

function compareEvals(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const av = a.tiebreakers[i] || 0;
    const bv = b.tiebreakers[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Best 5-card hand out of holeCards + community (7 cards total for Hold'em)
function evaluateBestHand(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards].map(parseCard);
  const combos = combinations(all, 5);
  let best = null;
  let bestCards = null;
  for (const combo of combos) {
    const evalResult = evaluate5(combo);
    if (!best || compareEvals(evalResult, best) > 0) {
      best = evalResult;
      bestCards = combo;
    }
  }
  return {
    category: best.category,
    categoryName: CATEGORY_NAME[best.category],
    tiebreakers: best.tiebreakers,
    _compareKey: best
  };
}

// Rank an array of players ({ id, holeCards, folded }) against community cards.
// Returns players sorted best-to-worst (folded players excluded), each annotated with their evaluation.
function rankPlayers(players, communityCards) {
  const active = players.filter(p => !p.folded);
  const evaluated = active.map(p => ({
    ...p,
    evaluation: evaluateBestHand(p.holeCards, communityCards)
  }));
  evaluated.sort((a, b) => compareEvals(b.evaluation._compareKey, a.evaluation._compareKey));
  return evaluated;
}

module.exports = {
  CATEGORY,
  CATEGORY_NAME,
  evaluateBestHand,
  rankPlayers,
  compareEvals: (a, b) => compareEvals(a._compareKey || a, b._compareKey || b)
};
