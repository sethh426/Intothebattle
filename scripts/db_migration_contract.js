import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const schema = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'schema.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'db.js'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

assert.match(schema, /CREATE TABLE IF NOT EXISTS schema_migrations/i, 'schema.sql must define schema_migrations');
assert.match(schema, /admin_granted INTEGER DEFAULT 0/i, 'subscriptions schema must include admin_granted');
assert.match(schema, /CREATE TABLE IF NOT EXISTS tiktok_accounts/i, 'schema.sql must define official TikTok linked accounts');
assert.match(schema, /tiktok_username TEXT/i, 'tiktok_accounts must store the official TikTok username when profile scope is granted');
assert.match(schema, /access_token_ciphertext TEXT/i, 'tiktok_accounts must store encrypted access tokens');
assert.match(schema, /refresh_token_ciphertext TEXT/i, 'tiktok_accounts must store encrypted refresh tokens');
assert.match(schema, /CREATE TABLE IF NOT EXISTS growth_events/i, 'schema.sql must define growth_events for paid-growth auditing');
assert.match(schema, /event_id TEXT UNIQUE NOT NULL/i, 'growth_events must store a unique event_id for deduplication');
assert.match(schema, /consent_state TEXT DEFAULT 'unknown'/i, 'growth_events must persist consent state');
assert.match(schema, /segment_status TEXT DEFAULT 'skipped'/i, 'growth_events must persist Segment forwarding status');
assert.match(schema, /CREATE TABLE IF NOT EXISTS admin_email_campaigns/i, 'schema.sql must define admin email campaigns');
assert.match(schema, /CREATE TABLE IF NOT EXISTS admin_email_deliveries/i, 'schema.sql must define admin email deliveries');
assert.match(schema, /CREATE TABLE IF NOT EXISTS referral_clicks/i, 'schema.sql must define referral click tracking');
assert.match(schema, /referral_click_id INTEGER/i, 'referral attributions must retain the originating tracked click when available');
assert.match(db, /INSERT INTO schema_migrations/i, 'db startup must record the baseline schema migration');
assert.match(db, /ALTER TABLE subscriptions ADD COLUMN admin_granted INTEGER DEFAULT 0/i, 'db startup must backfill subscriptions.admin_granted');
assert.match(db, /CREATE TABLE IF NOT EXISTS tiktok_accounts/i, 'db startup must create tiktok_accounts');
assert.match(db, /ALTER TABLE tiktok_accounts ADD COLUMN tiktok_username TEXT/i, 'db startup must backfill tiktok_accounts.tiktok_username');
assert.match(db, /CREATE UNIQUE INDEX IF NOT EXISTS tiktok_accounts_user_id_unique/i, 'db startup must keep one linked TikTok account per user');
assert.match(db, /CREATE TABLE IF NOT EXISTS growth_events/i, 'db startup must create growth_events when needed');
assert.match(db, /CREATE UNIQUE INDEX IF NOT EXISTS growth_events_event_id_unique/i, 'db startup must keep growth event ids unique');
assert.match(db, /CREATE TABLE IF NOT EXISTS admin_email_campaigns/i, 'db startup must create admin email campaigns');
assert.match(db, /CREATE TABLE IF NOT EXISTS admin_email_deliveries/i, 'db startup must create admin email deliveries');
assert.match(db, /CREATE TABLE IF NOT EXISTS referral_clicks/i, 'db startup must create referral click tracking');
assert.match(db, /ALTER TABLE referral_attributions ADD COLUMN referral_click_id INTEGER/i, 'db startup must backfill referral_attributions.referral_click_id');
assert.match(db, /2026-07-02-baseline/, 'baseline schema migration version must be recorded');
assert.match(ci, /postgres-migrations:/, 'CI must keep a real Postgres migration/startup check');
assert.match(ci, /DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/intothebattle_ci/, 'CI migration job must run against Postgres, not the stub DB');

console.log('Database migration contract checks passed');
