#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const RUN_LIST_FIELDS = [
  'conclusion',
  'createdAt',
  'databaseId',
  'displayTitle',
  'event',
  'headBranch',
  'headSha',
  'name',
  'status',
  'updatedAt',
  'url',
  'workflowName',
];

const RUN_VIEW_FIELDS = [
  'conclusion',
  'createdAt',
  'databaseId',
  'displayTitle',
  'event',
  'headBranch',
  'headSha',
  'jobs',
  'name',
  'number',
  'startedAt',
  'status',
  'updatedAt',
  'url',
  'workflowName',
];

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILURE_PATTERNS = [
  /::error/i,
  /\b(error|failed|failure|fatal)\b/i,
  /assertion/i,
  /traceback/i,
  /process completed with exit code/i,
  /exited with/i,
];

class TriageError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'TriageError';
    this.details = details;
  }
}

function parseArgs(argv) {
  const options = {
    limit: 10,
    branch: '',
    run: '',
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--limit') {
      options.limit = Number(argv[++i]);
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--branch') {
      options.branch = String(argv[++i] || '');
    } else if (arg.startsWith('--branch=')) {
      options.branch = arg.slice('--branch='.length);
    } else if (arg === '--run') {
      options.run = String(argv[++i] || '');
    } else if (arg.startsWith('--run=')) {
      options.run = arg.slice('--run='.length);
    } else {
      throw new TriageError(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new TriageError('--limit must be an integer from 1 to 100.');
  }
  return options;
}

function usage() {
  return [
    'Usage: npm run ci:triage -- [--branch main] [--limit 10] [--run <run-id-or-url>] [--json]',
    '',
    'Read-only GitHub Actions triage. Reports recent runs, failed jobs, failed steps,',
    'run URLs, and compact failed-log snippets. It never reruns jobs.',
    '',
    'Examples:',
    '  npm run ci:triage -- --branch main --limit 10',
    '  npm run ci:triage -- --run 123456789 --json',
  ].join('\n');
}

function ghCandidates() {
  const candidates = [];
  if (process.env.GH_BIN) candidates.push(process.env.GH_BIN);
  candidates.push('gh');
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\GitHub CLI\\gh.exe');
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'));
    candidates.push(path.join(os.homedir(), 'scoop', 'apps', 'gh', 'current', 'bin', 'gh.exe'));
  }
  return candidates.filter(Boolean);
}

function canRun(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function resolveGh() {
  for (const candidate of ghCandidates()) {
    if (candidate !== 'gh' && !fs.existsSync(candidate)) continue;
    if (canRun(candidate)) return candidate;
  }
  throw new TriageError(
    'GitHub CLI was not found.',
    'Install it with `winget install --id GitHub.cli -e` or set GH_BIN to gh.exe.'
  );
}

function runGh(gh, args, { allowFailure = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync(gh, args, {
    encoding: 'utf8',
    maxBuffer,
    windowsHide: true,
  });

  if (result.error) {
    if (allowFailure) return { ok: false, stdout: '', stderr: result.error.message };
    throw new TriageError(`gh ${args.join(' ')} failed to start.`, result.error.message);
  }

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    if (allowFailure) return { ok: false, stdout: result.stdout || '', stderr: detail };
    throw new TriageError(`gh ${args.join(' ')} failed.`, detail);
  }

  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function ghJson(gh, args) {
  const result = runGh(gh, args);
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (err) {
    throw new TriageError(`gh ${args.join(' ')} returned invalid JSON.`, err.message);
  }
}

function parseRunId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const urlMatch = text.match(/\/actions\/runs\/(\d+)/i);
  if (urlMatch) return urlMatch[1];
  const digitMatch = text.match(/^\d+$/);
  if (digitMatch) return text;
  throw new TriageError('--run must be a GitHub Actions run id or run URL.');
}

function shortSha(value) {
  return String(value || '').slice(0, 7);
}

function conclusionLabel(item) {
  return item.conclusion || item.status || 'unknown';
}

function isProblemConclusion(value) {
  const text = String(value || '').toLowerCase();
  return text && !OK_CONCLUSIONS.has(text);
}

function shouldInspectRun(run) {
  if (run.status && run.status !== 'completed') return true;
  return isProblemConclusion(run.conclusion);
}

function failedSteps(job) {
  return (job.steps || []).filter(step => {
    if (step.status && step.status !== 'completed') return true;
    return isProblemConclusion(step.conclusion);
  }).map(step => ({
    name: step.name,
    number: step.number,
    status: step.status || '',
    conclusion: step.conclusion || '',
    startedAt: step.startedAt || '',
    completedAt: step.completedAt || '',
  }));
}

function failedJobs(run) {
  return (run.jobs || []).filter(job => {
    if (job.status && job.status !== 'completed') return true;
    return isProblemConclusion(job.conclusion);
  }).map(job => ({
    databaseId: job.databaseId,
    name: job.name,
    status: job.status || '',
    conclusion: job.conclusion || '',
    url: job.url || '',
    steps: failedSteps(job),
  }));
}

function extractLogSnippet(text, maxLines = 70) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.trim());
  if (!lines.length) return [];

  let firstFailure = lines.findIndex(line => FAILURE_PATTERNS.some(pattern => pattern.test(line)));
  if (firstFailure < 0) firstFailure = Math.max(0, lines.length - maxLines);
  const start = Math.max(0, firstFailure - 12);
  const end = Math.min(lines.length, start + maxLines);
  return lines.slice(start, end).map(line => line.slice(0, 1200));
}

function inspectRun(gh, runId) {
  const run = ghJson(gh, ['run', 'view', String(runId), '--json', RUN_VIEW_FIELDS.join(',')]);
  const problemJobs = failedJobs(run);
  let logSnippet = [];
  let logError = '';

  if (shouldInspectRun(run) || problemJobs.length) {
    const logResult = runGh(gh, ['run', 'view', String(run.databaseId || runId), '--log-failed'], {
      allowFailure: true,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (logResult.ok) logSnippet = extractLogSnippet(logResult.stdout);
    else logError = logResult.stderr || 'Failed logs were unavailable.';
  }

  return {
    databaseId: run.databaseId,
    number: run.number,
    name: run.name,
    workflowName: run.workflowName,
    displayTitle: run.displayTitle,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    headSha: run.headSha,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    url: run.url,
    failedJobs: problemJobs,
    logSnippet,
    logError,
  };
}

function listRuns(gh, options) {
  const args = ['run', 'list', '--limit', String(options.limit)];
  if (options.branch) args.push('--branch', options.branch);
  args.push('--json', RUN_LIST_FIELDS.join(','));
  return ghJson(gh, args);
}

function repoInfo(gh) {
  return ghJson(gh, ['repo', 'view', '--json', 'nameWithOwner,url']);
}

function buildReport(options) {
  const gh = resolveGh();
  runGh(gh, ['auth', 'status']);
  const repo = repoInfo(gh);

  const runId = parseRunId(options.run);
  const runs = runId ? [] : listRuns(gh, options);
  const inspectedRuns = runId
    ? [inspectRun(gh, runId)]
    : runs.filter(shouldInspectRun).map(run => inspectRun(gh, run.databaseId));

  return {
    generatedAt: new Date().toISOString(),
    repository: repo,
    options: {
      branch: options.branch || null,
      limit: options.limit,
      run: runId || null,
    },
    runs,
    inspectedRuns,
    hasProblems: inspectedRuns.some(run => shouldInspectRun(run) || run.failedJobs.length),
  };
}

function printHuman(report) {
  console.log(`GitHub Actions triage for ${report.repository.nameWithOwner}`);
  console.log(report.repository.url);
  if (report.options.run) console.log(`Run: ${report.options.run}`);
  else console.log(`Recent runs: ${report.options.limit}${report.options.branch ? ` on ${report.options.branch}` : ''}`);
  console.log('');

  if (report.runs.length) {
    for (const run of report.runs) {
      const label = conclusionLabel(run).padEnd(12);
      const sha = shortSha(run.headSha);
      console.log(`${label} #${run.databaseId} ${run.workflowName || run.name} [${run.event}] ${run.headBranch || ''} ${sha}`);
      console.log(`  ${run.displayTitle || run.name}`);
      console.log(`  ${run.url}`);
    }
    console.log('');
  }

  if (!report.inspectedRuns.length) {
    console.log('No failed, cancelled, or in-progress runs found in this selection.');
    return;
  }

  console.log('Inspected problem runs');
  for (const run of report.inspectedRuns) {
    console.log('');
    console.log(`${conclusionLabel(run).toUpperCase()} #${run.databaseId} ${run.workflowName || run.name}`);
    console.log(`  ${run.displayTitle || run.name}`);
    console.log(`  ${run.url}`);
    if (!run.failedJobs.length) {
      console.log('  No failed job summaries were available.');
    }
    for (const job of run.failedJobs) {
      console.log(`  Job: ${job.name} (${conclusionLabel(job)})`);
      if (job.url) console.log(`    ${job.url}`);
      for (const step of job.steps) {
        console.log(`    Step: ${step.name} (${conclusionLabel(step)})`);
      }
    }
    if (run.logSnippet.length) {
      console.log('  Log snippet:');
      for (const line of run.logSnippet) console.log(`    ${line}`);
    } else if (run.logError) {
      console.log(`  Log snippet unavailable: ${run.logError}`);
    }
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const report = buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
} catch (err) {
  const message = err instanceof TriageError ? err.message : 'GitHub Actions triage failed.';
  console.error(message);
  if (err?.details) console.error(err.details);
  else if (!(err instanceof TriageError)) console.error(err?.stack || err);
  console.error('');
  console.error(usage());
  process.exitCode = 1;
}
