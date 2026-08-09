import { aetherisWar } from './aetherisWarService.js';

const DEFAULT_POLL_INTERVAL_MS = 10_000;

function legacyKingdomStates(worldState = {}) {
  const states = {};
  for (const [territoryId, claim] of Object.entries(worldState.claims || {})) {
    states[territoryId] = {
      isClaimed: true,
      isLive: Boolean(claim.isLive),
      viewerTier: claim.viewerTier || 'off',
      holderName: claim.holderName || '',
      activeCount: Number(claim.activeCount) || 0,
      kills: Number(claim.kills) || 0,
      score: Number(claim.score) || 0,
      claimType: claim.claimType || 'conquest',
      shieldUntil: claim.shieldUntil || null,
    };
  }
  return states;
}

function stableState(value) {
  return JSON.stringify(value || {});
}

// The public namespace contains only sanitized creator handles, claims, shields, and
// campaign timing. Private room ids and account identifiers never cross this boundary.
export function initWorldSocket(io, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.logger ?? console;
  const worldNs = io.of('/aetheris-world');
  let lastWorldState = { success: true, serverTime: new Date().toISOString(), season: null, claims: {}, campaigns: [] };
  let lastComparable = '';

  function readState() {
    try {
      return aetherisWar.publicWorldState();
    } catch (error) {
      log.error({ err: error }, 'Aetheris public world-state query failed');
      return lastWorldState;
    }
  }

  function broadcastNow(force = false) {
    const nextState = readState();
    const comparable = stableState({ season: nextState.season, claims: nextState.claims, campaigns: nextState.campaigns });
    const changed = force || comparable !== lastComparable;
    lastWorldState = nextState;
    lastComparable = comparable;
    if (changed) {
      worldNs.emit('worldStateUpdate', nextState);
      // One-release compatibility alias for the existing globe client.
      worldNs.emit('kingdomStateUpdate', legacyKingdomStates(nextState));
    }
    return nextState;
  }

  lastWorldState = readState();
  lastComparable = stableState({ season: lastWorldState.season, claims: lastWorldState.claims, campaigns: lastWorldState.campaigns });

  worldNs.on('connection', socket => {
    socket.emit('worldStateSnapshot', lastWorldState);
    socket.emit('kingdomStateSnapshot', legacyKingdomStates(lastWorldState));
  });

  const interval = setInterval(() => {
    if (worldNs.sockets.size > 0) broadcastNow(false);
  }, pollIntervalMs);
  interval.unref?.();

  return {
    broadcastNow: () => broadcastNow(true),
    getSnapshot: () => lastWorldState,
    stop: () => clearInterval(interval),
  };
}
