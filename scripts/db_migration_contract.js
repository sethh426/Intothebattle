import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const schema = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'schema.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'tiktokbr', 'db', 'db.js'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

assert.match(schema, /CREATE TABLE IF NOT EXISTS schema_migrations/i, 'schema.sql must define schema_migrations');
assert.match(db, /INSERT INTO schema_migrations/i, 'db startup must record the baseline schema migration');
assert.match(db, /2026-07-02-baseline/, 'baseline schema migration version must be recorded');
assert.match(ci, /postgres-migrations:/, 'CI must keep a real Postgres migration/startup check');
assert.match(ci, /DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/intothebattle_ci/, 'CI migration job must run against Postgres, not the stub DB');

console.log('Database migration contract checks passed');
