export const ARENA_POWER_UP_DURATION_MS = 30_000;
export const ARENA_POWER_UP_COOLDOWN_MS = 90_000;
export const ARENA_POWER_UP_BARRAGE_INITIAL_DELAY_MS = 3_000;
export const ARENA_POWER_UP_BARRAGE_INTERVAL_MS = 6_000;
export const ARENA_POWER_UP_BARRAGE_STAGGER_MS = 250;

export const ARENA_POWER_UP_RANK_MULTIPLIERS = Object.freeze([4.25, 3.55, 3.0]);

export const ARENA_POWER_UP_ATTACK_ROTATION = Object.freeze([
  { label: 'NOVA', effect: 'pulse', color: '#7afcff' },
  { label: 'OVERDRIVE', effect: 'railgun', color: '#f6c95b' },
  { label: 'COMET DRIVE', effect: 'comet', color: '#ff8f45' },
  { label: 'ARC STORM', effect: 'arc', color: '#99ffda' },
]);

export function arenaContributionPoints(type = '', amount = 1) {
  const value = Math.max(0, Number(amount) || 0);
  switch (String(type || '').toLowerCase()) {
    case 'comment':
    case 'chat':
      return 1;
    case 'like':
      return Math.min(5, value * 0.5);
    case 'follow':
      return 12;
    case 'share':
      return 10;
    case 'repost':
      return 20;
    case 'gift':
      return Math.min(500, value);
    default:
      return 0;
  }
}

export function parseArenaPowerCommand(text = '') {
  const match = String(text || '').match(/(?:^|\s)!(nova|overdrive)\b/i);
  return match ? match[1].toLowerCase() : null;
}

export function nextArenaPowerAttack(index = 0) {
  const safeIndex = Math.max(0, Math.floor(Number(index) || 0));
  return ARENA_POWER_UP_ATTACK_ROTATION[safeIndex % ARENA_POWER_UP_ATTACK_ROTATION.length];
}

export function arenaPowerMultiplierForRank(rank) {
  const idx = Math.max(0, Math.floor(Number(rank) || 0) - 1);
  return ARENA_POWER_UP_RANK_MULTIPLIERS[idx] || 0;
}

export function rankArenaContributors(contributors = {}, players = {}, limit = 3) {
  return Object.values(contributors || {})
    .filter(item => item?.uniqueId && Number(item.score) > 0)
    .sort((a, b) => {
      const scoreDiff = (Number(b.score) || 0) - (Number(a.score) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const eventDiff = (Number(b.events) || 0) - (Number(a.events) || 0);
      if (eventDiff !== 0) return eventDiff;
      return (Number(a.firstAt) || 0) - (Number(b.firstAt) || 0);
    })
    .slice(0, Math.max(1, Number(limit) || 3))
    .map((item, index) => {
      const player = players?.[item.uniqueId] || {};
      const rank = index + 1;
      return {
        uniqueId: item.uniqueId,
        nickname: item.nickname || player.nickname || item.uniqueId,
        score: Math.round((Number(item.score) || 0) * 10) / 10,
        rank,
        multiplier: arenaPowerMultiplierForRank(rank),
        color: player.color || item.color || '',
        events: Number(item.events) || 0,
      };
    });
}

export function addArenaContribution(state, players, input = {}) {
  if (!state?.active || !input.uniqueId) return { points: 0, topContributors: state?.topContributors || [] };
  const points = arenaContributionPoints(input.type, input.amount);
  if (points <= 0) return { points: 0, topContributors: state.topContributors || [] };

  if (!state.contributors || typeof state.contributors !== 'object') state.contributors = {};
  const now = Math.max(0, Number(input.now) || Date.now());
  const key = String(input.uniqueId);
  const current = state.contributors[key] || {
    uniqueId: key,
    nickname: input.nickname || key,
    score: 0,
    events: 0,
    firstAt: now,
    lastAt: now,
  };
  current.nickname = input.nickname || current.nickname || key;
  current.score = (Number(current.score) || 0) + points;
  current.events = (Number(current.events) || 0) + 1;
  current.lastAt = now;
  current[input.type] = (Number(current[input.type]) || 0) + points;
  state.contributors[key] = current;
  state.topContributors = rankArenaContributors(state.contributors, players, 3);
  return { points, topContributors: state.topContributors };
}
