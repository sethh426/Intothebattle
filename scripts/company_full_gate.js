import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const skipE2e = process.argv.includes('--skip-e2e');
const host = '127.0.0.1';
const requiredPorts = [
  Number(process.env.SMOKE_PORT || 3517),
  Number(process.env.SOCKET_SMOKE_PORT || 3527),
  Number(process.env.QA_E2E_PORT || 3537),
  Number(process.env.FULL_GATE_E2E_PORT || 3547),
  Number(process.env.E2E_PORT || 3527),
  Number(process.env.VISUAL_GATE_E2E_PORT || 3567),
  Number(process.env.MEDIA_GATE_E2E_PORT || 3577),
  3557,
].filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);

function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function assertPortsFree() {
  const occupied = [];
  for (const port of requiredPorts) {
    if (!(await portIsFree(port))) occupied.push(port);
  }
  if (occupied.length) {
    throw new Error(`Clean gate blocked: local test port(s) already in use: ${occupied.join(', ')}. Stop stale local servers before running the company gate.`);
  }
}

function resolveCommand(command, args) {
  if (process.platform !== 'win32' || command !== 'npm') {
    return { executable: command, args };
  }

  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCliPath = candidates.find(candidate => fs.existsSync(candidate) && !candidate.toLowerCase().endsWith('.cmd'));
  if (!npmCliPath) {
    throw new Error('Unable to locate npm-cli.js for the company gate runner.');
  }
  return { executable: process.execPath, args: [npmCliPath, ...args] };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(command, args);
    const child = spawn(resolved.executable, resolved.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
    child.once('error', reject);
  });
}

const commands = [
  ['npm', ['run', 'validate:schemas']],
  ['npm', ['run', 'audit:stability']],
  ['npm', ['run', 'test:security:contracts']],
  ['npm', ['run', 'test:logic']],
  ['npm', ['run', 'test:marketing']],
  ['npm', ['run', 'test:http']],
  ['npm', ['run', 'test:socket']],
  ['npm', ['run', 'test:qa:contracts']],
];

if (!skipE2e) {
  commands.push(['npm', ['run', 'test:e2e:full']]);
}

try {
  await assertPortsFree();
  for (const [command, args] of commands) {
    await run(command, args);
  }
  console.log(skipE2e ? 'Company fast gate passed' : 'Company full gate passed');
} catch (err) {
  console.error(err?.stack || err);
  process.exitCode = 1;
}
