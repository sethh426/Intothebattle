import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const schema = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'schema.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'db.js'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

assert.match(schema, /CREATE TABLE IF NOT EXISTS schema_migrations/i, 'schema.sql must define schema_migrations');
assert.match(schema, /admin_granted INTEGER DEFAULT 0/i, 'subscriptions schema must include admin_granted');
assert.match(schema, /CREATE TABLE IF NOT EXISTS growth_events/i, 'schema.sql must define growth_events for paid-growth auditing');
assert.match(schema, /event_id TEXT UNIQUE NOT NULL/i, 'growth_events must store a unique event_id for deduplication');
assert.match(schema, /consent_state TEXT DEFAULT 'unknown'/i, 'growth_events must persist consent state');
assert.match(schema, /segment_status TEXT DEFAULT 'skipped'/i, 'growth_events must persist Segment forwarding status');
assert.match(db, /INSERT INTO schema_migrations/i, 'db startup must record the baseline schema migration');
assert.match(db, /ALTER TABLE subscriptions ADD COLUMN admin_granted INTEGER DEFAULT 0/i, 'db startup must backfill subscriptions.admin_granted');
assert.match(db, /CREATE TABLE IF NOT EXISTS growth_events/i, 'db startup must create growth_events when needed');
assert.match(db, /CREATE UNIQUE INDEX IF NOT EXISTS growth_events_event_id_unique/i, 'db startup must keep growth event ids unique');
assert.match(db, /2026-07-02-baseline/, 'baseline schema migration version must be recorded');
assert.match(ci, /postgres-migrations:/, 'CI must keep a real Postgres migration/startup check');
assert.match(ci, /DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/intothebattle_ci/, 'CI migration job must run against Postgres, not the stub DB');

console.log('Database migration contract checks passed');
