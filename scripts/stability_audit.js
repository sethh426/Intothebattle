import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const errors = [];
const warnings = [];
const notes = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function readText(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function addError(message) { errors.push(message); }
function addWarning(message) { warnings.push(message); }
function addNote(message) { notes.push(message); }

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test-results') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (entry.isFile() && entry.name.endsWith('.js')) results.push(full);
  }
  return results;
}

function runSyntaxCheck() {
  const files = walk(root);
  for (const file of files) {
    const relative = path.relative(root, file);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      addError(`Syntax check failed: ${relative}\n${String(err.stderr || err.message || err)}`);
    }
  }
  addNote(`Checked JavaScript syntax for ${files.length} files.`);
}

function checkDependencies() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, version] of Object.entries(deps)) {
    if (String(version).trim() === 'latest') addError(`Dependency ${name} is pinned to "latest". Pin an exact version or semver range.`);
  }

  const rootLockDeps = lock.packages?.['']?.dependencies || {};
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (rootLockDeps[name] && rootLockDeps[name] !== version) {
      addWarning(`package-lock root dependency mismatch for ${name}: package.json=${version}, lock=${rootLockDeps[name]}. Run npm install after dependency edits.`);
    }
  }

  if (pkg.dependencies?.['@tiktool/live'] === 'latest') {
    addError('@tiktool/live must not use latest. TikTok connector changes can silently break installs.');
  }
}

function checkServerRiskSignals() {
  const server = readText('server.js');

  if (server.includes('app.use(express.static(__dirname))')) {
    addWarning('server.js still serves the repository root with express.static(__dirname). Prefer explicit /js, /assets, /audio, and public page routes before public beta.');
  }

  if (/req\.query\.token|query\.token/.test(server)) {
    addWarning('A token appears to be accepted through query params. Prefer Authorization headers for production-only sensitive endpoints.');
  }

  if (server.includes('DASHBOARD_PASSWORD') || server.includes('dashboard_auth')) {
    addWarning('Legacy dashboard password/cookie auth code is still present. Confirm it is required or remove it.');
  }

  if (server.includes('JSON.parse(fs.readFileSync')) || server.includes('readFileSync') && server.includes('playerStatsFile')) {
    addWarning('Legacy JSON migration/read path still exists. Keep it temporary and remove after migration is complete.');
  }

  if (!server.includes('validateRuntimeConfiguration()')) {
    addError('Runtime configuration validation was not found in server.js.');
  }

  if (!server.includes('validateWritableStorage()')) {
    addError('Writable storage validation was not found in server.js.');
  }

  if (!server.includes('verifyOverlayToken')) {
    addWarning('Overlay token verification was not found. Signed overlay URLs should be required for public OBS/browser-source routes.');
  }
}

function checkRequiredScripts() {
  const pkg = readJson('package.json');
  const scripts = pkg.scripts || {};
  for (const name of ['validate:schemas', 'test:http', 'test:socket', 'test:e2e']) {
    if (!scripts[name]) addWarning(`Missing npm script: ${name}`);
  }
  if (!scripts['test:all']) addWarning('Missing npm script: test:all');
}

function checkImportantFiles() {
  const required = [
    'server.js',
    'roomManager.js',
    'package-lock.json',
    'tests/e2e/visual-smoke.spec.js',
    'scripts/http_smoke.js',
    'scripts/socket_smoke.js',
    'tiktokbr/routes/auth.js',
    'tiktokbr/db/db.js',
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(root, file))) addWarning(`Expected file is missing: ${file}`);
  }
}

runSyntaxCheck();
checkDependencies();
checkServerRiskSignals();
checkRequiredScripts();
checkImportantFiles();

console.log('\nIntoTheBattle stability audit');
console.log('================================');
for (const note of notes) console.log(`NOTE  ${note}`);
for (const warning of warnings) console.log(`WARN  ${warning}`);
for (const error of errors) console.log(`FAIL  ${error}`);

if (!warnings.length && !errors.length) console.log('PASS  No stability audit findings.');
else console.log(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s).`);

if (errors.length) process.exit(1);
