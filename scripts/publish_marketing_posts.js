import { marketingAutomationDiagnostics, publishApprovedMarketingPosts } from '../tiktokbr/services/marketingAutomation.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const live = process.argv.includes('--live');
const limit = Math.max(1, Math.min(50, Number(argValue('limit')) || 10));

try {
  const result = await publishApprovedMarketingPosts({ limit, dryRun: !live });
  console.log(JSON.stringify({
    ok: true,
    diagnostics: marketingAutomationDiagnostics(),
    ...result,
  }, null, 2));
  if (result.failed > 0 && live) process.exit(1);
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exit(1);
}
