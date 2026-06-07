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
};

export const DEFAULT_AUDIO_CONFIG = {
  attack:  null,
  gift:    null,
  kill:    null,
  respawn: null,
  heal:    null,
  follow:  null,
};

const rooms = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getRoomBackgroundDir(roomId) {
  return path.join(ROOT_DIR, 'backgrounds', roomId);
}

function getRoomAudioDir(roomId) {
  return path.join(ROOT_DIR, 'audio', roomId);
}

function getRoomAudioConfigFile(roomId) {
  return path.join(getRoomAudioDir(roomId), 'audio-config.json');
}

export function getRoomPaths(roomId) {
  const backgroundDir = getRoomBackgroundDir(roomId);
  const legacyPaths = {
    playerStatsFile: path.join(ROOT_DIR, `players_${roomId}.json`),
    backgroundMetaFile: path.join(backgroundDir, 'current-bg.json'),
    audioConfigFile: getRoomAudioConfigFile(roomId),
  };

  return {
    backgroundDir,
    audioDir: getRoomAudioDir(roomId),
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
    streamerUsername: '',
    overlaySettings: saved?.overlay_settings
      ? { ...DEFAULT_OVERLAY_SETTINGS, ...JSON.parse(saved.overlay_settings) }
      : { ...DEFAULT_OVERLAY_SETTINGS },
    audioConfig: saved?.audio_config
      ? { ...DEFAULT_AUDIO_CONFIG, ...JSON.parse(saved.audio_config) }
      : { ...DEFAULT_AUDIO_CONFIG },
    audioLibrary: saved?.audio_library
      ? JSON.parse(saved.audio_library)
      : [],
    currentBackground: saved?.background_filename
      ? { filename: saved.background_filename }
      : null,
    overlayCount: 0,
  };

  ensureDir(getRoomBackgroundDir(roomId));
  ensureDir(getRoomAudioDir(roomId));

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
      (room_id, overlay_settings, audio_config, audio_library, background_filename, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(room_id) DO UPDATE SET
      overlay_settings = excluded.overlay_settings,
      audio_config = excluded.audio_config,
      audio_library = excluded.audio_library,
      background_filename = excluded.background_filename,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    roomId,
    JSON.stringify(room.overlaySettings),
    JSON.stringify(room.audioConfig),
    JSON.stringify(room.audioLibrary),
    room.currentBackground?.filename || null
  );
}
