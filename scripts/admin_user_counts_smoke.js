import assert from 'node:assert/strict';
import {
  ACTIVE_USER_COUNTS_SQL,
  getActiveUserCounts,
  injectActiveUserMetrics,
  normalizeActiveUserCounts,
} from '../tiktokbr/services/adminUserCounts.js';

assert.deepEqual(
  normalizeActiveUserCounts({ free_users: '12', paid_users: 4 }),
  { free: 12, paid: 4 }
);
assert.deepEqual(
  normalizeActiveUserCounts({ free_users: '-2', paid_users: 'not-a-number' }),
  { free: 0, paid: 0 }
);

let capturedSql = '';
const counts = getActiveUserCounts({
  prepare(sql) {
    capturedSql = sql;
    return { get: () => ({ free_users: '7', paid_users: '3' }) };
  },
});
assert.deepEqual(counts, { free: 7, paid: 3, available: true });
assert.equal(capturedSql, ACTIVE_USER_COUNTS_SQL);
assert.match(capturedSql, /LEFT JOIN LATERAL/);
assert.match(capturedSql, /latest_subscription\.status IS DISTINCT FROM 'active'/);
assert.match(capturedSql, /COALESCE\(u\.is_active, 1\) <> 0/);

const adminHtml = '<h1>Admin Panel</h1>\n    <div class="grid"><div>Existing admin controls</div></div>';
const rendered = injectActiveUserMetrics(adminHtml, { free: 1200, paid: 34, available: true });
assert.match(rendered, /aria-label="Active user counts"/);
assert.match(rendered, /Active free users/);
assert.match(rendered, />1,200</);
assert.match(rendered, /Active paid users/);
assert.match(rendered, />34</);
assert.ok(rendered.indexOf('Active user counts') < rendered.indexOf('class="grid"'));
assert.equal(injectActiveUserMetrics(rendered, counts), rendered, 'metrics should only be inserted once');
assert.equal(
  injectActiveUserMetrics('<h1>Admin Login</h1><div class="grid"></div>', counts),
  '<h1>Admin Login</h1><div class="grid"></div>'
);

const unavailableHtml = injectActiveUserMetrics(adminHtml, { free: 0, paid: 0, available: false });
assert.match(unavailableHtml, /&mdash;/);
assert.match(unavailableHtml, /temporarily unavailable/);

let logged = '';
const unavailable = getActiveUserCounts(
  { prepare() { throw new Error('db unavailable'); } },
  { error(_message, detail) { logged = detail; } }
);
assert.deepEqual(unavailable, { free: 0, paid: 0, available: false });
assert.equal(logged, 'db unavailable');

console.log('Admin user count smoke checks passed');
