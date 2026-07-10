import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './tiktokbr/db/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use DISK_PATH env var (Render: /var/data), fallback to local directory for development
const ROOT_DIR = process.env.DISK_PATH || path.join(__dirname);

export const DEFAULT_OVERLAY_SETTINGS = {
  laserColor: '#7afcff',
  shotType:   'beam',
  shotSpeed:  1,
  backgroundFit: 'contain',
};

export const DEFAULT_AUDIO_MASTER_VOLUME = 0.5;
export const AUDIO_EVENT_KEYS = Object.freeze([
  'attack',
  'gift',
  'kill',
  'respawn',
  'heal',
  'follow',
  'socialBoost',
  'engagementSurge',
]);

export const DEFAULT_AUDIO_CONFIG = {
  masterVolume:    DEFAULT_AUDIO_MASTER_VOLUME,
  attack:          null,
  gift:            null,
  kill:            null,
  respawn:         null,
  heal:            null,
  follow:          null,
  socialBoost:     null,
  engagementSurge: null,
};

export function normalizeAudioVolume(value, fallback = DEFAULT_AUDIO_MASTER_VOLUME) {
  const numeric = Number(value);
  const fallbackNumeric = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumeric) ? fallbackNumeric : DEFAULT_AUDIO_MASTER_VOLUME;
  const next = Number.isFinite(numeric) ? numeric : safeFallback;
  return Math.max(0, Math.min(1, Math.round(next * 100) / 100));
}

export function normalizeAudioConfig(config = {}) {
  const incoming = config && typeof config === 'object' ? config : {};
  const normalized = { ...DEFAULT_AUDIO_CONFIG };
  for (const event of AUDIO_EVENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, event)) {
      normalized[event] = incoming[event] || null;
    }
  }
  normalized.masterVolume = normalizeAudioVolume(incoming.masterVolume, DEFAULT_AUDIO_MASTER_VOLUME);
  return normalized;
}

const rooms = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeStoredStreamerUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function getRoomBackgroundDir(roomId) {
  return path.join(ROOT_DIR, 'backgrounds', roomId);
}

function getRoomAudioDir(roomId) {
  return path.join(ROOT_DIR, 'audio', roomId);
}

function getRoomSponsorDir(roomId) {
  return path.join(ROOT_DIR, 'sponsors', roomId);
}

function getRoomAudioConfigFile(roomId) {
  return path.join(getRoomAudioDir(roomId), 'audio-config.json');
}

export function getRoomPaths(roomId) {
  const backgroundDir = getRoomBackgroundDir(roomId);
  const legacyPaths = {
    backgroundMetaFile: path.join(backgroundDir, 'current-bg.json'),
    audioConfigFile: getRoomAudioConfigFile(roomId),
    sponsorConfigFile: path.join(getRoomSponsorDir(roomId), 'sponsor-config.json'),
  };

  return {
    backgroundDir,
    audioDir: getRoomAudioDir(roomId),
    sponsorDir: getRoomSponsorDir(roomId),
    // Legacy disk storage paths are migration-only. New data should use
    // room_settings / room_player_stats in the database.
    ...legacyPaths,
    legacy: legacyPaths,
  };
}

export function getOrCreateRoom(roomId) {
  if (!roomId) return null;
  if (rooms.has(roomId)) return rooms.get(roomId);

  const saved = db.prepare('SELECT * FROM room_settings WHERE room_id = ?').get(roomId);

  const room = {
    roomId,
    players: {},
    tiktokClient: null,
    streamerUsername: normalizeStoredStreamerUsername(saved?.streamer_username),
    overlaySettings: saved?.overlay_settings
      ? { ...DEFAULT_OVERLAY_SETTINGS, ...JSON.parse(saved.overlay_settings) }
      : { ...DEFAULT_OVERLAY_SETTINGS },
    audioConfig: saved?.audio_config
      ? normalizeAudioConfig(JSON.parse(saved.audio_config))
      : normalizeAudioConfig(),
    audioLibrary: saved?.audio_library
      ? JSON.parse(saved.audio_library)
      : [],
    sponsorLibrary: [],
    currentBackground: saved?.background_filename
      ? { filename: saved.background_filename }
      : null,
    overlayCount: 0,
  };

  ensureDir(getRoomBackgroundDir(roomId));
  ensureDir(getRoomAudioDir(roomId));
  ensureDir(getRoomSponsorDir(roomId));

  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function getAllRooms() {
  return rooms;
}

export function saveRoomSettings(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  db.prepare(`
    INSERT INTO room_settings
      (room_id, streamer_username, overlay_settings, audio_config, audio_library, background_filename, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(room_id) DO UPDATE SET
      streamer_username = excluded.streamer_username,
      overlay_settings = excluded.overlay_settings,
      audio_config = excluded.audio_config,
      audio_library = excluded.audio_library,
      background_filename = excluded.background_filename,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    roomId,
    normalizeStoredStreamerUsername(room.streamerUsername),
    JSON.stringify(room.overlaySettings),
    JSON.stringify(room.audioConfig),
    JSON.stringify(room.audioLibrary),
    room.currentBackground?.filename || null
  );
}
