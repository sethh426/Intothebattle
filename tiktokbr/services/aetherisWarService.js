import db from '../db/db.js';
import { AETHERIS_TERRITORIES, getWorldTerritory } from './aetherisCatalog.js';
import {
  AETHERIS_WAR_RULES,
  addDays,
  addHours,
  applyContribution,
  campaignPhase,
  compareCampaignRounds,
  contributionEvent,
  scoreRound,
  validateCampaignTarget,
} from './aetherisWarRules.js';

const ACTIVE_CAMPAIGN_STATUSES = ['mobilizing', 'scoring'];
const LEGACY_ARCHIVE_MIGRATION = '2026-08-09-aetheris-preseason-reset';

function iso(value = new Date()) {
  return new Date(value).toISOString();
}

function normalizeHandle(value = '') {
  const clean = String(value || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9._]{2,64}$/.test(clean) ? `@${clean}` : '';
}

function viewerTier(activeCount) {
  if (activeCount >= 40) return 'packed';
  if (activeCount >= 15) return 'high';
  if (activeCount >= 5) return 'medium';
  return 'low';
}

function publicCampaign(campaign, now = new Date()) {
  return {
    id: Number(campaign.id),
    territoryId: campaign.territory_id || campaign.territoryId,
    originTerritoryId: campaign.origin_territory_id || campaign.originTerritoryId,
    mode: campaign.mode,
    phase: campaignPhase(campaign, now),
    status: campaign.status,
    attackerHandle: normalizeHandle(campaign.attacker_handle || campaign.attackerHandle),
    defenderHandle: normalizeHandle(campaign.defender_handle || campaign.defenderHandle),
    declaredAt: campaign.declared_at || campaign.declaredAt,
    scoringStartsAt: campaign.scoring_starts_at || campaign.scoringStartsAt,
    endsAt: campaign.ends_at || campaign.endsAt,
    attackerWins: Number(campaign.attacker_wins ?? campaign.attackerWins) || 0,
    defenderWins: Number(campaign.defender_wins ?? campaign.defenderWins) || 0,
  };
}

function publicClaim(claim) {
  const activeCount = Number(claim.active_count ?? claim.activeCount) || 0;
  const kills = Number(claim.kills) || 0;
  const isLive = Boolean(claim.is_live ?? claim.isLive);
  return {
    territoryId: claim.territory_id || claim.territoryId,
    claimType: claim.claim_type || claim.claimType || 'conquest',
    holderName: normalizeHandle(claim.tiktok_handle || claim.holderName),
    isLive,
    viewerTier: isLive ? viewerTier(activeCount) : 'off',
    activeCount,
    kills,
    score: (isLive ? 200 : 0) + activeCount * 25 + kills * 10,
    shieldUntil: claim.shield_until || claim.shieldUntil || null,
    claimedAt: claim.claimed_at || claim.claimedAt,
  };
}

function profileResponse(profile) {
  if (!profile) return { optedIn: false, homeTerritoryId: null, reentryAllowedAt: null };
  return {
    optedIn: Boolean(profile.opted_in ?? profile.optedIn),
    homeTerritoryId: profile.home_territory_id || profile.homeTerritoryId || null,
    reentryAllowedAt: profile.reentry_allowed_at || profile.reentryAllowedAt || null,
  };
}

function memoryState() {
  const now = new Date();
  return {
    season: { id: 1, season_key: 'aetheris-test-season', status: 'active', starts_at: iso(now), ends_at: iso(addDays(now, 30)) },
    profiles: new Map(),
    claims: [],
    campaigns: [],
    rounds: [],
    events: [],
    nextClaimId: 1,
    nextCampaignId: 1,
    nextRoundId: 1,
  };
}

export class AetherisWarService {
  constructor(options = {}) {
    this.useMemory = options.useMemory ?? process.env.SKIP_DB === 'true';
    this.memory = memoryState();
    this.initialized = false;
    this.activeRoundsByRoom = new Map();
    this.lastCheckpointAt = new Map();
    this.disconnectTimers = new Map();
  }

  initialize() {
    if (this.initialized) return this.currentSeason();
    if (this.useMemory) {
      this.initialized = true;
      return this.memory.season;
    }

    const upsert = db.prepare(`
      INSERT INTO world_territories (
        id, biome_id, shape_id, territory_name, size_class, lat, lon,
        angular_radius, rotation, color_hex, seed, neighbors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        biome_id = EXCLUDED.biome_id,
        shape_id = EXCLUDED.shape_id,
        territory_name = EXCLUDED.territory_name,
        size_class = EXCLUDED.size_class,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        angular_radius = EXCLUDED.angular_radius,
        rotation = EXCLUDED.rotation,
        color_hex = EXCLUDED.color_hex,
        seed = EXCLUDED.seed,
        neighbors = EXCLUDED.neighbors
    `);
    for (const territory of AETHERIS_TERRITORIES) {
      upsert.run(
        territory.id,
        territory.biomeId,
        territory.shapeId,
        territory.territoryName,
        territory.sizeClass,
        territory.lat,
        territory.lon,
        territory.angularRadius,
        territory.rotation,
        territory.colorHex,
        territory.seed,
        JSON.stringify(territory.neighbors),
      );
    }

    const archived = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(LEGACY_ARCHIVE_MIGRATION);
    if (!archived) {
      const archiveLegacy = db.transaction(() => {
        db.prepare(`
          UPDATE world_territory_claims
          SET unclaimed_at = CURRENT_TIMESTAMP, release_reason = 'preseason_reset'
          WHERE unclaimed_at IS NULL AND season_id IS NULL
        `).run();
        db.prepare(`INSERT INTO schema_migrations (version, description) VALUES (?, ?)`)
          .run(LEGACY_ARCHIVE_MIGRATION, 'Archive automatic territory claims before creator opt-in seasons');
      });
      archiveLegacy();
    }
    this.ensureActiveSeason();
    this.initialized = true;
    return this.currentSeason();
  }

  ensureActiveSeason(now = new Date()) {
    if (this.useMemory) return this.memory.season;
    let season = db.prepare(`SELECT * FROM aetheris_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get();
    if (season && new Date(season.ends_at).getTime() <= now.getTime()) {
      const closeSeason = db.transaction(() => {
        db.prepare(`UPDATE aetheris_campaigns SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, result_reason = 'season_ended' WHERE season_id = ? AND status IN ('mobilizing', 'scoring')`).run(season.id);
        db.prepare(`UPDATE world_territory_claims SET unclaimed_at = CURRENT_TIMESTAMP, release_reason = 'season_ended' WHERE season_id = ? AND unclaimed_at IS NULL`).run(season.id);
        db.prepare(`UPDATE aetheris_seasons SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(season.id);
      });
      closeSeason();
      season = null;
    }
    if (!season) {
      const start = iso(now);
      const key = `aetheris-${start.slice(0, 10)}-${String(Date.now()).slice(-6)}`;
      season = db.prepare(`
        INSERT INTO aetheris_seasons (season_key, status, starts_at, ends_at)
        VALUES (?, 'active', ?, ?) RETURNING *
      `).get(key, start, iso(addDays(now, AETHERIS_WAR_RULES.seasonDays)));
    }
    return season;
  }

  currentSeason() {
    if (this.useMemory) return this.memory.season;
    return db.prepare(`SELECT * FROM aetheris_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get();
  }

  profile(userId, seasonId = this.currentSeason()?.id) {
    if (this.useMemory) return this.memory.profiles.get(Number(userId)) || null;
    return db.prepare('SELECT * FROM aetheris_creator_profiles WHERE season_id = ? AND user_id = ?').get(seasonId, userId);
  }

  upsertProfile({ userId, roomId, handle = '' }) {
    const season = this.initialize();
    if (this.useMemory) {
      const existing = this.memory.profiles.get(Number(userId));
      const profile = existing || {
        id: Number(userId),
        season_id: season.id,
        user_id: Number(userId),
        room_id: roomId,
        opted_in: 0,
        home_territory_id: null,
        handle: normalizeHandle(handle),
      };
      profile.room_id = roomId;
      profile.handle = normalizeHandle(handle) || profile.handle;
      this.memory.profiles.set(Number(userId), profile);
      return profile;
    }
    return db.prepare(`
      INSERT INTO aetheris_creator_profiles (season_id, user_id, room_id)
      VALUES (?, ?, ?)
      ON CONFLICT (season_id, user_id) DO UPDATE SET room_id = EXCLUDED.room_id, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `).get(season.id, userId, roomId);
  }

  creatorHoldings(userId) {
    const season = this.currentSeason();
    if (!season) return [];
    if (this.useMemory) return this.memory.claims.filter(claim => !claim.unclaimed_at && claim.season_id === season.id && claim.user_id === Number(userId));
    return db.prepare(`
      SELECT * FROM world_territory_claims
      WHERE season_id = ? AND user_id = ? AND unclaimed_at IS NULL
      ORDER BY CASE WHEN claim_type = 'home' THEN 0 ELSE 1 END, claimed_at
    `).all(season.id, userId);
  }

  activeClaim(territoryId) {
    if (this.useMemory) return this.memory.claims.find(claim => claim.territory_id === territoryId && !claim.unclaimed_at) || null;
    return db.prepare(`SELECT * FROM world_territory_claims WHERE territory_id = ? AND unclaimed_at IS NULL`).get(territoryId);
  }

  activeCampaignForUser(userId) {
    const numeric = Number(userId);
    if (this.useMemory) return this.memory.campaigns.find(campaign => ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status) && (campaign.attacker_user_id === numeric || campaign.defender_user_id === numeric)) || null;
    return db.prepare(`
      SELECT * FROM aetheris_campaigns
      WHERE status IN ('mobilizing', 'scoring') AND (attacker_user_id = ? OR defender_user_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(userId, userId);
  }

  optIn({ userId, roomId, handle = '' }) {
    const profile = this.upsertProfile({ userId, roomId, handle });
    const blockedUntil = profile.reentry_allowed_at || profile.reentryAllowedAt;
    if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) {
      return { ok: false, code: 'REENTRY_COOLDOWN', message: 'Your opt-in cooldown has not ended.', reentryAllowedAt: blockedUntil };
    }
    if (this.useMemory) {
      profile.opted_in = 1;
      profile.opted_in_at = iso();
      profile.opted_out_at = null;
      return { ok: true, profile: profileResponse(profile) };
    }
    const updated = db.prepare(`
      UPDATE aetheris_creator_profiles
      SET opted_in = 1, opted_in_at = CURRENT_TIMESTAMP, opted_out_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? RETURNING *
    `).get(profile.id);
    return { ok: true, profile: profileResponse(updated) };
  }

  optOut({ userId }) {
    this.initialize();
    const profile = this.profile(userId);
    if (!profile?.opted_in) return { ok: true, profile: profileResponse(profile) };
    if (this.activeCampaignForUser(userId)) return { ok: false, code: 'ACTIVE_CAMPAIGN', message: 'Resolve or withdraw from your active campaign before opting out.' };
    const reentry = iso(addDays(new Date(), AETHERIS_WAR_RULES.optOutCooldownDays));
    if (this.useMemory) {
      for (const claim of this.creatorHoldings(userId)) {
        claim.unclaimed_at = iso();
        claim.release_reason = 'creator_opt_out';
      }
      profile.opted_in = 0;
      profile.opted_out_at = iso();
      profile.reentry_allowed_at = reentry;
      profile.home_territory_id = null;
      return { ok: true, profile: profileResponse(profile) };
    }
    const release = db.transaction(() => {
      db.prepare(`UPDATE world_territory_claims SET unclaimed_at = CURRENT_TIMESTAMP, release_reason = 'creator_opt_out' WHERE user_id = ? AND unclaimed_at IS NULL`).run(userId);
      return db.prepare(`
        UPDATE aetheris_creator_profiles
        SET opted_in = 0, opted_out_at = CURRENT_TIMESTAMP, reentry_allowed_at = ?, home_territory_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? RETURNING *
      `).get(reentry, profile.id);
    });
    return { ok: true, profile: profileResponse(release()) };
  }

  selectHome({ userId, roomId, territoryId }) {
    this.initialize();
    const territory = getWorldTerritory(territoryId);
    if (!territory) return { ok: false, code: 'UNKNOWN_TERRITORY', message: 'Choose a valid Aetheris territory.' };
    const profile = this.profile(userId);
    if (!profile?.opted_in) return { ok: false, code: 'OPT_IN_REQUIRED', message: 'Opt into Aetheris land wars before selecting a home.' };
    if (profile.home_territory_id || profile.homeTerritoryId) return { ok: false, code: 'HOME_ALREADY_SELECTED', message: 'Your protected home is already selected for this season.' };
    if (this.activeClaim(territoryId)) return { ok: false, code: 'TERRITORY_CLAIMED', message: 'Another creator already controls that territory.' };
    const season = this.currentSeason();
    if (this.useMemory) {
      const claim = {
        id: this.memory.nextClaimId++, territory_id: territoryId, room_id: roomId, user_id: Number(userId), season_id: season.id,
        claim_type: 'home', claimed_at: iso(), shield_until: null, unclaimed_at: null,
      };
      this.memory.claims.push(claim);
      profile.home_territory_id = territoryId;
      return { ok: true, claim: publicClaim({ ...claim, holderName: profile.handle }), profile: profileResponse(profile) };
    }
    const createHome = db.transaction(() => {
      const occupied = db.prepare(`SELECT id FROM world_territory_claims WHERE territory_id = ? AND unclaimed_at IS NULL FOR UPDATE`).get(territoryId);
      if (occupied) throw Object.assign(new Error('Another creator already controls that territory.'), { code: 'TERRITORY_CLAIMED' });
      const claim = db.prepare(`
        INSERT INTO world_territory_claims (territory_id, room_id, user_id, season_id, claim_type)
        VALUES (?, ?, ?, ?, 'home') RETURNING *
      `).get(territoryId, roomId, userId, season.id);
      db.prepare(`UPDATE aetheris_creator_profiles SET home_territory_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(territoryId, profile.id);
      return claim;
    });
    try {
      const claim = createHome();
      return { ok: true, claim: publicClaim(claim), profile: { ...profileResponse(profile), homeTerritoryId: territoryId } };
    } catch (error) {
      return { ok: false, code: error.code || 'TERRITORY_CLAIMED', message: error.message || 'Unable to claim that home territory.' };
    }
  }

  declareCampaign({ userId, roomId, territoryId, handle = '' }) {
    this.initialize();
    this.resolveExpiredCampaigns();
    const attackerProfile = this.upsertProfile({ userId, roomId, handle });
    if (!attackerProfile.opted_in) return { ok: false, code: 'OPT_IN_REQUIRED', message: 'Opt into land wars before mobilizing.' };
    if (!attackerProfile.home_territory_id) return { ok: false, code: 'HOME_REQUIRED', message: 'Select your protected home before mobilizing.' };
    const targetClaim = this.activeClaim(territoryId);
    const defenderProfile = targetClaim ? this.profile(targetClaim.user_id) : null;
    if (targetClaim && !defenderProfile?.opted_in) return { ok: false, code: 'DEFENDER_NOT_OPTED_IN', message: 'That creator is not accepting land campaigns.' };
    const holdings = this.creatorHoldings(userId);
    const validation = validateCampaignTarget({
      attackerHoldings: holdings,
      targetTerritoryId: territoryId,
      targetClaim,
      attackerUserId: Number(userId),
      attackerConquestCount: holdings.filter(claim => claim.claim_type !== 'home').length,
      attackerBusy: Boolean(this.activeCampaignForUser(userId)),
      defenderBusy: Boolean(targetClaim && this.activeCampaignForUser(targetClaim.user_id)),
    });
    if (!validation.ok) return validation;

    if (targetClaim && this.rematchBlocked(userId, targetClaim.user_id)) {
      return { ok: false, code: 'REMATCH_COOLDOWN', message: 'This matchup is still inside its 72-hour rematch cooldown.' };
    }
    const now = new Date();
    const originClaim = holdings.find(claim => validation.target.neighbors.includes(claim.territory_id));
    const campaignData = {
      season_id: this.currentSeason().id,
      territory_id: territoryId,
      origin_territory_id: originClaim.territory_id,
      mode: validation.mode,
      status: 'mobilizing',
      attacker_user_id: Number(userId),
      attacker_room_id: roomId,
      defender_user_id: targetClaim?.user_id ? Number(targetClaim.user_id) : null,
      defender_room_id: targetClaim?.room_id || null,
      declared_at: iso(now),
      scoring_starts_at: iso(addHours(now, AETHERIS_WAR_RULES.mobilizationHours)),
      ends_at: iso(addHours(now, AETHERIS_WAR_RULES.campaignHours)),
      attacker_wins: 0,
      defender_wins: 0,
      attacker_handle: normalizeHandle(handle) || attackerProfile.handle,
      defender_handle: defenderProfile?.handle || this.handleForUser(targetClaim?.user_id),
    };
    if (this.useMemory) {
      const campaign = { id: this.memory.nextCampaignId++, ...campaignData };
      this.memory.campaigns.push(campaign);
      this.audit(campaign.id, 'campaign_declared', userId, { mode: campaign.mode, territoryId });
      return { ok: true, campaign: publicCampaign(campaign), notificationEmail: null };
    }
    try {
      const create = db.transaction(() => {
        const creatorLocks = [Number(userId), Number(campaignData.defender_user_id)]
          .filter(value => Number.isInteger(value) && value > 0)
          .filter((value, index, values) => values.indexOf(value) === index)
          .sort((first, second) => first - second);
        for (const creatorId of creatorLocks) {
          db.prepare('SELECT pg_advisory_xact_lock(?)').get(creatorId);
        }
        if (this.activeCampaignForUser(userId) || (campaignData.defender_user_id && this.activeCampaignForUser(campaignData.defender_user_id))) {
          throw new Error('A creator entered another campaign first.');
        }
        const campaign = db.prepare(`
          INSERT INTO aetheris_campaigns (
            season_id, territory_id, origin_territory_id, mode, status, attacker_user_id, attacker_room_id,
            defender_user_id, defender_room_id, declared_at, scoring_starts_at, ends_at
          ) VALUES (?, ?, ?, ?, 'mobilizing', ?, ?, ?, ?, ?, ?, ?) RETURNING *
        `).get(
          campaignData.season_id, territoryId, campaignData.origin_territory_id, campaignData.mode, userId, roomId,
          campaignData.defender_user_id, campaignData.defender_room_id,
          campaignData.declared_at, campaignData.scoring_starts_at, campaignData.ends_at,
        );
        this.audit(campaign.id, 'campaign_declared', userId, { mode: campaign.mode, territoryId });
        return campaign;
      });
      const campaign = create();
      const defender = campaign.defender_user_id
        ? db.prepare('SELECT email FROM users WHERE id = ?').get(campaign.defender_user_id)
        : null;
      return { ok: true, campaign: publicCampaign({ ...campaign, attacker_handle: handle, defender_handle: this.handleForUser(campaign.defender_user_id) }), notificationEmail: defender?.email || null };
    } catch (error) {
      return { ok: false, code: 'CAMPAIGN_CONFLICT', message: 'That territory or creator entered another campaign first.' };
    }
  }

  rematchBlocked(firstUserId, secondUserId) {
    if (!firstUserId || !secondUserId) return false;
    const threshold = addHours(new Date(), -AETHERIS_WAR_RULES.rematchCooldownHours);
    if (this.useMemory) {
      return this.memory.campaigns.some(campaign =>
        campaign.status === 'resolved'
        && new Date(campaign.resolved_at || 0) > threshold
        && ((campaign.attacker_user_id === Number(firstUserId) && campaign.defender_user_id === Number(secondUserId))
          || (campaign.attacker_user_id === Number(secondUserId) && campaign.defender_user_id === Number(firstUserId))));
    }
    return Boolean(db.prepare(`
      SELECT id FROM aetheris_campaigns
      WHERE status = 'resolved' AND resolved_at >= ?
        AND ((attacker_user_id = ? AND defender_user_id = ?) OR (attacker_user_id = ? AND defender_user_id = ?))
      LIMIT 1
    `).get(iso(threshold), firstUserId, secondUserId, secondUserId, firstUserId));
  }

  handleForUser(userId) {
    if (!userId) return '';
    if (this.useMemory) return this.profile(userId)?.handle || '';
    const row = db.prepare(`
      SELECT COALESCE(NULLIF(ta.tiktok_username, ''), NULLIF(u.tiktok_username, '')) AS handle
      FROM users u LEFT JOIN tiktok_accounts ta ON ta.user_id = u.id AND COALESCE(ta.status, 'connected') = 'connected'
      WHERE u.id = ?
    `).get(userId);
    return normalizeHandle(row?.handle);
  }

  campaignById(campaignId) {
    if (this.useMemory) return this.memory.campaigns.find(campaign => campaign.id === Number(campaignId)) || null;
    return db.prepare('SELECT * FROM aetheris_campaigns WHERE id = ?').get(campaignId);
  }

  roundsForCampaign(campaignId) {
    if (this.useMemory) return this.memory.rounds.filter(round => round.campaign_id === Number(campaignId));
    return db.prepare('SELECT * FROM aetheris_campaign_rounds WHERE campaign_id = ? ORDER BY round_number, side').all(campaignId);
  }

  startRound({ campaignId, userId, roomId, now = new Date() }) {
    this.initialize();
    this.resolveExpiredCampaigns(now);
    const campaign = this.campaignById(campaignId);
    if (!campaign || !ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status)) return { ok: false, code: 'CAMPAIGN_INACTIVE', message: 'That campaign is no longer active.' };
    if (campaignPhase(campaign, now) !== 'scoring') return { ok: false, code: 'MOBILIZING', message: 'Scoring opens after the six-hour mobilization window.' };
    const side = campaign.attacker_user_id === Number(userId) ? 'attacker' : campaign.defender_user_id === Number(userId) ? 'defender' : '';
    if (!side) return { ok: false, code: 'NOT_PARTICIPANT', message: 'You are not part of that campaign.' };
    if (this.activeRoundsByRoom.has(roomId)) return { ok: false, code: 'ROUND_ACTIVE', message: 'This room already has an active land-war round.' };
    const rounds = this.roundsForCampaign(campaign.id).filter(round => round.side === side);
    if (rounds.length >= (campaign.mode === 'expedition' ? 1 : AETHERIS_WAR_RULES.maxRoundsPerSide)) {
      return { ok: false, code: 'ROUND_LIMIT', message: 'Your available scoring rounds are complete.' };
    }
    const roundNumber = rounds.length + 1;
    const endsAt = iso(new Date(now.getTime() + AETHERIS_WAR_RULES.roundDurationMs));
    let round;
    if (this.useMemory) {
      round = {
        id: this.memory.nextRoundId++, campaign_id: campaign.id, round_number: roundNumber, side, room_id: roomId,
        status: 'active', started_at: iso(now), ends_at: endsAt, contributions: {}, score: 0,
      };
      this.memory.rounds.push(round);
      campaign.status = 'scoring';
    } else {
      round = db.prepare(`
        INSERT INTO aetheris_campaign_rounds (campaign_id, round_number, side, room_id, status, started_at, ends_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?) RETURNING *
      `).get(campaign.id, roundNumber, side, roomId, iso(now), endsAt);
      db.prepare(`UPDATE aetheris_campaigns SET status = 'scoring' WHERE id = ? AND status = 'mobilizing'`).run(campaign.id);
    }
    const runtime = { ...round, contributions: {}, campaignId: campaign.id, side };
    this.activeRoundsByRoom.set(roomId, runtime);
    this.audit(campaign.id, 'round_started', userId, { roundNumber, side });
    return {
      ok: true,
      round: { id: round.id, campaignId: campaign.id, roundNumber, side, startedAt: round.started_at, endsAt },
      durationMs: AETHERIS_WAR_RULES.roundDurationMs,
    };
  }

  recordRoomEvent(roomId, type, payload, source) {
    const runtime = this.activeRoundsByRoom.get(roomId);
    if (!runtime) return null;
    const event = contributionEvent(type, payload, source);
    if (!event) return null;
    runtime.contributions = applyContribution(runtime.contributions, event);
    const now = Date.now();
    const lastCheckpoint = this.lastCheckpointAt.get(runtime.id) || 0;
    if (!this.useMemory && now - lastCheckpoint >= 10_000) {
      db.prepare(`UPDATE aetheris_campaign_rounds SET contributions = ?::jsonb WHERE id = ? AND status = 'active'`)
        .run(JSON.stringify(runtime.contributions), runtime.id);
      this.lastCheckpointAt.set(runtime.id, now);
    }
    return scoreRound(runtime.contributions);
  }

  finishRoundForRoom(roomId, reason = 'timer', options = {}) {
    const runtime = this.activeRoundsByRoom.get(roomId);
    if (!runtime) return { ok: false, reason: 'no_active_war_round' };
    this.activeRoundsByRoom.delete(roomId);
    this.lastCheckpointAt.delete(runtime.id);
    const result = options.forceVoid
      ? { valid: false, score: 0, participantCount: Object.keys(runtime.contributions).length, averageContribution: 0 }
      : scoreRound(runtime.contributions);
    if (options.forceVoid) {
      if (this.useMemory) this.memory.rounds = this.memory.rounds.filter(round => round.id !== runtime.id);
      else db.prepare('DELETE FROM aetheris_campaign_rounds WHERE id = ?').run(runtime.id);
      this.audit(runtime.campaignId, 'round_interrupted', null, { roundNumber: runtime.round_number, side: runtime.side, reason });
      return { ok: true, interrupted: true, result, campaign: publicCampaign(this.campaignById(runtime.campaignId)) };
    }
    if (this.useMemory) {
      const round = this.memory.rounds.find(item => item.id === runtime.id);
      Object.assign(round, {
        status: result.valid ? 'completed' : 'void', ended_at: iso(), valid: result.valid ? 1 : 0,
        score: result.score, participant_count: result.participantCount,
        average_contribution: result.averageContribution, contributions: runtime.contributions,
      });
    } else {
      db.prepare(`
        UPDATE aetheris_campaign_rounds
        SET status = ?, ended_at = CURRENT_TIMESTAMP, valid = ?, score = ?, participant_count = ?,
            average_contribution = ?, contributions = ?::jsonb
        WHERE id = ?
      `).run(
        result.valid ? 'completed' : 'void', result.valid ? 1 : 0, result.score, result.participantCount,
        result.averageContribution, JSON.stringify(runtime.contributions), runtime.id,
      );
    }
    this.audit(runtime.campaignId, 'round_finished', null, { roundNumber: runtime.round_number, side: runtime.side, reason, ...result });
    const campaign = this.recalculateCampaign(runtime.campaignId);
    return { ok: true, result, campaign: campaign ? publicCampaign(campaign) : null };
  }

  markRoomDisconnected(roomId) {
    if (!this.activeRoundsByRoom.has(roomId) || this.disconnectTimers.has(roomId)) return false;
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(roomId);
      this.finishRoundForRoom(roomId, 'live_disconnect', { forceVoid: true });
    }, AETHERIS_WAR_RULES.reconnectGraceMs);
    timer.unref?.();
    this.disconnectTimers.set(roomId, timer);
    return true;
  }

  markRoomReconnected(roomId) {
    const timer = this.disconnectTimers.get(roomId);
    if (!timer) return false;
    clearTimeout(timer);
    this.disconnectTimers.delete(roomId);
    return true;
  }

  recalculateCampaign(campaignId, now = new Date()) {
    const campaign = this.campaignById(campaignId);
    if (!campaign || !ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status)) return campaign;
    const rounds = this.roundsForCampaign(campaignId).filter(round => ['completed', 'void'].includes(round.status));
    if (campaign.mode === 'expedition') {
      const round = rounds.find(item => item.side === 'attacker');
      if (round) return this.resolveCampaign(campaign, Number(round.score) >= AETHERIS_WAR_RULES.expeditionMinimumScore ? 'attacker' : 'none', 'expedition_complete');
      return campaign;
    }
    const attackerRounds = rounds.filter(round => round.side === 'attacker');
    const defenderRounds = rounds.filter(round => round.side === 'defender');
    const pairedNumbers = new Set(attackerRounds.map(round => Number(round.round_number)).filter(number => defenderRounds.some(round => Number(round.round_number) === number)));
    let attackerWins = 0;
    let defenderWins = 0;
    for (const number of pairedNumbers) {
      const attacker = attackerRounds.find(round => Number(round.round_number) === number);
      const defender = defenderRounds.find(round => Number(round.round_number) === number);
      if (Number(attacker.score) > Number(defender.score)) attackerWins += 1;
      else defenderWins += 1;
    }
    this.updateCampaignWins(campaign, attackerWins, defenderWins);
    if (attackerWins >= AETHERIS_WAR_RULES.roundsToWin) return this.resolveCampaign(campaign, 'attacker', 'round_majority');
    if (defenderWins >= AETHERIS_WAR_RULES.roundsToWin) return this.resolveCampaign(campaign, 'defender', 'round_majority');
    const atDeadline = campaignPhase(campaign, now) === 'deadline';
    if (atDeadline || (attackerRounds.length >= 5 && defenderRounds.length >= 5)) {
      const comparison = compareCampaignRounds(attackerRounds, defenderRounds);
      return this.resolveCampaign(campaign, comparison.winner, atDeadline ? 'deadline' : 'all_rounds_complete');
    }
    return this.campaignById(campaignId);
  }

  updateCampaignWins(campaign, attackerWins, defenderWins) {
    campaign.attacker_wins = attackerWins;
    campaign.defender_wins = defenderWins;
    if (!this.useMemory) db.prepare('UPDATE aetheris_campaigns SET attacker_wins = ?, defender_wins = ? WHERE id = ?').run(attackerWins, defenderWins, campaign.id);
  }

  resolveCampaign(campaign, winningSide, reason) {
    if (!campaign || campaign.status === 'resolved') return campaign;
    const attackerWon = winningSide === 'attacker';
    const winnerUserId = attackerWon ? campaign.attacker_user_id : winningSide === 'defender' ? campaign.defender_user_id : null;
    const now = new Date();
    if (this.useMemory) {
      if (attackerWon) {
        const existing = this.activeClaim(campaign.territory_id);
        if (existing) {
          existing.unclaimed_at = iso(now);
          existing.release_reason = 'campaign_capture';
        }
        this.memory.claims.push({
          id: this.memory.nextClaimId++, territory_id: campaign.territory_id, room_id: campaign.attacker_room_id,
          user_id: campaign.attacker_user_id, season_id: campaign.season_id, claim_type: 'conquest',
          source_campaign_id: campaign.id, shield_until: iso(addHours(now, AETHERIS_WAR_RULES.captureShieldHours)), claimed_at: iso(now), unclaimed_at: null,
        });
      } else if (winningSide === 'defender') {
        const existing = this.activeClaim(campaign.territory_id);
        if (existing) existing.shield_until = iso(addHours(now, AETHERIS_WAR_RULES.defenseShieldHours));
      }
      Object.assign(campaign, { status: 'resolved', resolved_at: iso(now), winner_user_id: winnerUserId, result_reason: reason });
      this.audit(campaign.id, 'campaign_resolved', winnerUserId, { winningSide, reason });
      return campaign;
    }
    const resolve = db.transaction(() => {
      if (attackerWon) {
        db.prepare(`UPDATE world_territory_claims SET unclaimed_at = CURRENT_TIMESTAMP, release_reason = 'campaign_capture' WHERE territory_id = ? AND unclaimed_at IS NULL`).run(campaign.territory_id);
        db.prepare(`
          INSERT INTO world_territory_claims (
            territory_id, room_id, user_id, season_id, claim_type, source_campaign_id, shield_until
          ) VALUES (?, ?, ?, ?, 'conquest', ?, ?)
        `).run(
          campaign.territory_id, campaign.attacker_room_id, campaign.attacker_user_id, campaign.season_id,
          campaign.id, iso(addHours(now, AETHERIS_WAR_RULES.captureShieldHours)),
        );
      } else if (winningSide === 'defender') {
        db.prepare(`UPDATE world_territory_claims SET shield_until = ? WHERE territory_id = ? AND unclaimed_at IS NULL`)
          .run(iso(addHours(now, AETHERIS_WAR_RULES.defenseShieldHours)), campaign.territory_id);
      }
      db.prepare(`
        UPDATE aetheris_campaigns
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, winner_user_id = ?, result_reason = ?
        WHERE id = ?
      `).run(winnerUserId, reason, campaign.id);
      this.audit(campaign.id, 'campaign_resolved', winnerUserId, { winningSide, reason });
    });
    resolve();
    return this.campaignById(campaign.id);
  }

  resolveExpiredCampaigns(now = new Date()) {
    if (!this.initialized && !this.useMemory) return [];
    const campaigns = this.useMemory
      ? this.memory.campaigns.filter(campaign => ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status))
      : db.prepare(`SELECT * FROM aetheris_campaigns WHERE status IN ('mobilizing', 'scoring') AND ends_at <= ?`).all(iso(now));
    return campaigns.filter(campaign => campaignPhase(campaign, now) === 'deadline').map(campaign => this.recalculateCampaign(campaign.id, now));
  }

  withdrawCampaign({ campaignId, userId }) {
    const campaign = this.campaignById(campaignId);
    if (!campaign || campaign.attacker_user_id !== Number(userId)) return { ok: false, code: 'NOT_ATTACKER', message: 'Only the attacking creator can withdraw.' };
    if (campaignPhase(campaign) !== 'mobilizing') return { ok: false, code: 'SCORING_STARTED', message: 'Withdrawal closes when campaign scoring begins.' };
    if (this.useMemory) {
      campaign.status = 'withdrawn';
      campaign.resolved_at = iso();
      campaign.result_reason = 'attacker_withdrew';
    } else {
      db.prepare(`UPDATE aetheris_campaigns SET status = 'withdrawn', resolved_at = CURRENT_TIMESTAMP, result_reason = 'attacker_withdrew' WHERE id = ?`).run(campaign.id);
    }
    this.audit(campaign.id, 'campaign_withdrawn', userId, {});
    return { ok: true, campaign: publicCampaign(this.campaignById(campaign.id)) };
  }

  abandonHolding({ userId, territoryId }) {
    const claim = this.activeClaim(territoryId);
    if (!claim || claim.user_id !== Number(userId)) return { ok: false, code: 'NOT_OWNER', message: 'You do not control that territory.' };
    if (claim.claim_type === 'home') return { ok: false, code: 'HOME_PROTECTED', message: 'A seasonal home cannot be abandoned.' };
    if (this.activeCampaignForUser(userId)) return { ok: false, code: 'ACTIVE_CAMPAIGN', message: 'Finish your active campaign before abandoning land.' };
    if (this.useMemory) {
      claim.unclaimed_at = iso();
      claim.release_reason = 'creator_abandoned';
    } else {
      db.prepare(`UPDATE world_territory_claims SET unclaimed_at = CURRENT_TIMESTAMP, release_reason = 'creator_abandoned' WHERE id = ?`).run(claim.id);
    }
    return { ok: true };
  }

  audit(campaignId, eventType, actorUserId, detail = {}) {
    if (this.useMemory) {
      this.memory.events.push({ campaign_id: Number(campaignId), event_type: eventType, actor_user_id: actorUserId || null, detail, created_at: iso() });
      return;
    }
    db.prepare(`INSERT INTO aetheris_campaign_events (campaign_id, event_type, actor_user_id, detail) VALUES (?, ?, ?, ?::jsonb)`)
      .run(campaignId, eventType, actorUserId || null, JSON.stringify(detail));
  }

  creatorStatus({ userId, roomId, handle = '' }) {
    this.initialize();
    this.resolveExpiredCampaigns();
    const profile = this.upsertProfile({ userId, roomId, handle });
    const holdings = this.creatorHoldings(userId).map(claim => ({
      territoryId: claim.territory_id,
      claimType: claim.claim_type,
      shieldUntil: claim.shield_until || null,
      claimedAt: claim.claimed_at,
    }));
    const activeCampaign = this.activeCampaignForUser(userId);
    const rounds = activeCampaign ? this.roundsForCampaign(activeCampaign.id).map(round => ({
      id: round.id,
      roundNumber: Number(round.round_number),
      side: round.side,
      status: round.status,
      score: Number(round.score) || 0,
      participantCount: Number(round.participant_count) || 0,
      startedAt: round.started_at,
      endsAt: round.ends_at,
    })) : [];
    return {
      success: true,
      rules: AETHERIS_WAR_RULES,
      season: this.publicSeason(this.currentSeason()),
      profile: profileResponse(profile),
      holdings,
      activeCampaign: activeCampaign ? publicCampaign({
        ...activeCampaign,
        attacker_handle: this.handleForUser(activeCampaign.attacker_user_id),
        defender_handle: this.handleForUser(activeCampaign.defender_user_id),
      }) : null,
      rounds,
      activeRound: this.activeRoundsByRoom.get(roomId) ? {
        campaignId: this.activeRoundsByRoom.get(roomId).campaignId,
        roundNumber: this.activeRoundsByRoom.get(roomId).round_number,
        side: this.activeRoundsByRoom.get(roomId).side,
        endsAt: this.activeRoundsByRoom.get(roomId).ends_at,
      } : null,
    };
  }

  publicSeason(season) {
    return season ? {
      id: Number(season.id),
      key: season.season_key || season.seasonKey,
      startsAt: season.starts_at || season.startsAt,
      endsAt: season.ends_at || season.endsAt,
      status: season.status,
    } : null;
  }

  publicWorldState() {
    this.initialize();
    this.resolveExpiredCampaigns();
    let claims;
    let campaigns;
    if (this.useMemory) {
      claims = this.memory.claims.filter(claim => !claim.unclaimed_at).map(claim => {
        const profile = this.profile(claim.user_id);
        return publicClaim({ ...claim, holderName: profile?.handle || '' });
      });
      campaigns = this.memory.campaigns.filter(campaign => ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status)).map(campaign => publicCampaign(campaign));
    } else {
      const recentThreshold = Date.now() - 5 * 60 * 1000;
      const rows = db.prepare(`
        SELECT
          claim.*,
          COALESCE(NULLIF(ta.tiktok_username, ''), NULLIF(u.tiktok_username, '')) AS tiktok_handle,
          EXISTS (
            SELECT 1 FROM live_sessions ls
            WHERE ls.room_id = claim.room_id AND ls.status = 'active' AND ls.ended_at IS NULL
          ) AS is_live,
          COALESCE(stats.active_count, 0) AS active_count,
          COALESCE(stats.kills, 0) AS kills
        FROM world_territory_claims claim
        JOIN users u ON u.id = claim.user_id
        LEFT JOIN tiktok_accounts ta ON ta.user_id = u.id AND COALESCE(ta.status, 'connected') = 'connected'
        LEFT JOIN (
          SELECT room_id,
            SUM(CASE WHEN alive = 1 AND last_active >= ? THEN 1 ELSE 0 END) AS active_count,
            COALESCE(SUM(kills), 0) AS kills
          FROM room_player_stats GROUP BY room_id
        ) stats ON stats.room_id = claim.room_id
        WHERE claim.unclaimed_at IS NULL AND claim.season_id = ?
      `).all(recentThreshold, this.currentSeason().id);
      claims = rows.map(publicClaim).filter(claim => claim.holderName);
      const campaignRows = db.prepare(`
        SELECT c.*,
          COALESCE(NULLIF(ata.tiktok_username, ''), NULLIF(au.tiktok_username, '')) AS attacker_handle,
          COALESCE(NULLIF(dta.tiktok_username, ''), NULLIF(du.tiktok_username, '')) AS defender_handle
        FROM aetheris_campaigns c
        JOIN users au ON au.id = c.attacker_user_id
        LEFT JOIN tiktok_accounts ata ON ata.user_id = au.id AND COALESCE(ata.status, 'connected') = 'connected'
        LEFT JOIN users du ON du.id = c.defender_user_id
        LEFT JOIN tiktok_accounts dta ON dta.user_id = du.id AND COALESCE(dta.status, 'connected') = 'connected'
        WHERE c.status IN ('mobilizing', 'scoring') AND c.season_id = ?
        ORDER BY c.declared_at DESC LIMIT 100
      `).all(this.currentSeason().id);
      campaigns = campaignRows.map(publicCampaign);
    }
    return {
      success: true,
      serverTime: iso(),
      season: this.publicSeason(this.currentSeason()),
      claims: Object.fromEntries(claims.map(claim => [claim.territoryId, claim])),
      campaigns,
    };
  }
}

export const aetherisWar = new AetherisWarService();
