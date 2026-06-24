import { ensureMarketingPostsForDate, marketingAutomationDiagnostics } from '../tiktokbr/services/marketingAutomation.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const date = argValue('date') || new Date();
const force = process.argv.includes('--force');

try {
  const result = ensureMarketingPostsForDate({ date, force });
  console.log(JSON.stringify({
    ok: true,
    diagnostics: marketingAutomationDiagnostics(),
    ...result,
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exit(1);
}
