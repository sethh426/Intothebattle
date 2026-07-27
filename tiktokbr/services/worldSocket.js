import db from '../db/db.js';

// Real data binding for the Aetheris homepage globe's kingdom escalation. Deliberately
// NOT coupled to the battle overlay's hot event path (emitRoomEvent/dispatchRoomEvent):
// this is a self-contained periodic poll over a separate Socket.IO namespace, so
// anonymous, high-fan-out homepage marketing traffic can never share a path with
// low-latency battle events. See the Aetheris plan doc §10(B) for the full design.

const RECENT_ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "currently active" participant window
const DEFAULT_POLL_INTERVAL_MS = 20_000; // matches the frontend's WEATHER.tickSeconds cadence

// Reasoned starting points, not measured -- tune once real usage data exists.
const TIER_THRESHOLDS = [
  { tier: 'packed', min: 40 },
  { tier: 'high', min: 15 },
  { tier: 'medium', min: 5 },
];

function computeViewerTier(activeCount) {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (activeCount >= min) return tier;
  }
  return 'low';
}

// Territory -> real data join path: an active claim (unclaimed_at IS NULL) gives a
// room_id, which is the same room_id used throughout live_sessions/room_player_stats.
// active_count is a proxy for "engagement," not a raw TikTok viewer count -- no such
// signal is captured anywhere in this codebase today (see plan doc §10 for why).
function fetchClaimedTerritoryActivity() {
  const recentThreshold = Date.now() - RECENT_ACTIVE_WINDOW_MS;
  return db
    .prepare(
      `SELECT
         wtc.territory_id AS territory_id,
         wtc.room_id AS room_id,
         ls.id AS live_session_id,
         (
           SELECT COUNT(*) FROM room_player_stats rps
           WHERE rps.room_id = wtc.room_id AND rps.alive = 1 AND rps.last_active >= ?
         ) AS active_count
       FROM world_territory_claims wtc
       LEFT JOIN live_sessions ls
         ON ls.room_id = wtc.room_id AND ls.status = 'active' AND ls.ended_at IS NULL
       WHERE wtc.unclaimed_at IS NULL`
    )
    .all(recentThreshold);
}

function computeKingdomStates() {
  const rows = fetchClaimedTerritoryActivity();
  const states = {};
  for (const row of rows) {
    const isLive = row.live_session_id != null;
    const activeCount = Number(row.active_count) || 0;
    states[row.territory_id] = {
      isLive,
      viewerTier: isLive ? computeViewerTier(activeCount) : 'off',
    };
  }
  return states;
}

// Only the territories whose state actually changed since the last broadcast, plus any
// territory that dropped out of the claimed set entirely (reverts to off/not-live).
function diffStates(prev, next) {
  const changed = {};
  for (const [id, state] of Object.entries(next)) {
    const prior = prev[id];
    if (!prior || prior.isLive !== state.isLive || prior.viewerTier !== state.viewerTier) {
      changed[id] = state;
    }
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) changed[id] = { isLive: false, viewerTier: 'off' };
  }
  return { changed, hasChanges: Object.keys(changed).length > 0 };
}

// Sets up the /aetheris-world namespace: a full snapshot on connect, then periodic
// delta broadcasts. Skips the DB query entirely when nobody is connected. Returns a
// { stop() } handle for tests/shutdown.
export function initWorldSocket(io, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.logger ?? console;
  const worldNs = io.of('/aetheris-world');

  let lastBroadcastState = {};

  // Populate initial state immediately at startup -- without this, the first client to
  // connect before the first timer tick fires (up to pollIntervalMs later) would get an
  // empty snapshot instead of the real current state.
  try {
    lastBroadcastState = computeKingdomStates();
  } catch (err) {
    log.error('Aetheris world-state initial query failed', err);
  }

  worldNs.on('connection', (socket) => {
    socket.emit('kingdomStateSnapshot', lastBroadcastState);
  });

  function poll() {
    if (worldNs.sockets.size === 0) return;
    let nextState;
    try {
      nextState = computeKingdomStates();
    } catch (err) {
      log.error('Aetheris world-state query failed', err);
      return;
    }
    const { changed, hasChanges } = diffStates(lastBroadcastState, nextState);
    lastBroadcastState = nextState;
    if (hasChanges) worldNs.emit('kingdomStateUpdate', changed);
  }

  const interval = setInterval(poll, pollIntervalMs);
  return { stop: () => clearInterval(interval) };
}
