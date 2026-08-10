/**
 * Socket.IO Overlay Handler
 * Bridges real-time Socket.IO events to Phaser scene rendering
 */

function initSocketOverlay(game) {
  const scene = game?.scene?.scenes?.[0];
  if (!scene || !scene.sys || !scene.add) {
    setTimeout(() => initSocketOverlay(game), 50);
    return;
  }
  const statusBadge = document.getElementById('status-badge');
  const overlayParams = new URLSearchParams(window.location.search);
  const overlayRoomId = overlayParams.get('room_id') || '';
  const overlayToken = overlayParams.get('overlay_token') || overlayParams.get('overlayToken') || '';
  const overlayAudio = window.IntoTheBattleOverlayAudio || {};
  const DEFAULT_AUDIO_CONFIG = Object.freeze({
    attack: 'sound1.mp3',
    gift: 'sound2.mp3',
    kill: 'sound3.mp3',
    respawn: 'sound4.mp3',
    heal: 'sound5.mp3',
    follow: 'sound6.mp3',
    socialBoost: 'sound6.mp3',
    engagementSurge: 'sound2.mp3',
    ...(overlayAudio.defaultAudioConfig || {}),
  });
  const AUDIO_EVENT_KEYS = Object.keys(DEFAULT_AUDIO_CONFIG);
  const defaultMasterVolumeValue = Number(overlayAudio.defaultMasterVolume);
  const DEFAULT_MASTER_VOLUME = Math.max(0, Math.min(1, Math.round((Number.isFinite(defaultMasterVolumeValue) ? defaultMasterVolumeValue : 0.5) * 100) / 100));
  const audioConfig = { ...DEFAULT_AUDIO_CONFIG, masterVolume: DEFAULT_MASTER_VOLUME };
  const audioCache = {};
  let audioUnlocked = false;
  let lastAnySoundAt = 0;
  let pendingAudioReplay = null;
  const audioWarnings = new Set();

  function normalizeMasterVolume(value, fallback = DEFAULT_MASTER_VOLUME) {
    const numeric = Number(value);
    const fallbackNumeric = Number(fallback);
    const safeFallback = Number.isFinite(fallbackNumeric) ? fallbackNumeric : DEFAULT_MASTER_VOLUME;
    const next = Number.isFinite(numeric) ? numeric : safeFallback;
    return Math.max(0, Math.min(1, Math.round(next * 100) / 100));
  }

  function currentMasterVolume() {
    return normalizeMasterVolume(audioConfig.masterVolume);
  }

  function configuredSoundFilename(event) {
    const key = String(event || '');
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(audioConfig, key)) return audioConfig[key] || '';
    return DEFAULT_AUDIO_CONFIG[key] || '';
  }

  function audioEventAssignments(config = audioConfig) {
    return Object.fromEntries(AUDIO_EVENT_KEYS.map(key => [key, config[key] || '']));
  }

  function audioEventFilenames(config = audioConfig) {
    return AUDIO_EVENT_KEYS.map(key => config[key]).filter(Boolean);
  }

  function audioFilenames() {
    return [...new Set([
      ...Object.values(DEFAULT_AUDIO_CONFIG),
      ...audioEventFilenames(audioConfig),
    ].filter(Boolean))];
  }

  function applyMasterVolumeToAudio(audio) {
    if (!audio) return;
    audio.volume = currentMasterVolume();
  }

  function applyMasterVolumeToAudioCache() {
    Object.values(audioCache).forEach(audio => {
      try { applyMasterVolumeToAudio(audio); } catch (_err) {}
    });
  }

  function withOverlayAuth(path, extraParams = {}) {
    const url = new URL(path, window.location.origin);
    if (overlayRoomId && overlayToken) {
      url.searchParams.set('room_id', overlayRoomId);
      url.searchParams.set('overlay_token', overlayToken);
    }
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return `${url.pathname}${url.search}`;
  }

  function scrubOverlayUrl(value = '') {
    if (!value) return '';
    try {
      const url = new URL(value, window.location.origin);
      url.searchParams.delete('overlay_token');
      url.searchParams.delete('overlayToken');
      return `${url.pathname}${url.search}`;
    } catch (_err) {
      return '';
    }
  }

  window.overlayAuth = { roomId: overlayRoomId, overlayToken, withOverlayAuth };
  if (scene.setOverlayAuthHelper) scene.setOverlayAuthHelper(withOverlayAuth);

  const socketOptions = { transports: ['websocket', 'polling'], timeout: 5000 };
  if (overlayRoomId && overlayToken) {
    socketOptions.auth = { roomId: overlayRoomId, overlayToken };
  }

  const socket = io(socketOptions);

  function setStatus(text, className) {
    if (!statusBadge) return;
    statusBadge.textContent = text;
    statusBadge.className = className;
  }

  function normalizePlayer(id, player) {
    const rawHp = Number(player.hp ?? player.health ?? 100);
    const maxHp = Number(player.maxHp ?? player.maxHealth ?? 100);
    const health = maxHp > 0 ? Math.max(0, Math.min(100, (rawHp / maxHp) * 100)) : rawHp;
    return {
      id: player.uniqueId || player.id || player.userId || id,
      name: player.nickname || player.name || player.uniqueId || id,
      health,
      kills: Number(player.kills || 0),
      deaths: Number(player.deaths || 0),
      color: player.color || player.teamColor || '',
      teamId: player.teamId || '',
      teamName: player.teamName || '',
      teamColor: player.teamColor || '',
      iconEmoji: player.iconEmoji || '',
    };
  }

  function syncGameState(state) {
    if (!state || typeof state !== 'object') return;
    const activeIds = new Set();
    const hasExplicitPlayers = state.players && typeof state.players === 'object' && !Array.isArray(state.players);
    const source = hasExplicitPlayers ? state.players : state;
    const playerEntries = Object.entries(source).filter(([id, player]) => {
      if (!player || typeof player !== 'object' || Array.isArray(player)) return false;
      if (String(id).startsWith('_')) return false;
      if (['players', 'horde', 'boss', 'settings', 'meta', 'eventSeq'].includes(String(id))) return false;
      return Boolean(
        player.uniqueId || player.id || player.userId || player.nickname || player.name ||
        player.hp !== undefined || player.health !== undefined || player.kills !== undefined
      );
    });

    if (!playerEntries.length && !hasExplicitPlayers) return;

    if (playerEntries.length && scene.demoModeActive !== undefined) scene.demoModeActive = false;
    playerEntries.forEach(([id, player]) => {
      if (!player || player.alive === false) return;
      const normalized = normalizePlayer(id, player);
      activeIds.add(normalized.id);
      const existing = scene.playerGroups?.find(p => p.playerId === normalized.id);
      if (existing) {
        scene.updatePlayerStats(normalized.id, normalized);
      } else {
        scene.addPlayerCard(normalized);
      }
    });

    if (Array.isArray(scene.playerGroups)) {
      [...scene.playerGroups].forEach(player => {
        if (!activeIds.has(player.playerId)) scene.removePlayerCard(player.playerId);
      });
    }
  }

  function getAudio(filename) {
    if (!filename) return null;
    if (!audioCache[filename]) {
      const audio = new Audio(withOverlayAuth(`/audio/${encodeURIComponent(filename)}`));
      audio.preload = 'auto';
      audio.playsInline = true;
      applyMasterVolumeToAudio(audio);
      audioCache[filename] = audio;
    }
    applyMasterVolumeToAudio(audioCache[filename]);
    return audioCache[filename];
  }

  function applyAudioConfig(config) {
    const incoming = config && typeof config === 'object' ? config : {};
    const incomingEvents = {};
    AUDIO_EVENT_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) incomingEvents[key] = incoming[key] || null;
    });
    const hasAssignedAudio = Object.values(incomingEvents).some(Boolean);
    const previousMasterVolume = audioConfig.masterVolume;
    Object.keys(audioConfig).forEach(key => delete audioConfig[key]);
    Object.assign(
      audioConfig,
      hasAssignedAudio ? { ...DEFAULT_AUDIO_CONFIG, ...incomingEvents } : { ...DEFAULT_AUDIO_CONFIG },
      { masterVolume: normalizeMasterVolume(incoming.masterVolume, previousMasterVolume) }
    );
    if (scene.setMasterVolume) scene.setMasterVolume(audioConfig.masterVolume);
    applyMasterVolumeToAudioCache();
    audioEventFilenames(audioConfig).forEach(filename => {
      try {
        const audio = getAudio(filename);
        if (audio) audio.load();
      } catch (_err) {}
    });
  }

  function resolveSoundFilename(input) {
    if (!input) return '';
    if (typeof input === 'string') return configuredSoundFilename(input);
    return input.filename || configuredSoundFilename(input.event);
  }

  function currentAudioStatus() {
    const cacheEntries = Object.entries(audioCache).map(([filename, audio]) => ({
      filename,
      readyState: audio ? audio.readyState : 0,
      networkState: audio ? audio.networkState : 0,
      currentSrc: scrubOverlayUrl(audio ? audio.currentSrc || audio.src || '' : ''),
      errorCode: audio?.error?.code || 0,
    }));
    return {
      module: 'socket-overlay-audio',
      hasModule: Boolean(overlayAudio.defaultAudioConfig),
      unlocked: audioUnlocked,
      pendingReplayType: pendingAudioReplay?.type || '',
      warningCount: audioWarnings.size,
      warnings: Array.from(audioWarnings).slice(0, 8),
      masterVolume: currentMasterVolume(),
      assignedEvents: AUDIO_EVENT_KEYS.filter(key => audioConfig[key]).sort(),
      eventFiles: audioEventAssignments(audioConfig),
      filenames: audioFilenames(),
      cachedCount: cacheEntries.length,
      readyCount: cacheEntries.filter(entry => entry.readyState >= 2).length,
      errorCount: cacheEntries.filter(entry => entry.errorCode > 0).length,
      cacheEntries,
      lastSoundAgeMs: lastAnySoundAt ? Date.now() - lastAnySoundAt : null,
    };
  }

  function markAudioUnlocked() {
    audioUnlocked = true;
    Object.values(audioCache).forEach(audio => {
      try { audio.load(); } catch (_err) {}
    });
    const replay = pendingAudioReplay;
    pendingAudioReplay = null;
    if (replay) setTimeout(() => playSound(replay.input, { ...replay.options, force: true }), 0);
  }

  window.addEventListener('pointerdown', markAudioUnlocked, { once: true, passive: true });
  window.addEventListener('keydown', markAudioUnlocked, { once: true });

  function playSound(input, options = {}) {
    const filename = resolveSoundFilename(input);
    if (!filename) return;
    lastAnySoundAt = Date.now();
    try {
      const audio = getAudio(filename);
      if (!audio) return;
      applyMasterVolumeToAudio(audio);
      audio.currentTime = 0;
      audio.play().then(() => { audioUnlocked = true; }).catch(() => {
        pendingAudioReplay = { input, options };
        if (!audioWarnings.has(filename)) audioWarnings.add(filename);
        if (options.force || audioUnlocked) {
          setTimeout(() => audio.play().catch(() => {}), 120);
        }
      });
    } catch (_err) {
      pendingAudioReplay = { input, options };
      if (!audioWarnings.has(filename)) audioWarnings.add(filename);
    }
  }

  function resolveSponsorPayload(payload = {}) {
    const scenePayload = { ...(payload || {}) };
    if (scenePayload.filename && !scenePayload.videoUrl) {
      scenePayload.videoUrl = withOverlayAuth(`/sponsor/${encodeURIComponent(scenePayload.filename)}`, { v: scenePayload._ts || Date.now() });
    }
    scenePayload.volume = normalizeMasterVolume(scenePayload.volume, currentMasterVolume());
    return scenePayload;
  }

  function reportSponsorPlayback(payload = {}, status, message = '') {
    if (!payload?.breakId) return;
    try {
      const detail = scene.getSponsorMediaTelemetry ? scene.getSponsorMediaTelemetry(payload) : {};
      socket.emit('sponsorPlaybackEvent', {
        breakId: payload.breakId,
        status,
        message,
        source: payload.source || 'creator',
        creativeId: payload.creativeId || null,
        filename: payload.filename || '',
        ...detail,
      });
    } catch (_err) {}
  }

  if (scene.setSponsorPlaybackReporter) scene.setSponsorPlaybackReporter(reportSponsorPlayback);
  applyAudioConfig(audioConfig);

  const SCENE_EVENT_LANES = Object.freeze({
    exclusive: { cooldownMs: 110, ttlMs: 120000, maxQueued: 8, sponsorPolicy: 'allow' },
    state: { cooldownMs: 45, ttlMs: 22000, maxQueued: 36, sponsorPolicy: 'hold' },
    celebration: { cooldownMs: 190, ttlMs: 15000, maxQueued: 28, sponsorPolicy: 'hold' },
    gameplay: { cooldownMs: 70, ttlMs: 9000, maxQueued: 72, sponsorPolicy: 'hold' },
    ambient: { cooldownMs: 130, ttlMs: 4500, maxQueued: 36, sponsorPolicy: 'drop' },
    sound: { cooldownMs: 120, ttlMs: 3500, maxQueued: 16, sponsorPolicy: 'drop' },
  });
  const SCENE_EVENT_LANE_ORDER = ['exclusive', 'state', 'celebration', 'gameplay', 'ambient', 'sound'];
  const sceneEventQueue = [];
  const seenSceneSeqs = new Set();
  const seenSceneSeqOrder = [];
  const sceneLaneReadyAt = {};
  let sceneEventScheduled = false;
  let sceneSeqFloor = 0;
  let sceneRuntimeEpoch = 0;

  function queueClamp(value, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return min;
    return Math.max(min, Math.min(max, parsed));
  }

  function eventSeq(data) {
    const seq = Number(data && data._seq);
    return Number.isFinite(seq) && seq > 0 ? seq : 0;
  }

  function seedSceneSeqFloor(value) {
    const seq = Number(value);
    if (Number.isFinite(seq) && seq > sceneSeqFloor) sceneSeqFloor = seq;
  }

  function seedSceneRegistration(ack = {}) {
    seedSceneSeqFloor(ack.eventSeq);
    const epoch = Number(ack.runtimeEpoch);
    if (Number.isFinite(epoch) && epoch > sceneRuntimeEpoch) sceneRuntimeEpoch = epoch;
  }

  function acceptSceneEpoch(data = {}) {
    const epoch = Number(data._epoch);
    if (!Number.isFinite(epoch) || epoch <= 0) return true;
    if (sceneRuntimeEpoch && epoch < sceneRuntimeEpoch) return false;
    if (epoch > sceneRuntimeEpoch) sceneRuntimeEpoch = epoch;
    return true;
  }

  function rememberSceneSeq(seq) {
    if (!seq) return;
    seenSceneSeqs.add(seq);
    seenSceneSeqOrder.push(seq);
    if (seenSceneSeqOrder.length > 360) {
      const removed = seenSceneSeqOrder.splice(0, seenSceneSeqOrder.length - 360);
      removed.forEach(value => seenSceneSeqs.delete(value));
    }
  }

  function eventPriority(type, data = {}) {
    const explicit = Number(data._priority);
    if (Number.isFinite(explicit)) return explicit;
    if (data.killed || data.killingBlow) return 100;
    if (type === 'sponsorScene') return data.action === 'hide' ? 118 : 112;
    if (type === 'sponsorPrepare') return 108;
    if (type === 'arenaPowerUp') return data.type === 'started' ? 106 : data.type === 'poweredAttack' ? 96 : data.type === 'barrage' ? 94 : data.type === 'ended' ? 90 : 84;
    if (type === 'aetherisStructures') return data.type === 'destroyed' ? 92 : data.type === 'reset' ? 76 : 70;
    if (type === 'bossWave') return data.type === 'defeated' ? 98 : data.type === 'started' ? 92 : 84;
    if (type === 'killEvent' || type === 'streakEvent') return 95;
    if (type === 'engagementSurge') return data.tier === 'takeover' ? 99 : data.tier === 'viral' ? 92 : 84;
    if (type === 'giftAttack' || type === 'giftCelebration') return 88;
    if (type === 'attack' || type === 'commentDamage') return data.special || data.critical ? 82 : 70;
    if (type === 'like' && data.milestoneTier === 'mega') return 90;
    if (type === 'like' && data.milestone) return 66;
    if (type === 'follow' || type === 'socialBoost' || type === 'respawn' || type === 'playerCommand') return 58;
    if (type === 'heal') return 46;
    if (type === 'soundEvent') return Number(data.priority) || 44;
    if (type === 'like') return 24;
    return 40;
  }

  function eventLane(type, data = {}, options = {}) {
    if (options.lane && SCENE_EVENT_LANES[options.lane]) return options.lane;
    if (data._lane && SCENE_EVENT_LANES[data._lane]) return data._lane;
    if (type === 'sponsorPrepare' || type === 'sponsorScene') return 'exclusive';
    if (type === 'soundEvent') return 'sound';
    if (type === 'aetherisStructures') return 'state';
    if (type === 'like' && data.milestone) return 'celebration';
    if (type === 'engagementSurge' || type === 'arenaPowerUp' || type === 'killEvent' || type === 'streakEvent' || type === 'giftCelebration' || type === 'follow' || type === 'roundEvent' || type === 'bossWave') return 'celebration';
    if (type === 'like' || type === 'heal' || type === 'socialBoost') return 'ambient';
    return 'gameplay';
  }

  function laneConfig(lane) {
    return SCENE_EVENT_LANES[lane] || SCENE_EVENT_LANES.gameplay;
  }

  function queueTextPart(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_@.-]+/g, '').slice(0, 80);
  }

  function attackMergeKey(data = {}) {
    const attacker = queueTextPart(data.attacker || data.attackerId || data.uniqueId || data.userId || data.nickname);
    const target = queueTextPart(data.target || data.targetId || data.victim || data.targetNick || data.targetScope);
    const effect = queueTextPart(data.effect || data.commandDescription || data.shotType || (data.giftId ? 'gift' : 'attack'));
    return attacker || target ? `attack:${attacker}:${target}:${effect}` : '';
  }

  function eventMergeKey(type, data = {}, options = {}) {
    if (typeof options.mergeKey === 'function') return options.mergeKey(data);
    if (options.mergeKey) return String(options.mergeKey);
    if (type === 'attack' || type === 'commentDamage' || type === 'giftAttack') return attackMergeKey(data);
    if (type === 'soundEvent') return `sound:${queueTextPart(data.event || data.filename || 'sound')}`;
    if (type === 'like') return data.milestone ? `like:${data.milestone}` : `like:${queueTextPart(data.uniqueId || data.userId || data.nickname || 'crowd')}`;
    if (type === 'bossWave' && data.type !== 'attack') return `boss:${queueTextPart(data.type || 'status')}`;
    if (type === 'arenaPowerUp' && data.type === 'leaderboard') return 'arena-power-up:leaderboard';
    if (type === 'aetherisStructures') return 'aetheris-structures';
    if (type === 'playerCommand') return `cmd:${queueTextPart(data.type || 'command')}:${queueTextPart(data.uniqueId || data.nickname)}`;
    if (type === 'sponsorPrepare' || type === 'sponsorScene') return `${type}:${queueTextPart(data.breakId || data.filename || data.action || 'active')}`;
    return '';
  }

  function mergeScenePayload(previous = {}, next = {}) {
    const merged = { ...previous, ...next };
    const previousHearts = Number(previous.hearts) || 0;
    const nextHearts = Number(next.hearts) || 0;
    if (previousHearts || nextHearts) merged.hearts = Math.min(12, previousHearts + Math.max(1, nextHearts));
    merged.intensity = Math.max(Number(previous.intensity) || 0, Number(next.intensity) || 0);
    merged.amount = Math.max(Number(previous.amount) || 0, Number(next.amount) || 0);
    merged.damage = Math.max(Number(previous.damage) || 0, Number(next.damage) || 0) || merged.damage;
    merged._seq = Math.max(eventSeq(previous), eventSeq(next)) || merged._seq;
    return merged;
  }

  function trimSceneLane(lane) {
    const config = laneConfig(lane);
    const laneItems = [];
    for (let index = 0; index < sceneEventQueue.length; index += 1) {
      if (sceneEventQueue[index].lane === lane) laneItems.push({ index, item: sceneEventQueue[index] });
    }
    if (laneItems.length <= config.maxQueued) return;
    laneItems.sort((a, b) => (a.item.priority - b.item.priority) || (a.item.queuedAt - b.item.queuedAt));
    const drop = new Set(laneItems.slice(0, laneItems.length - config.maxQueued).map(entry => entry.index));
    for (let index = sceneEventQueue.length - 1; index >= 0; index -= 1) {
      if (drop.has(index)) sceneEventQueue.splice(index, 1);
    }
  }

  function sponsorIsActive() {
    return document.body.classList.contains('sponsor-active');
  }

  function pruneSceneEventQueue(now = Date.now()) {
    const activeSponsor = sponsorIsActive();
    for (let index = sceneEventQueue.length - 1; index >= 0; index -= 1) {
      const queued = sceneEventQueue[index];
      const config = laneConfig(queued.lane);
      const expired = now - queued.queuedAt > config.ttlMs;
      const shouldDropDuringSponsor = activeSponsor && config.sponsorPolicy === 'drop' && queued.lane !== 'exclusive';
      if (expired || shouldDropDuringSponsor) sceneEventQueue.splice(index, 1);
    }
  }

  function eventComparator(a, b) {
    const priorityDiff = (b.priority || 0) - (a.priority || 0);
    if (priorityDiff) return priorityDiff;
    if (a.seq && b.seq && a.seq !== b.seq) return a.seq - b.seq;
    return a.queuedAt - b.queuedAt;
  }

  function pickNextSceneEvent(lane, now = Date.now()) {
    const config = laneConfig(lane);
    if (now < (sceneLaneReadyAt[lane] || 0)) return null;
    if (sponsorIsActive() && config.sponsorPolicy !== 'allow') return null;

    let bestIndex = -1;
    for (let index = 0; index < sceneEventQueue.length; index += 1) {
      const queued = sceneEventQueue[index];
      if (queued.lane !== lane) continue;
      if (bestIndex === -1 || eventComparator(queued, sceneEventQueue[bestIndex]) < 0) bestIndex = index;
    }
    if (bestIndex === -1) return null;
    sceneLaneReadyAt[lane] = now + config.cooldownMs;
    return sceneEventQueue.splice(bestIndex, 1)[0];
  }

  function runQueuedSceneEvent(queued) {
    if (!queued) return;
    if (queued.seq) rememberSceneSeq(queued.seq);
    const delayMs = ['attack', 'commentDamage', 'giftAttack'].includes(queued.type)
      ? queueClamp(queued.data.impactDelayMs, 0, 1400)
      : 0;
    const execute = () => {
      try {
        queued.handler(queued.data);
      } catch (err) {
        console.error('Overlay event handler failed:', queued.type, err);
      }
    };
    if (delayMs > 0) setTimeout(execute, delayMs);
    else execute();
  }

  function processSceneEvents() {
    sceneEventScheduled = false;
    if (!sceneEventQueue.length) return;
    const now = Date.now();
    pruneSceneEventQueue(now);
    for (const lane of SCENE_EVENT_LANE_ORDER) {
      const next = pickNextSceneEvent(lane, now);
      if (!next) continue;
      if (next.seq && (next.seq <= sceneSeqFloor || seenSceneSeqs.has(next.seq))) continue;
      runQueuedSceneEvent(next);
    }
    if (sceneEventQueue.length) scheduleSceneEvents();
  }

  function scheduleSceneEvents() {
    if (sceneEventScheduled) return;
    sceneEventScheduled = true;
    const delay = sponsorIsActive() ? 180 : 45;
    setTimeout(() => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(processSceneEvents);
      else processSceneEvents();
    }, delay);
  }

  function enqueueSceneEvent(type, data, handler, options = {}) {
    if (!data || typeof handler !== 'function') return;
    if (!acceptSceneEpoch(data)) return;
    const seq = eventSeq(data);
    if (seq && (seq <= sceneSeqFloor || seenSceneSeqs.has(seq))) return;
    const now = Date.now();
    const lane = eventLane(type, data, options);
    const priority = options.priority != null ? Number(options.priority) : eventPriority(type, data);
    const mergeKey = eventMergeKey(type, data, options);

    if (mergeKey) {
      for (let index = sceneEventQueue.length - 1; index >= 0; index -= 1) {
        const queued = sceneEventQueue[index];
        if (queued.lane === lane && queued.mergeKey === mergeKey && now - queued.queuedAt <= 360) {
          queued.type = type;
          queued.handler = handler;
          queued.data = mergeScenePayload(queued.data, data);
          queued.seq = Math.max(queued.seq || 0, seq || 0);
          queued.priority = Math.max(queued.priority || 0, priority || 0);
          queued.queuedAt = now;
          scheduleSceneEvents();
          return;
        }
      }
    }

    sceneEventQueue.push({ type, data, handler, seq, lane, priority, mergeKey, queuedAt: now });
    trimSceneLane(lane);
    scheduleSceneEvents();
  }

  // Status updates
  socket.on('connect', () => {
    console.log('Socket connected');
    setStatus('CONNECTED', 'connected');
    socket.emit('register', { type: 'overlay' }, ack => {
      if (ack && ack.success) seedSceneRegistration(ack);
    });
    fetch(withOverlayAuth('/state'))
      .then(response => response.ok ? response.json() : null)
      .then(syncGameState)
      .catch(() => {});
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
    setStatus('DISCONNECTED', 'disconnected');
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    setStatus('ERROR', 'disconnected');
  });

  socket.on('connect_error', () => {
    setStatus('SERVER ERROR', 'disconnected');
  });

  socket.on('gameState', syncGameState);
  socket.on('setupMode', (data = {}) => {
    if (data.active) {
      setStatus('SETUP', 'demo');
      if (scene.startDemo) scene.startDemo();
      if (scene.showBanner) scene.showBanner(data.title || 'Setup rehearsal running', 'event');
    } else if (scene.demoModeActive !== undefined) {
      scene.demoModeActive = false;
    }
  });
  socket.on('audioConfig', applyAudioConfig);
  socket.on('backgroundChanged', (data) => {
    const filename = data && data.filename;
    if (!filename) {
      if (scene.setBackgroundImageUrl) scene.setBackgroundImageUrl(null);
      return;
    }
    if (scene.setBackgroundImageUrl) {
      scene.setBackgroundImageUrl(data.url ? withOverlayAuth(data.url, { v: Date.now() }) : withOverlayAuth(`/background/${encodeURIComponent(filename)}`, { v: Date.now() }));
    }
  });
  socket.on('overlaySettings', (settings) => {
    if (!settings || typeof settings !== 'object') return;
    if (settings.laserColor && scene.updateLaserColor) scene.updateLaserColor(settings.laserColor);
    if (settings.shotSpeed !== undefined && scene.updateLayoutConfig) {
      scene.updateLayoutConfig('shotSpeed', Number(settings.shotSpeed));
    }
    if (settings.backgroundFit && scene.updateBackgroundFit) {
      scene.updateBackgroundFit(settings.backgroundFit);
    }
    if (settings.aetherisTerritoryId && scene.setTerritory) {
      scene.setTerritory(settings.aetherisTerritoryId);
    }
  });
  socket.on('laserColor', (data) => {
    const color = typeof data === 'string' ? data : data && data.color;
    if (color && scene.updateLaserColor) scene.updateLaserColor(color);
  });
  socket.on('soundEvent', (data) => {
    enqueueSceneEvent('soundEvent', data || {}, payload => {
      playSound(payload || {}, { force: Boolean(payload?.force || payload?.priority >= 90) });
      if (scene.showSoundPulse && payload?.event) scene.showSoundPulse(payload.event);
    }, { lane: 'sound' });
  });
  socket.on('sponsorPrepare', (payload) => {
    enqueueSceneEvent('sponsorPrepare', payload || {}, queuedPayload => {
      const scenePayload = resolveSponsorPayload(queuedPayload || {});
      if (scene.prepareSponsorBreak) {
        scene.prepareSponsorBreak(scenePayload);
      } else {
        reportSponsorPlayback(scenePayload, scenePayload.videoUrl ? 'failed' : 'ready', scenePayload.videoUrl ? 'Phaser sponsor prepare handler unavailable' : 'No media required');
      }
    }, { lane: 'exclusive' });
  });
  socket.on('sponsorScene', (payload) => {
    enqueueSceneEvent('sponsorScene', payload || {}, queuedPayload => {
      if (!scene.playSponsorBreak || !scene.stopSponsorBreak) return;
      if (queuedPayload && queuedPayload.action === 'hide') {
        scene.stopSponsorBreak('stopped');
        return;
      }
      const scenePayload = resolveSponsorPayload(queuedPayload || {});
      scene.playSponsorBreak(scenePayload);
    }, { lane: 'exclusive' });
  });

  // Overlay events
  socket.on('damage', (data) => {
    // data: { x, y, damage, type: 'normal'|'kill'|'critical' }
    scene.showDamage(data.x || game.scale.width / 2, data.y || game.scale.height / 2, data.damage, data.type);
  });

  socket.on('banner', (data) => {
    // data: { text, type: 'kill'|'streak'|'gift'|'legendary' }
    scene.showBanner(data.text, data.type);
  });

  socket.on('playerJoined', (data) => {
    // data: { id, name, avatar, health, kills, deaths, ... }
    scene.addPlayerCard({
      id: data.id || data.userId,
      name: data.name || 'Player',
      health: data.health || 100,
      kills: data.kills || 0,
      deaths: data.deaths || 0
    });
  });

  socket.on('playerLeft', (data) => {
    // data: { id }
    scene.removePlayerCard(data.id || data.userId);
  });

  socket.on('playerUpdate', (data) => {
    // data: { id, stats: { health, kills, deaths, ... } }
    scene.updatePlayerStats(data.id || data.userId, data.stats || data);
  });

  socket.on('attack', (data) => {
    enqueueSceneEvent('attack', data || {}, payload => {
      if (scene.handleAttackEvent) scene.handleAttackEvent(payload);
      else scene.showDamage(game.scale.width / 2, game.scale.height * 0.35, payload.damage || 'HIT', payload.killed ? 'kill' : payload.critical ? 'critical' : 'normal');
      playSound(payload.killed ? 'kill' : 'attack');
    });
  });
  socket.on('commentDamage', (data) => {
    enqueueSceneEvent('commentDamage', data || {}, payload => {
      if (scene.handleAttackEvent) scene.handleAttackEvent(payload);
      else scene.showDamage(game.scale.width / 2, game.scale.height * 0.35, payload.damage || 'HIT', payload.killed ? 'kill' : payload.critical ? 'critical' : 'normal');
      playSound(payload.killed ? 'kill' : 'attack');
    });
  });

  socket.on('giftAttack', (data) => {
    enqueueSceneEvent('giftAttack', data || {}, payload => {
      if (scene.handleGiftAttackEvent) scene.handleGiftAttackEvent(payload);
      else scene.showDamage(game.scale.width / 2, game.scale.height * 0.32, payload.damage || 'GIFT', payload.killed ? 'kill' : payload.tier === 'legendary' ? 'critical' : 'normal');
      playSound(payload.killed ? 'kill' : 'gift');
    });
  });

  socket.on('like', (data) => {
    enqueueSceneEvent('like', data || {}, payload => {
      if (scene.handleLikeEvent) scene.handleLikeEvent(payload || {});
    });
  });
  socket.on('heal', (data) => {
    enqueueSceneEvent('heal', data || {}, payload => {
      if (scene.handleHealEvent) scene.handleHealEvent(payload || {});
      playSound('heal');
    });
  });
  socket.on('spawn', (data) => {
    enqueueSceneEvent('spawn', data || {}, payload => {
      if (scene.spawnRespawnEffect) scene.spawnRespawnEffect(payload?.uniqueId || payload?.id || payload?.userId);
      playSound('respawn');
    });
  });
  socket.on('respawn', (data) => {
    enqueueSceneEvent('respawn', data || {}, payload => {
      if (scene.spawnRespawnEffect) scene.spawnRespawnEffect(payload?.uniqueId || payload?.id || payload?.userId);
      playSound('respawn');
    });
  });
  socket.on('playerCommand', (data) => {
    enqueueSceneEvent('playerCommand', data || {}, payload => {
      if (scene.handlePlayerCommand) scene.handlePlayerCommand(payload || {});
    });
  });
  socket.on('roundEvent', (data) => {
    enqueueSceneEvent('roundEvent', data || {}, payload => {
      if (scene.handleRoundEvent) scene.handleRoundEvent(payload || {});
    });
  });
  socket.on('bossWave', (data) => {
    enqueueSceneEvent('bossWave', data || {}, payload => {
      if (scene.handleBossWave) scene.handleBossWave(payload || {});
    });
  });
  socket.on('arenaPowerUp', (data) => {
    enqueueSceneEvent('arenaPowerUp', data || {}, payload => {
      if (scene.handleArenaPowerUp) scene.handleArenaPowerUp(payload || {});
    });
  });
  socket.on('aetherisStructures', (data) => {
    enqueueSceneEvent('aetherisStructures', data || {}, payload => {
      if (scene.updateAetherisStructures) scene.updateAetherisStructures(payload || {});
    }, { lane: 'state', mergeKey: 'aetheris-structures' });
  });
  socket.on('killEvent', (data) => {
    enqueueSceneEvent('killEvent', data || {}, payload => {
      if (scene.handleKillEvent) scene.handleKillEvent(payload || {});
      playSound('kill');
    });
  });
  socket.on('streakEvent', (data) => {
    enqueueSceneEvent('streakEvent', data || {}, payload => {
      if (scene.handleStreakEvent) scene.handleStreakEvent(payload || {});
    });
  });
  socket.on('giftCelebration', (data) => {
    enqueueSceneEvent('giftCelebration', data || {}, payload => {
      if (scene.handleGiftCelebration) scene.handleGiftCelebration(payload || {});
      playSound('gift');
    });
  });
  socket.on('follow', (data) => {
    enqueueSceneEvent('follow', data || {}, payload => {
      if (scene.handleFollowEvent) scene.handleFollowEvent(payload || {});
      playSound('follow');
    });
  });
  socket.on('socialBoost', (data) => {
    enqueueSceneEvent('socialBoost', data || {}, payload => {
      if (scene.showSocialBoost) scene.showSocialBoost(payload || {});
      playSound('socialBoost');
    });
  });
  socket.on('engagementSurge', (data) => {
    enqueueSceneEvent('engagementSurge', data || {}, payload => {
      if (scene.handleEngagementSurge) scene.handleEngagementSurge(payload || {});
      playSound('engagementSurge');
    });
  });
  socket.on('layoutUpdate', (data = {}) => {
    if (!scene.updateLayoutConfig) return;
    if (typeof data.gapX === 'number') scene.updateLayoutConfig('gapX', data.gapX);
    if (typeof data.gapY === 'number') scene.updateLayoutConfig('gapY', data.gapY);
  });
  socket.on('forceReload', (data = {}) => {
    const delayMs = Number(data.delayMs) || 3000;
    setStatus('RELOADING', 'connected');
    setTimeout(() => window.location.reload(), delayMs);
  });

  socket.on('effect:flash', (data) => {
    // data: { duration, color }
    scene.flashScreen(data.duration || 200, data.color || '#ff0000');
  });

  socket.on('effect:shake', (data) => {
    // data: { intensity }
    scene.shakeCam(data.intensity || 5);
  });

  // Demo data for testing (remove in production)
  window.overlaySocket = {
    socket,
    audioStatus: currentAudioStatus,
    applyAudioConfig,
    testSound: (event = 'attack') => playSound(event, { force: true }),
    testDamage: (dmg = 25, type = 'normal') => {
      socket.emit('damage', {
        x: game.scale.width / 2 + Math.random() * 200 - 100,
        y: game.scale.height / 2 - 100,
        damage: dmg,
        type: type
      });
    },
    testBanner: (text = 'KILL STREAK!', type = 'kill') => {
      socket.emit('banner', { text, type });
    },
    testFlash: () => {
      socket.emit('effect:flash', { duration: 200, color: '#ff0000' });
    },
    testShake: () => {
      socket.emit('effect:shake', { intensity: 8 });
    },
    testSponsorBreak: (payload = {}) => {
      if (!scene.playSponsorBreak) return;
      scene.playSponsorBreak({
        partner: 'IntoTheBattle',
        kicker: 'Arena Spotlight',
        title: 'Power Moment',
        subtitle: 'Stay locked in. The next fight is loading.',
        durationMs: 8000,
        fit: 'contain',
        muted: true,
        ...payload,
      });
    },
    testAddPlayer: (name = 'Player ' + Math.floor(Math.random() * 1000)) => {
      const playerId = 'player_' + Date.now();
      socket.emit('playerJoined', {
        id: playerId,
        name: name,
        health: 100,
        kills: Math.floor(Math.random() * 5),
        deaths: Math.floor(Math.random() * 3)
      });
      return playerId;
    },
    testUpdatePlayer: (playerId, health = 75, kills = 2) => {
      socket.emit('playerUpdate', {
        id: playerId,
        stats: { health, kills }
      });
    },
    testRemovePlayer: (playerId) => {
      socket.emit('playerLeft', { id: playerId });
    }
  };

  console.log('Socket overlay initialized. Use window.overlaySocket for testing.');

  if (overlayParams.get('sponsor_preview') === '1' && scene.playSponsorBreak) {
    const filename = overlayParams.get('sponsor_video') || '';
    const sponsorSource = overlayParams.get('sponsor_source') || '';
    const payload = {
      filename,
      videoUrl: filename
        ? sponsorSource === 'platform'
          ? withOverlayAuth(`/platform-sponsor/${encodeURIComponent(filename)}`, { v: Date.now() })
          : withOverlayAuth(`/sponsor/${encodeURIComponent(filename)}`, { v: Date.now() })
        : '',
      title: overlayParams.get('sponsor_title') || 'Power Moment',
      partner: overlayParams.get('sponsor_partner') || 'IntoTheBattle Partner',
      subtitle: overlayParams.get('sponsor_subtitle') || 'Stay locked in. The next fight is loading.',
      durationMs: Number(overlayParams.get('sponsor_duration')) || 15000,
      muted: overlayParams.get('sponsor_muted') !== '0',
      volume: normalizeMasterVolume(overlayParams.get('sponsor_volume'), currentMasterVolume()),
      fit: overlayParams.get('sponsor_fit') || 'contain',
      statsMode: overlayParams.get('sponsor_stats') || 'endcap',
      timingProfile: overlayParams.get('sponsor_timing') || 'spotlight',
      source: sponsorSource || 'creator',
    };
    setTimeout(() => scene.playSponsorBreak(payload), 600);
  }
}
