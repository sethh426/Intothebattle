CREATE TABLE IF NOT EXISTS access_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  email TEXT,
  owner_name TEXT,
  room_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_promo INTEGER DEFAULT 0,
  is_revoked INTEGER DEFAULT 0,
  fingerprint TEXT,
  session_token TEXT,
  last_seen TIMESTAMP,
  paypal_subscription_id TEXT
);

CREATE TABLE IF NOT EXISTS room_settings (
  room_id TEXT PRIMARY KEY,
  overlay_settings TEXT DEFAULT '{}',
  audio_config TEXT DEFAULT '{}',
  audio_library TEXT DEFAULT '[]',
  background_filename TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  uses_remaining INTEGER DEFAULT 1,
  days_granted INTEGER DEFAULT 30,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  tiktok_username TEXT,
  session_token TEXT,
  is_active INTEGER DEFAULT 1,
  email_verified INTEGER DEFAULT 0,
  email_verification_token TEXT,
  email_verification_expires TIMESTAMP,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_rooms (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  room_id TEXT UNIQUE NOT NULL,
  room_name TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  plan_type TEXT,
  status TEXT DEFAULT 'active',
  started_at TIMESTAMP,
  next_billing_date TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS platform_sponsor_creatives (
  id SERIAL PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  original_name TEXT,
  partner TEXT,
  title TEXT,
  subtitle TEXT,
  duration_ms INTEGER DEFAULT 15000,
  stats_mode TEXT DEFAULT 'endcap',
  fit TEXT DEFAULT 'cover',
  muted INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS room_player_stats (
  room_id TEXT NOT NULL,
  unique_id TEXT NOT NULL,
  nickname TEXT,
  hp INTEGER DEFAULT 300,
  max_hp INTEGER DEFAULT 300,
  strength INTEGER DEFAULT 15,
  kills INTEGER DEFAULT 0,
  kill_streak INTEGER DEFAULT 0,
  last_kill_time INTEGER DEFAULT 0,
  alive INTEGER DEFAULT 0,
  last_active INTEGER,
  color TEXT,
  message_boost_expires INTEGER DEFAULT 0,
  force_spawn INTEGER DEFAULT 0,
  PRIMARY KEY(room_id, unique_id)
);

CREATE TABLE IF NOT EXISTS global_player_stats (
  unique_id TEXT PRIMARY KEY,
  nickname TEXT,
  hp INTEGER DEFAULT 300,
  max_hp INTEGER DEFAULT 300,
  strength INTEGER DEFAULT 15,
  kills INTEGER DEFAULT 0,
  last_active INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
