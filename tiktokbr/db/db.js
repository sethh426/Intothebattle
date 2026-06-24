import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_ROOT = process.env.DISK_PATH || path.join(__dirname, '..');
if (!fs.existsSync(DB_ROOT)) fs.mkdirSync(DB_ROOT, { recursive: true });

const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || process.env.PG_CONN_STRING;
const useStubDb = process.env.SKIP_DB === 'true';
if (!connectionString && !useStubDb) {
  throw new Error('PostgreSQL connection string is required. Set DATABASE_URL or PG_CONNECTION_STRING.');
}

const clientOptions = connectionString ? { connectionString } : {};
const useSsl = connectionString && (process.env.PGSSLMODE
  ? process.env.PGSSLMODE !== 'disable'
  : connectionString.includes('.render.com'));
if (useSsl) {
  clientOptions.ssl = { rejectUnauthorized: false };
}

const client = useStubDb ? null : new Client(clientOptions);
const workerPath = path.join(__dirname, 'pgWorker.js');
const syncWorker = useStubDb ? null : new Worker(workerPath, { workerData: { clientOptions } });
if (syncWorker) {
  syncWorker.on('error', (err) => {
    console.error('DB sync worker error:', err?.message || err);
    updateDbHealth({ lastError: err?.message || String(err) });
  });
  syncWorker.on('exit', (code) => {
    if (code !== 0) {
      console.error('DB sync worker exited unexpectedly:', code);
      updateDbHealth({ lastError: `DB sync worker exited with code ${code}` });
    }
  });
}
const dbHealth = {
  mode: useStubDb ? 'stub' : 'postgres',
  configured: Boolean(connectionString) || useStubDb,
  ssl: Boolean(useSsl),
  connectionAttempted: false,
  connected: useStubDb,
  initialized: useStubDb,
  lastError: null,
  updatedAt: new Date().toISOString(),
};
let initializationPromise = null;
const syncQueryTimeoutMs = Number(process.env.DB_SYNC_QUERY_TIMEOUT_MS || 10000);

function updateDbHealth(patch) {
  Object.assign(dbHealth, patch, { updatedAt: new Date().toISOString() });
}

export function getDbHealthSnapshot() {
  return { ...dbHealth };
}

// Initiate connection asynchronously without blocking the event loop
// Only attempt once to avoid "Client has already been connected" error
let connectionAttempted = false;
let connectionPromise = null;
function connectClient() {
  if (useStubDb) {
    return Promise.resolve();
  }

  if (!connectionAttempted) {
    connectionAttempted = true;
    updateDbHealth({ connectionAttempted: true });
    connectionPromise = client.connect().catch((err) => {
      console.error('DB background connection error (non-blocking):', err?.message || err);
      updateDbHealth({ connected: false, initialized: false, lastError: err?.message || String(err) });
      throw err;
    });
    connectionPromise.then(() => {
      updateDbHealth({ connected: true, lastError: null });
    }).catch(() => {});
  }
  return connectionPromise;
}

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

function normalizeStatementArgs(args) {
  if (!args.length) return [];
  if (args.length === 1) return normalizeParams(args[0]);
  return args;
}

function querySync(sql, params) {
  if (useStubDb) return { rows: [], rowCount: 0 };
  if (!syncWorker) throw new Error('Postgres sync worker is not available');

  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resultFile = path.join(os.tmpdir(), `intothebattle-db-${id}.json`);
  const sab = new SharedArrayBuffer(4);
  const state = new Int32Array(sab);

  syncWorker.postMessage({ sql, values: normalizeParams(params), resultFile, sab });
  const waitResult = Atomics.wait(state, 0, 0, syncQueryTimeoutMs);
  if (waitResult === 'timed-out') {
    try { fs.rmSync(resultFile, { force: true }); } catch (_) {}
    throw new Error(`Postgres sync query timed out after ${syncQueryTimeoutMs}ms`);
  }

  try {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (!result.ok) throw new Error(result.error || 'Postgres sync query failed');
    return result;
  } finally {
    try { fs.rmSync(resultFile, { force: true }); } catch (_) {}
  }
}

async function queryAsync(sql, params) {
  if (useStubDb) return { rows: [], rowCount: 0 };
  if (initializationPromise) await initializationPromise;
  await connectClient();
  return client.query(convertPlaceholders(sql), normalizeParams(params));
}

export async function getAsync(sql, params) {
  const result = await queryAsync(sql, params);
  return result.rows?.[0] || null;
}

export async function allAsync(sql, params) {
  const result = await queryAsync(sql, params);
  return result.rows || [];
}

export async function runAsync(sql, params) {
  return queryAsync(sql, params);
}

const prepareStatement = useStubDb
  ? () => ({
      get() { return null; },
      all() { return []; },
      run() { return null; },
    })
  : function prepareStatement() {
      const queryText = arguments.length === 2 ? arguments[1] : arguments[0];
      const sql = convertPlaceholders(queryText);

      return {
        get(...params) {
          try {
            const result = querySync(sql, normalizeStatementArgs(params));
            return result.rows?.[0];
          } catch (err) {
            console.error('DB query error (get):', err?.message || err);
            throw err;
          }
        },
        all(...params) {
          try {
            const result = querySync(sql, normalizeStatementArgs(params));
            return result.rows || [];
          } catch (err) {
            console.error('DB query error (all):', err?.message || err);
            throw err;
          }
        },
        run(...params) {
          try {
            return querySync(sql, normalizeStatementArgs(params));
          } catch (err) {
            console.error('DB query error (run):', err?.message || err);
            throw err;
          }
        }
      };
    };

const db = {
  prepare: prepareStatement,
  exec(sql) {
    return useStubDb ? null : querySync(sql);
  },
  pragma() {
    return null;
  },
  transaction(fn) {
    if (useStubDb) {
      return (...args) => fn(...args);
    }
    return (...args) => {
      querySync('BEGIN');
      try {
        const result = fn(...args);
        querySync('COMMIT');
        return result;
      } catch (error) {
        querySync('ROLLBACK');
        throw error;
      }
    };
  }
};

async function initDb() {
  try {
    await connectClient();
    console.info('Postgres connected — running schema and migrations');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);

    const safeExec = async (sql) => {
      try { await client.query(sql); } catch (_) {}
    };

    await safeExec("ALTER TABLE access_codes ADD COLUMN owner_name TEXT");
    await safeExec("ALTER TABLE access_codes ADD COLUMN paypal_subscription_id TEXT");
    await safeExec("ALTER TABLE access_codes ADD COLUMN room_id TEXT");

    await safeExec(`
      CREATE TABLE IF NOT EXISTS room_settings (
        room_id TEXT PRIMARY KEY,
        overlay_settings TEXT DEFAULT '{}',
        audio_config TEXT DEFAULT '{}',
        audio_library TEXT DEFAULT '[]',
        background_filename TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    try {
      await client.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", ['require_room_id', '1']);
    } catch (_) {}

    await safeExec(`
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
      )
    `);

    await safeExec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
    await safeExec('ALTER TABLE users ADD COLUMN email_verification_token TEXT');
    await safeExec('ALTER TABLE users ADD COLUMN email_verification_expires TIMESTAMP');
    await safeExec('ALTER TABLE users ADD COLUMN password_reset_token TEXT');
    await safeExec('ALTER TABLE users ADD COLUMN password_reset_expires TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS user_rooms (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        room_id TEXT UNIQUE NOT NULL,
        room_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    await safeExec(`
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
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS platform_sponsor_creatives (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        original_name TEXT,
        campaign_name TEXT DEFAULT 'Default Campaign',
        partner TEXT,
        title TEXT,
        subtitle TEXT,
        duration_ms INTEGER DEFAULT 15000,
        duration_seconds REAL,
        width INTEGER,
        height INTEGER,
        file_size BIGINT DEFAULT 0,
        mime_type TEXT,
        video_codec TEXT,
        audio_codec TEXT,
        aspect_ratio TEXT,
        thumbnail_data TEXT,
        quality_warnings TEXT,
        quality_status TEXT DEFAULT 'ready',
        quality_score INTEGER DEFAULT 100,
        quality_blockers TEXT,
        quality_recommendations TEXT,
        normalized INTEGER DEFAULT 0,
        processing_status TEXT DEFAULT 'ready',
        processing_message TEXT,
        stats_mode TEXT DEFAULT 'endcap',
        fit TEXT DEFAULT 'cover',
        muted INTEGER DEFAULT 1,
        weight INTEGER DEFAULT 1,
        cooldown_seconds INTEGER DEFAULT 600,
        status TEXT DEFAULT 'active',
        readiness_status TEXT DEFAULT 'ready',
        impressions INTEGER DEFAULT 0,
        completions INTEGER DEFAULT 0,
        failures INTEGER DEFAULT 0,
        last_shown_at TIMESTAMP,
        last_completed_at TIMESTAMP,
        last_tested_at TIMESTAMP,
        last_failed_at TIMESTAMP,
        processed_at TIMESTAMP,
        active_starts_at TIMESTAMP,
        active_ends_at TIMESTAMP,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeExec("ALTER TABLE platform_sponsor_creatives ADD COLUMN campaign_name TEXT DEFAULT 'Default Campaign'");
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN duration_seconds REAL');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN width INTEGER');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN height INTEGER');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN file_size BIGINT DEFAULT 0');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN mime_type TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN video_codec TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN audio_codec TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN aspect_ratio TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN thumbnail_data TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN quality_warnings TEXT');
    await safeExec("ALTER TABLE platform_sponsor_creatives ADD COLUMN quality_status TEXT DEFAULT 'ready'");
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN quality_score INTEGER DEFAULT 100');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN quality_blockers TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN quality_recommendations TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN normalized INTEGER DEFAULT 0');
    await safeExec("ALTER TABLE platform_sponsor_creatives ADD COLUMN processing_status TEXT DEFAULT 'ready'");
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN processing_message TEXT');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN cooldown_seconds INTEGER DEFAULT 600');
    await safeExec("ALTER TABLE platform_sponsor_creatives ADD COLUMN readiness_status TEXT DEFAULT 'ready'");
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN impressions INTEGER DEFAULT 0');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN completions INTEGER DEFAULT 0');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN failures INTEGER DEFAULT 0');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN last_shown_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN last_completed_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN last_tested_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN last_failed_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN processed_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN active_starts_at TIMESTAMP');
    await safeExec('ALTER TABLE platform_sponsor_creatives ADD COLUMN active_ends_at TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS signup_intents (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        tiktok_username TEXT,
        source TEXT DEFAULT 'signup',
        last_path TEXT,
        converted_at TIMESTAMP,
        followup_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE signup_intents ADD COLUMN source TEXT DEFAULT \'signup\'');
    await safeExec('ALTER TABLE signup_intents ADD COLUMN last_path TEXT');
    await safeExec('ALTER TABLE signup_intents ADD COLUMN converted_at TIMESTAMP');
    await safeExec('ALTER TABLE signup_intents ADD COLUMN followup_sent_at TIMESTAMP');
    await safeExec('ALTER TABLE signup_intents ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS creator_comments (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        role TEXT,
        comment TEXT NOT NULL,
        status TEXT DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE creator_comments ADD COLUMN role TEXT');
    await safeExec("ALTER TABLE creator_comments ADD COLUMN status TEXT DEFAULT 'approved'");
    await safeExec('ALTER TABLE creator_comments ADD COLUMN deleted_at TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS marketing_posts (
        id SERIAL PRIMARY KEY,
        campaign_date DATE NOT NULL,
        platform TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        audience TEXT,
        goal TEXT DEFAULT 'sales',
        hook TEXT,
        body TEXT NOT NULL,
        cta TEXT,
        url TEXT,
        utm_url TEXT,
        hashtags TEXT,
        seo_keywords TEXT,
        scheduled_for TIMESTAMP,
        status TEXT DEFAULT 'draft',
        error_message TEXT,
        published_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_date, platform, topic_key)
      )
    `);
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN audience TEXT');
    await safeExec("ALTER TABLE marketing_posts ADD COLUMN goal TEXT DEFAULT 'sales'");
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN hook TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN cta TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN url TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN utm_url TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN hashtags TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN seo_keywords TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN scheduled_for TIMESTAMP');
    await safeExec("ALTER TABLE marketing_posts ADD COLUMN status TEXT DEFAULT 'draft'");
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN error_message TEXT');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN published_at TIMESTAMP');
    await safeExec('ALTER TABLE marketing_posts ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    await safeExec('CREATE UNIQUE INDEX IF NOT EXISTS marketing_posts_daily_platform_topic ON marketing_posts(campaign_date, platform, topic_key)');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS marketing_publish_events (
        id SERIAL PRIMARY KEY,
        marketing_post_id INTEGER,
        platform TEXT,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS growth_api_events (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        subject_email TEXT,
        status TEXT DEFAULT 'skipped',
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec("ALTER TABLE growth_api_events ADD COLUMN status TEXT DEFAULT 'skipped'");
    await safeExec('ALTER TABLE growth_api_events ADD COLUMN detail TEXT');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS growth_utm_events (
        id SERIAL PRIMARY KEY,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_content TEXT,
        path TEXT,
        referrer TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN utm_medium TEXT');
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN utm_campaign TEXT');
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN utm_content TEXT');
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN path TEXT');
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN referrer TEXT');
    await safeExec('ALTER TABLE growth_utm_events ADD COLUMN user_agent TEXT');
    await safeExec('CREATE INDEX IF NOT EXISTS growth_utm_events_created_at_idx ON growth_utm_events(created_at)');
    await safeExec('CREATE INDEX IF NOT EXISTS growth_utm_events_campaign_idx ON growth_utm_events(utm_campaign, utm_source)');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS growth_creative_assets (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        asset_url TEXT NOT NULL,
        source TEXT DEFAULT 'manual',
        approval_status TEXT DEFAULT 'approved',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE growth_creative_assets ADD COLUMN source TEXT DEFAULT \'manual\'');
    await safeExec("ALTER TABLE growth_creative_assets ADD COLUMN approval_status TEXT DEFAULT 'approved'");
    await safeExec('ALTER TABLE growth_creative_assets ADD COLUMN notes TEXT');
    await safeExec('ALTER TABLE growth_creative_assets ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS growth_creative_variants (
        id SERIAL PRIMARY KEY,
        template_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        format TEXT,
        status TEXT DEFAULT 'draft',
        asset_id INTEGER,
        asset_url TEXT,
        hook TEXT,
        proof TEXT,
        cta TEXT,
        body TEXT NOT NULL,
        utm_url TEXT,
        block_json TEXT,
        safe_zone_json TEXT,
        quality_status TEXT DEFAULT 'draft',
        quality_score INTEGER DEFAULT 0,
        quality_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN format TEXT');
    await safeExec("ALTER TABLE growth_creative_variants ADD COLUMN status TEXT DEFAULT 'draft'");
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN asset_id INTEGER');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN asset_url TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN hook TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN proof TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN cta TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN utm_url TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN block_json TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN safe_zone_json TEXT');
    await safeExec("ALTER TABLE growth_creative_variants ADD COLUMN quality_status TEXT DEFAULT 'draft'");
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN quality_score INTEGER DEFAULT 0');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN quality_notes TEXT');
    await safeExec('ALTER TABLE growth_creative_variants ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS sponsor_playback_events (
        id SERIAL PRIMARY KEY,
        break_id TEXT NOT NULL,
        room_id TEXT,
        source TEXT DEFAULT 'creator',
        creative_id INTEGER,
        filename TEXT,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS live_sessions (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        summary_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeExec('ALTER TABLE live_sessions ADD COLUMN summary_json TEXT');
    await safeExec("ALTER TABLE live_sessions ADD COLUMN status TEXT DEFAULT 'active'");
    await safeExec('ALTER TABLE live_sessions ADD COLUMN ended_at TIMESTAMP');

    await safeExec('ALTER TABLE access_codes ADD COLUMN user_id INTEGER');
    await safeExec("ALTER TABLE access_codes ADD COLUMN code_type TEXT DEFAULT 'trial'");

    // Migrate access_codes without room_id
    try {
      const res = await client.query("SELECT id FROM access_codes WHERE room_id IS NULL OR room_id = ''");
      const codesWithoutRoom = res.rows || [];
      for (const row of codesWithoutRoom) {
        const roomId = Math.random().toString(36).slice(2, 10);
        await client.query('UPDATE access_codes SET room_id = $1 WHERE id = $2', [roomId, row.id]);
      }
    } catch (_) {}

    await safeExec('ALTER TABLE access_codes ADD COLUMN trial_started TIMESTAMP');
    await safeExec('ALTER TABLE access_codes ADD COLUMN trial_days INTEGER DEFAULT 14');
    await safeExec("ALTER TABLE access_codes ADD COLUMN subscription_status TEXT DEFAULT 'active'");
    await safeExec('ALTER TABLE access_codes ADD COLUMN streamer_name TEXT');
    await safeExec('ALTER TABLE access_codes ADD COLUMN tiktok_username TEXT');

    await safeExec(`
      CREATE TABLE IF NOT EXISTS battle_stats (
        id SERIAL PRIMARY KEY,
        code_id INTEGER NOT NULL,
        room_id TEXT,
        total_battles INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        total_kills INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(code_id) REFERENCES access_codes(id)
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS room_player_stats (
        room_id TEXT NOT NULL,
        unique_id TEXT NOT NULL,
        nickname TEXT,
        hp INTEGER DEFAULT 300,
        max_hp INTEGER DEFAULT 300,
        strength INTEGER DEFAULT 15,
        kills INTEGER DEFAULT 0,
        kill_streak INTEGER DEFAULT 0,
        last_kill_time BIGINT DEFAULT 0,
        alive INTEGER DEFAULT 0,
        last_active BIGINT,
        color TEXT,
        message_boost_expires BIGINT DEFAULT 0,
        force_spawn INTEGER DEFAULT 0,
        PRIMARY KEY(room_id, unique_id)
      )
    `);

    await safeExec(`
      CREATE TABLE IF NOT EXISTS global_player_stats (
        unique_id TEXT PRIMARY KEY,
        nickname TEXT,
        hp INTEGER DEFAULT 300,
        max_hp INTEGER DEFAULT 300,
        strength INTEGER DEFAULT 15,
        kills INTEGER DEFAULT 0,
        last_active BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeExec('ALTER TABLE room_player_stats ALTER COLUMN last_kill_time TYPE BIGINT USING last_kill_time::bigint');
    await safeExec('ALTER TABLE room_player_stats ALTER COLUMN last_active TYPE BIGINT USING last_active::bigint');
    await safeExec('ALTER TABLE room_player_stats ALTER COLUMN message_boost_expires TYPE BIGINT USING message_boost_expires::bigint');
    await safeExec('ALTER TABLE global_player_stats ALTER COLUMN last_active TYPE BIGINT USING last_active::bigint');

    // Seed beta access codes
    try {
      for (let i = 1; i <= 25; i++) {
        await client.query(
          `INSERT INTO access_codes (code, email, expires_at, trial_started, subscription_status, code_type)
           VALUES ($1, $2, '2099-12-31 23:59:59', CURRENT_TIMESTAMP, 'active', 'beta-tester')
           ON CONFLICT (code) DO UPDATE SET code_type = COALESCE(NULLIF(access_codes.code_type, ''), 'beta-tester')`,
          [`Betatester${i}`, `betatester${i}@tiktokbr.com`]
        );
      }
    } catch (_) {}

    console.info('DB initialization complete');
    updateDbHealth({ connected: true, initialized: true, lastError: null });
  } catch (err) {
    console.error('DB init error:', err?.message || err);
    updateDbHealth({ initialized: false, lastError: err?.message || String(err) });
  }
}

// Start initialization in the background so module load doesn't block
if (!useStubDb) {
  initializationPromise = initDb().catch(err => {
    console.error('initDb failed:', err);
    throw err;
  });
}

export default db;
