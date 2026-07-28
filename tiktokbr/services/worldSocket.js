import db from '../db/db.js';

// Real data binding for the Aetheris homepage globe's kingdom escalation. Deliberately
// NOT coupled to the battle overlay's hot event path (emitRoomEvent/dispatchRoomEvent):
// this is a self-contained periodic poll over a separate Socket.IO namespace, so
// anonymous, high-fan-out homepage marketing traffic can never share a path with
// low-latency battle events.

const RECENT_ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "currently active" participant window
const DEFAULT_POLL_INTERVAL_MS = 20_000; // matches the frontend's WEATHER.tickSeconds cadence
const MAX_AUTO_CLAIM_ROOMS = 40;

const SHAPE_IDS = ['blob-1', 'blob-2', 'crescent', 'star', 'hex', 'ring', 'shard', 'spit', 'cluster'];
const WORLD_BIOMES = [
  { id: 'frozen-crown', landCount: 10, latBand: [72, 90], colorHex: '#8fd6ff' },
  { id: 'thunder-highlands', landCount: 5, latBand: [60, 72], colorHex: '#9db4ff' },
  { id: 'whispering-desert', landCount: 11, latBand: [42, 60], colorHex: '#ffcf7a' },
  { id: 'ancient-jungle', landCount: 13, latBand: [22, 42], colorHex: '#7be08a' },
  { id: 'emerald-wilds', landCount: 18, latBand: [-2, 22], colorHex: '#a8e6a1' },
  { id: 'liquid-blu-metal-sea', landCount: 9, latBand: [-16, -2], colorHex: '#3fd0ff' },
  { id: 'molten-wastes', landCount: 6, latBand: [-28, -16], colorHex: '#ff6a2b' },
  { id: 'toxic-expanse', landCount: 7, latBand: [-40, -28], colorHex: '#9dff5c' },
  { id: 'crystal-basin', landCount: 8, latBand: [-54, -40], colorHex: '#7ee8ff' },
  { id: 'void-scar', landCount: 13, latBand: [-90, -54], colorHex: '#b26bff' },
];

const CANONICAL_TERRITORY_COUNT = WORLD_BIOMES.reduce((sum, biome) => sum + biome.landCount, 0);
let worldTerritoriesSeeded = false;

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

function scoreRoom(row) {
  const activeCount = Number(row.active_count) || 0;
  const kills = Number(row.kills) || 0;
  const liveBonus = row.is_live ? 200 : 0;
  return liveBonus + activeCount * 25 + kills * 10;
}

function hashString(value = '') {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function ensureWorldTerritories() {
  if (worldTerritoriesSeeded) return;
  const existing = Number(db.prepare('SELECT COUNT(*) AS count FROM world_territories').get()?.count) || 0;
  if (existing >= CANONICAL_TERRITORY_COUNT) {
    worldTerritoriesSeeded = true;
    return;
  }

  const insert = db.prepare(`
    INSERT INTO world_territories (
      id, biome_id, shape_id, lat, lon, angular_radius, rotation, color_hex
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);

  let globalIndex = 0;
  for (const biome of WORLD_BIOMES) {
    const lat = (biome.latBand[0] + biome.latBand[1]) / 2;
    for (let index = 0; index < biome.landCount; index += 1) {
      const lon = ((globalIndex * 137.507764) % 360) - 180;
      insert.run(
        `terr-${biome.id}-${index}`,
        biome.id,
        SHAPE_IDS[globalIndex % SHAPE_IDS.length],
        lat,
        lon,
        0.04,
        ((globalIndex * 0.61803398875) % 1) * Math.PI * 2,
        biome.colorHex,
      );
      globalIndex += 1;
    }
  }
  worldTerritoriesSeeded = true;
}

function fetchTopPerformingRooms() {
  const recentThreshold = Date.now() - RECENT_ACTIVE_WINDOW_MS;
  const rows = db.prepare(`
    SELECT
      ur.room_id AS room_id,
      COALESCE(
        NULLIF(ta.display_name, ''),
        NULLIF(u.tiktok_username, ''),
        NULLIF(ta.tiktok_username, ''),
        NULLIF(u.name, ''),
        NULLIF(ur.room_name, ''),
        ur.room_id
      ) AS holder_name,
      EXISTS (
        SELECT 1 FROM live_sessions ls
        WHERE ls.room_id = ur.room_id
          AND ls.status = 'active'
          AND ls.ended_at IS NULL
      ) AS is_live,
      COALESCE(stats.active_count, 0) AS active_count,
      COALESCE(stats.kills, 0) AS kills,
      COALESCE(stats.last_active, 0) AS last_active
    FROM user_rooms ur
    JOIN users u ON u.id = ur.user_id
    LEFT JOIN tiktok_accounts ta ON ta.user_id = u.id AND COALESCE(ta.status, 'connected') = 'connected'
    LEFT JOIN (
      SELECT
        room_id,
        SUM(CASE WHEN alive = 1 AND last_active >= ? THEN 1 ELSE 0 END) AS active_count,
        COALESCE(SUM(kills), 0) AS kills,
        COALESCE(MAX(last_active), 0) AS last_active
      FROM room_player_stats
      GROUP BY room_id
    ) stats ON stats.room_id = ur.room_id
    WHERE
      COALESCE(stats.active_count, 0) > 0
      OR COALESCE(stats.kills, 0) > 0
      OR EXISTS (
        SELECT 1 FROM live_sessions ls
        WHERE ls.room_id = ur.room_id
          AND ls.status = 'active'
          AND ls.ended_at IS NULL
      )
  `).all(recentThreshold);

  return rows
    .map((row) => ({ ...row, score: scoreRoom(row) }))
    .filter((row) => row.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || Number(b.last_active || 0) - Number(a.last_active || 0)
      || String(a.room_id).localeCompare(String(b.room_id))
    )
    .slice(0, MAX_AUTO_CLAIM_ROOMS);
}

function assignClaimsForTopRooms() {
  ensureWorldTerritories();

  const topRooms = fetchTopPerformingRooms();
  if (!topRooms.length) {
    db.prepare(`
      UPDATE world_territory_claims
      SET unclaimed_at = CURRENT_TIMESTAMP
      WHERE unclaimed_at IS NULL
    `).run();
    return;
  }

  const topRoomIds = topRooms.map((room) => String(room.room_id || '')).filter(Boolean);
  if (!topRoomIds.length) return;
  const placeholders = topRoomIds.map(() => '?').join(', ');
  db.prepare(`
    UPDATE world_territory_claims
    SET unclaimed_at = CURRENT_TIMESTAMP
    WHERE unclaimed_at IS NULL
      AND room_id NOT IN (${placeholders})
  `).run(topRoomIds);

  const activeClaims = db.prepare(`
    SELECT territory_id, room_id
    FROM world_territory_claims
    WHERE unclaimed_at IS NULL
  `).all();
  const claimedRoomIds = new Set(activeClaims.map((claim) => String(claim.room_id)));

  const unclaimedTerritoryIds = db.prepare(`
    SELECT wt.id
    FROM world_territories wt
    LEFT JOIN world_territory_claims wtc
      ON wtc.territory_id = wt.id
      AND wtc.unclaimed_at IS NULL
    WHERE wtc.id IS NULL
    ORDER BY wt.id
  `).all().map((row) => row.id);
  if (!unclaimedTerritoryIds.length) return;

  const insertClaim = db.prepare(`
    INSERT INTO world_territory_claims (territory_id, room_id)
    VALUES (?, ?)
  `);

  for (const room of topRooms) {
    const roomId = String(room.room_id || '');
    if (!roomId || claimedRoomIds.has(roomId) || !unclaimedTerritoryIds.length) continue;
    const index = hashString(roomId) % unclaimedTerritoryIds.length;
    const [territoryId] = unclaimedTerritoryIds.splice(index, 1);
    insertClaim.run(territoryId, roomId);
    claimedRoomIds.add(roomId);
  }
}

// Territory -> real data join path: an active claim (unclaimed_at IS NULL) gives a
// room_id, which is the same room_id used throughout live_sessions/room_player_stats.
// active_count is a proxy for "engagement," not a raw TikTok viewer count -- no such
// signal is captured anywhere in this codebase today.
function fetchClaimedTerritoryActivity() {
  const recentThreshold = Date.now() - RECENT_ACTIVE_WINDOW_MS;
  return db
    .prepare(
      `SELECT
         wtc.territory_id AS territory_id,
         wtc.room_id AS room_id,
         COALESCE(
           NULLIF(ta.display_name, ''),
           NULLIF(u.tiktok_username, ''),
           NULLIF(ta.tiktok_username, ''),
           NULLIF(u.name, ''),
           NULLIF(ur.room_name, ''),
           wtc.room_id
         ) AS holder_name,
         EXISTS (
           SELECT 1 FROM live_sessions ls
           WHERE ls.room_id = wtc.room_id
             AND ls.status = 'active'
             AND ls.ended_at IS NULL
         ) AS is_live,
         COALESCE(stats.active_count, 0) AS active_count,
         COALESCE(stats.kills, 0) AS kills
       FROM world_territory_claims wtc
       JOIN user_rooms ur ON ur.room_id = wtc.room_id
       JOIN users u ON u.id = ur.user_id
       LEFT JOIN tiktok_accounts ta ON ta.user_id = u.id AND COALESCE(ta.status, 'connected') = 'connected'
       LEFT JOIN (
         SELECT
           room_id,
           SUM(CASE WHEN alive = 1 AND last_active >= ? THEN 1 ELSE 0 END) AS active_count,
           COALESCE(SUM(kills), 0) AS kills
         FROM room_player_stats
         GROUP BY room_id
       ) stats ON stats.room_id = wtc.room_id
       WHERE wtc.unclaimed_at IS NULL`
    )
    .all(recentThreshold);
}

function computeKingdomStates() {
  ensureWorldTerritories();
  assignClaimsForTopRooms();
  const rows = fetchClaimedTerritoryActivity();
  const states = {};
  for (const row of rows) {
    const isLive = Boolean(row.is_live);
    const activeCount = Number(row.active_count) || 0;
    const kills = Number(row.kills) || 0;
    states[row.territory_id] = {
      isClaimed: true,
      isLive,
      viewerTier: isLive ? computeViewerTier(activeCount) : 'off',
      holderName: row.holder_name || row.room_id,
      roomId: row.room_id,
      activeCount,
      kills,
      score: scoreRoom({ ...row, is_live: isLive, active_count: activeCount, kills }),
    };
  }
  return states;
}

function normalizeStateForDiff(state = {}) {
  const activeCount = Number(state.activeCount);
  const kills = Number(state.kills);
  const score = Number(state.score);
  return {
    isClaimed: Boolean(state.isClaimed),
    isLive: Boolean(state.isLive),
    viewerTier: state.viewerTier || 'off',
    holderName: state.holderName || '',
    roomId: state.roomId || '',
    activeCount: Number.isFinite(activeCount) ? activeCount : 0,
    kills: Number.isFinite(kills) ? kills : 0,
    score: Number.isFinite(score) ? score : 0,
  };
}

function hasKingdomStateChanged(prevState, nextState) {
  const prev = normalizeStateForDiff(prevState);
  const next = normalizeStateForDiff(nextState);
  return (
    prev.isClaimed !== next.isClaimed
    || prev.isLive !== next.isLive
    || prev.viewerTier !== next.viewerTier
    || prev.holderName !== next.holderName
    || prev.roomId !== next.roomId
    || prev.activeCount !== next.activeCount
    || prev.kills !== next.kills
    || prev.score !== next.score
  );
}

// Only the territories whose state actually changed since the last broadcast, plus any
// territory that dropped out of the claimed set entirely (reverts to off/not-live).
function diffStates(prev, next) {
  const changed = {};
  for (const [id, state] of Object.entries(next)) {
    if (hasKingdomStateChanged(prev[id], state)) {
      changed[id] = state;
    }
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) changed[id] = { isClaimed: false, isLive: false, viewerTier: 'off' };
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
