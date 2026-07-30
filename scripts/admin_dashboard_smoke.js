import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAdminOpsSummary } from '../tiktokbr/services/adminOpsSummary.js';

function stubDb(counts = {}) {
  return {
    prepare(sql) {
      return {
        get() {
          const key = Object.keys(counts).find(pattern => sql.includes(pattern));
          return { count: key ? counts[key] : 0 };
        },
      };
    },
  };
}

const summary = buildAdminOpsSummary({
  db: stubDb({
    'FROM users': 10,
    'FROM access_codes': 4,
    'FROM admin_email_deliveries': 2,
    'FROM marketing_posts': 1,
    'FROM blog_posts': 3,
  }),
  dbHealth: { mode: 'stub', initialized: true },
  userMetrics: { accounts: { free: 1, paid: 2, trialBeta: 0, beta: 0, total: 3 } },
  liveActivity: [
    { roomId: 'room-a', connected: false, playerCount: 2, overlayCount: 1, lastEventAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() },
  ],
  storageRisk: { ok: true, message: 'Storage looks writable', warnings: [] },
  writefreelyConfig: { ready: true },
  marketingDiagnostics: { enabled: true, dryRun: false, dueApprovedCount: 1 },
});

assert.equal(summary.health.status, 'ok');
assert.equal(summary.live.disconnectedWithPlayers, 1);
assert.ok(summary.alerts.some(alert => alert.title === 'Disconnected rooms still have players'));
assert.equal(summary.integrations.marketingDueApproved, 1);
assert.equal(summary.content.writefreelyReady, true);

const adminRoute = fs.readFileSync(new URL('../tiktokbr/routes/admin.js', import.meta.url), 'utf8');
assert.match(adminRoute, /router\.get\('\/ops-summary\.json', requireAdminAuth/);
assert.match(adminRoute, /router\.get\('\/access-codes\/export\.csv', requireAdminAuth/);
assert.match(adminRoute, /router\.get\('\/users\/export\.csv', requireAdminAuth/);
assert.match(adminRoute, /router\.get\('\/live-activity\/export\.csv', requireAdminAuth/);
assert.match(adminRoute, /Admin Command Center/);
assert.match(adminRoute, /data-admin-filter/);
assert.match(adminRoute, /renderOpsSummary\(opsSummaryData\)/);

console.log('Admin dashboard smoke checks passed');
