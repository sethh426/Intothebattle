import { spawnSync } from 'node:child_process';
import path from 'node:path';

const command = process.execPath;
const playwrightCli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
const passthroughArgs = process.argv.slice(2);
const result = spawnSync(command, [
  playwrightCli,
  'test',
  'tests/e2e/visual-confidence.spec.js',
  '--project=chromium-source-1080p',
  '--project=chromium-mobile',
  ...passthroughArgs,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PLAYWRIGHT_SNAPSHOT_ASSERT: process.env.PLAYWRIGHT_SNAPSHOT_ASSERT ?? '1',
  },
});

if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
