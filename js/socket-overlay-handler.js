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
  const audioConfig = {};
  const audioCache = {};

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

  window.overlayAuth = { roomId: overlayRoomId, overlayToken, withOverlayAuth };
  if (scene.setOverlayAuthHelper) scene.setOverlayAuthHelper(withOverlayAuth);

  const socketOptions = { transports: ['websocket', 'polling'], timeout: 5000 };
  if (overlayRoomId && overlayToken) {
    socketOptions.auth = { roomId: overlayRoomId, overlayToken };
    socketOptions.query = { room_id: overlayRoomId, overlay_token: overlayToken };
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
      deaths: Number(player.deaths || 0)
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
      audioCache[filename] = audio;
    }
    return audioCache[filename];
  }

  function playSound(event) {
    const filename = audioConfig[event];
    if (!filename) return;
    try {
      const audio = getAudio(filename);
      if (!audio) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (_err) {
      // Browser autoplay policies can reject playback until OBS/user interaction.
    }
  }

  // Status updates
  socket.on('connect', () => {
    console.log('Socket connected');
    setStatus('CONNECTED', 'connected');
    socket.emit('register', { type: 'overlay' });
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
  socket.on('audioConfig', (config) => {
    Object.keys(audioConfig).forEach(key => delete audioConfig[key]);
    if (config && typeof config === 'object') Object.assign(audioConfig, config);
  });
  socket.on('backgroundChanged', (data) => {
    const filename = data && data.filename;
    if (!filename) {
      if (scene.setBackgroundImageUrl) scene.setBackgroundImageUrl(null);
      return;
    }
    if (scene.setBackgroundImageUrl) {
      scene.setBackgroundImageUrl(withOverlayAuth(`/background/${encodeURIComponent(filename)}`, { v: Date.now() }));
    }
  });
  socket.on('overlaySettings', (settings) => {
    if (!settings || typeof settings !== 'object') return;
    if (settings.laserColor && scene.updateLaserColor) scene.updateLaserColor(settings.laserColor);
    if (settings.shotSpeed !== undefined && scene.updateLayoutConfig) {
      scene.updateLayoutConfig('shotSpeed', Number(settings.shotSpeed));
    }
  });
  socket.on('laserColor', (data) => {
    const color = typeof data === 'string' ? data : data && data.color;
    if (color && scene.updateLaserColor) scene.updateLaserColor(color);
  });
  socket.on('soundEvent', (data) => playSound(data && data.event));
  socket.on('sponsorScene', (payload) => {
    if (!scene.playSponsorBreak || !scene.stopSponsorBreak) return;
    if (payload && payload.action === 'hide') {
      scene.stopSponsorBreak();
      return;
    }
    const scenePayload = { ...(payload || {}) };
    if (scenePayload.filename && !scenePayload.videoUrl) {
      scenePayload.videoUrl = withOverlayAuth(`/sponsor/${encodeURIComponent(scenePayload.filename)}`, { v: scenePayload._ts || Date.now() });
    }
    scene.playSponsorBreak(scenePayload);
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
    if (!data) return;
    const type = data.killed ? 'kill' : data.critical ? 'critical' : 'normal';
    scene.showDamage(game.scale.width / 2, game.scale.height * 0.35, data.damage || 'HIT', type);
    playSound('attack');
  });

  socket.on('giftAttack', (data) => {
    if (!data) return;
    const type = data.killed ? 'kill' : data.tier === 'legendary' ? 'critical' : 'normal';
    scene.showDamage(game.scale.width / 2, game.scale.height * 0.32, data.damage || 'GIFT', type);
    playSound(data.killed ? 'kill' : 'gift');
  });

  socket.on('heal', () => playSound('heal'));
  socket.on('spawn', () => playSound('respawn'));
  socket.on('respawn', () => playSound('respawn'));

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
    const payload = {
      filename,
      videoUrl: filename ? withOverlayAuth(`/sponsor/${encodeURIComponent(filename)}`, { v: Date.now() }) : '',
      title: overlayParams.get('sponsor_title') || 'Power Moment',
      partner: overlayParams.get('sponsor_partner') || 'IntoTheBattle Partner',
      subtitle: overlayParams.get('sponsor_subtitle') || 'Stay locked in. The next fight is loading.',
      durationMs: Number(overlayParams.get('sponsor_duration')) || 15000,
      muted: overlayParams.get('sponsor_muted') !== '0',
      fit: overlayParams.get('sponsor_fit') || 'contain',
    };
    setTimeout(() => scene.playSponsorBreak(payload), 600);
  }
}
