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
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    addWarning(`Skipping unreadable directory during syntax walk: ${path.relative(root, dir) || dir} (${err.code || err.message})`);
    return results;
  }

  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'test-results' ||
      entry.name === 'playwright-report' ||
      entry.name.startsWith('.tmp-')
    ) continue;
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
    if (String(version).trim() === 'latest') {
      addWarning(`Dependency ${name} uses "latest". Pin it during the next npm install/package-lock update cycle.`);
    }
  }

  const rootLockDeps = lock.packages?.['']?.dependencies || {};
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (rootLockDeps[name] && rootLockDeps[name] !== version) {
      addError(`package-lock root dependency mismatch for ${name}: package.json=${version}, lock=${rootLockDeps[name]}. Run npm install after dependency edits.`);
    }
  }

  if (pkg.dependencies?.['@tiktool/live'] === 'latest') {
    addWarning('@tiktool/live currently uses latest. package-lock resolves 2.7.1; pin package.json and refresh package-lock together in the next dependency-maintenance commit.');
  }
}

function checkServerRiskSignals() {
  const server = readText('server.js');

  if (server.includes('app.use(express.static(__dirname))')) {
    addError('server.js serves the repository root with express.static(__dirname). Use explicit public asset routes only.');
  }

  if (/req\.query\.token|query\.token/.test(server)) {
    addWarning('A token appears to be accepted through query params. Prefer Authorization headers for production-only sensitive endpoints.');
  }

  if (server.includes('DASHBOARD_PASSWORD') || server.includes('dashboard_auth')) {
    addWarning('Legacy dashboard password/cookie auth code is still present. Confirm it is required or remove it.');
  }

  if (server.includes('playerStatsFile')) {
    addWarning('Legacy player JSON migration/read path still exists. Keep it temporary and remove after migration is complete.');
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
  for (const name of ['validate:schemas', 'test:http', 'test:socket', 'test:e2e', 'audit:stability', 'test:all']) {
    if (!scripts[name]) addWarning(`Missing npm script: ${name}`);
  }
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

function checkOverlayModuleContracts() {
  const overlayHtml = readText('overlay.html');
  const httpSmoke = readText('scripts/http_smoke.js');
  const inlineRuntimeIndex = overlayHtml.indexOf('<script>\n(function ()');
  const modules = [
    {
      file: 'js/overlay/stage-config.js',
      globalName: 'IntoTheBattleOverlayStageConfig',
      consumerMarker: 'window.IntoTheBattleOverlayStageConfig',
    },
    {
      file: 'js/overlay/overlay-normalizers.js',
      globalName: 'IntoTheBattleOverlayNormalizers',
      consumerMarker: 'window.IntoTheBattleOverlayNormalizers',
    },
    {
      file: 'js/overlay/overlay-diagnostics.js',
      globalName: 'IntoTheBattleOverlayDiagnostics',
      consumerMarker: 'window.IntoTheBattleOverlayDiagnostics',
    },
    {
      file: 'js/overlay/overlay-audio.js',
      globalName: 'IntoTheBattleOverlayAudio',
      consumerMarker: 'window.IntoTheBattleOverlayAudio',
    },
    {
      file: 'js/overlay/video-agent.js',
      globalName: 'IntoTheBattleOverlayVideoAgent',
      consumerMarker: 'window.IntoTheBattleOverlayVideoAgent',
    },
  ];

  let previousIndex = -1;
  for (const item of modules) {
    const scriptPath = `/${item.file.replaceAll('\\', '/')}`;
    const scriptTag = `<script src="${scriptPath}"></script>`;
    const scriptIndex = overlayHtml.indexOf(scriptTag);
    const fullPath = path.join(root, item.file);

    if (!fs.existsSync(fullPath)) {
      addError(`Overlay module is missing: ${item.file}`);
      continue;
    }
    const moduleText = readText(item.file);
    if (!moduleText.includes(item.globalName)) {
      addError(`Overlay module ${item.file} does not export ${item.globalName}.`);
    }
    if (scriptIndex < 0) {
      addError(`overlay.html does not load ${scriptPath}.`);
    } else {
      if (inlineRuntimeIndex >= 0 && scriptIndex > inlineRuntimeIndex) {
        addError(`${scriptPath} must load before the inline overlay runtime.`);
      }
      if (previousIndex >= 0 && scriptIndex < previousIndex) {
        addError(`Overlay module load order is unstable around ${scriptPath}.`);
      }
      previousIndex = scriptIndex;
    }
    if (!overlayHtml.includes(item.consumerMarker)) {
      addError(`overlay.html does not consume ${item.globalName}.`);
    }
    if (!httpSmoke.includes(scriptPath)) {
      addError(`HTTP smoke does not check overlay module asset ${scriptPath}.`);
    }
  }

  if (/const\s+OVERLAY_STAGE\s*=\s*Object\.freeze/.test(overlayHtml)) {
    addError('overlay.html reintroduced inline OVERLAY_STAGE data; keep it in js/overlay/stage-config.js.');
  }
  if (/const\s+EFFECT_ALIASES\s*=/.test(overlayHtml)) {
    addError('overlay.html reintroduced inline effect aliases; keep them in js/overlay/overlay-normalizers.js.');
  }
  if (/const\s+DEFAULT_OVERLAY_AUDIO_CONFIG\s*=\s*Object\.freeze/.test(overlayHtml)) {
    addError('overlay.html reintroduced inline default audio config; keep it in js/overlay/overlay-audio.js.');
  }
  if (/function\s+(normalizeAuditRect|auditObjectLayout|domLayerLeakLabels)\s*\(/.test(overlayHtml)) {
    addError('overlay.html reintroduced diagnostics helpers; keep them in js/overlay/overlay-diagnostics.js.');
  }
  if (!overlayHtml.includes('prefers-reduced-motion: reduce')) {
    addError('overlay.html is missing the reduced-motion CSS path for overlay motion comfort.');
  }
  if (!overlayHtml.includes('motionParticleCount') || !overlayHtml.includes('currentOverlayMotionStatus')) {
    addError('overlay.html is missing reduced-motion canvas effect controls.');
  }
  if (!overlayHtml.includes('resolveEffectEntity') || !overlayHtml.includes('testEffectOwnership') || !overlayHtml.includes('unownedEffects')) {
    addError('overlay.html is missing combat effect ownership enforcement/status hooks.');
  }
  if (!overlayHtml.includes('sponsorVideoAgent.status') || !readText('js/overlay/video-agent.js').includes('status(payload = {})')) {
    addError('Overlay sponsor video-agent status hook is missing.');
  }
  if (!overlayHtml.includes('currentConnectionStatus') || !overlayHtml.includes('connectionHealthStats')) {
    addError('overlay.html is missing overlay connection health status.');
  }
  if (!overlayHtml.includes('currentBackgroundStatus') || !overlayHtml.includes('handleBackgroundChanged') || !overlayHtml.includes('backgroundAssetStatus')) {
    addError('overlay.html is missing background asset health status.');
  }
  if (!overlayHtml.includes('testBackground')) {
    addError('overlay.html is missing the deterministic background asset test hook.');
  }
  if (!overlayHtml.includes('SPONSOR_QUEUE_MAX') || !overlayHtml.includes('currentSponsorSceneStatus') || !overlayHtml.includes('enqueueSponsorScenePayload')) {
    addError('overlay.html is missing bounded sponsor scene queue health controls.');
  }
  if (!overlayHtml.includes('testSponsorQueue') || !overlayHtml.includes('runSponsorQueueStress')) {
    addError('overlay.html is missing the deterministic sponsor queue stress probe.');
  }
  if (!overlayHtml.includes('currentAudioStatus') || !overlayHtml.includes('applyAudioConfig(audioConfig)')) {
    addError('overlay.html is missing overlay audio preload/status coverage.');
  }
  if (!overlayHtml.includes('visualQueueStats') || !overlayHtml.includes('currentVisualQueueStatus')) {
    addError('overlay.html is missing visual event queue health status.');
  }
  if (!overlayHtml.includes('currentFrameHealthStatus') || !overlayHtml.includes('recordFrameHealth') || !overlayHtml.includes('resetFrameHealth')) {
    addError('overlay.html is missing render frame health telemetry.');
  }
  if (!overlayHtml.includes('trimVisualEffects') || !overlayHtml.includes('pushAttackEffect')) {
    addError('overlay.html is missing bounded transient canvas effect controls.');
  }
  if (!overlayHtml.includes('currentBannerStatus')) {
    addError('overlay.html is missing banner backlog health status.');
  }
  if (!overlayHtml.includes('testEventStorm') || !overlayHtml.includes('runVisualEventStorm')) {
    addError('overlay.html is missing the deterministic visual event storm probe.');
  }
  const overlayVisualCoverageText = [
    readText('scripts/overlay_visual_audit.js'),
    readText('tests/e2e/visual-confidence.spec.js'),
  ].join('\n');
  if (!overlayVisualCoverageText.includes("emulateMedia({ reducedMotion: 'reduce' })")) {
    addError('Overlay visual audit no longer verifies reduced-motion rendering.');
  }
  if (!overlayVisualCoverageText.includes('testMotionImpact')) {
    addError('Overlay visual audit no longer verifies reduced-motion canvas effects.');
  }
  if (!overlayVisualCoverageText.includes('assertSponsorMediaAgent')) {
    addError('Overlay visual audit no longer verifies sponsor video-agent wiring.');
  }
  if (!overlayVisualCoverageText.includes('assertConnectionStatus')) {
    addError('Overlay visual audit no longer verifies overlay connection health.');
  }
  if (!overlayVisualCoverageText.includes('assertBackgroundStatus')) {
    addError('Overlay visual audit no longer verifies background asset health.');
  }
  if (!overlayVisualCoverageText.includes('auditBackgroundViewport')) {
    addError('Overlay visual audit no longer verifies background load/error/clear behavior.');
  }
  if (!readText('tests/e2e/v1-qa.spec.js').includes('connectionStatus')) {
    addError('V1 QA e2e no longer verifies signed overlay connection health.');
  }
  if (!overlayVisualCoverageText.includes('assertSponsorQueueHealth')) {
    addError('Overlay visual audit no longer verifies sponsor queue health.');
  }
  if (!overlayVisualCoverageText.includes('auditSponsorQueueViewport')) {
    addError('Overlay visual audit no longer verifies sponsor queue stress behavior.');
  }
  if (!overlayVisualCoverageText.includes('assertOverlayAudioStatus')) {
    addError('Overlay visual audit no longer verifies overlay audio preload/status.');
  }
  if (!overlayVisualCoverageText.includes('assertVisualQueueHealth')) {
    addError('Overlay visual audit no longer verifies visual event queue health.');
  }
  if (!overlayVisualCoverageText.includes('assertEffectOwnership') || !overlayVisualCoverageText.includes('auditEffectOwnershipViewport')) {
    addError('Overlay visual audit no longer verifies combat effect ownership.');
  }
  if (!overlayVisualCoverageText.includes('assertFrameHealth')) {
    addError('Overlay visual audit no longer verifies render frame health.');
  }
  if (!overlayVisualCoverageText.includes('assertBannerBacklog')) {
    addError('Overlay visual audit no longer verifies banner backlog health.');
  }
  if (!overlayVisualCoverageText.includes('auditEventStormViewport')) {
    addError('Overlay visual audit no longer verifies event-storm resilience.');
  }
}

runSyntaxCheck();
checkDependencies();
checkServerRiskSignals();
checkRequiredScripts();
checkImportantFiles();
checkOverlayModuleContracts();

console.log('\nIntoTheBattle stability audit');
console.log('================================');
for (const note of notes) console.log(`NOTE  ${note}`);
for (const warning of warnings) console.log(`WARN  ${warning}`);
for (const error of errors) console.log(`FAIL  ${error}`);

if (!warnings.length && !errors.length) console.log('PASS  No stability audit findings.');
else console.log(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s).`);

if (errors.length) process.exit(1);
