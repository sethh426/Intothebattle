import { ADMIN_GRANTED_SUBSCRIPTION_ORDER_SQL } from './userSubscriptions.js';

export const ACTIVE_USER_COUNTS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE latest_subscription.status IS DISTINCT FROM 'active') AS free_users,
    COUNT(*) FILTER (WHERE latest_subscription.status = 'active') AS paid_users
  FROM users u
  LEFT JOIN LATERAL (
    SELECT LOWER(TRIM(status)) AS status
    FROM subscriptions
    WHERE subscriptions.user_id = u.id
    ORDER BY ${ADMIN_GRANTED_SUBSCRIPTION_ORDER_SQL}
    LIMIT 1
  ) latest_subscription ON TRUE
  WHERE COALESCE(u.is_active, 1) <> 0
`;

const ADMIN_PAGE_MARKER = '<h1>Admin Panel</h1>';
const ADMIN_GRID_MARKER = '    <div class="grid">';
const USER_METRICS_MARKER = 'aria-label="Active user counts"';

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function metricValue(value, available) {
  return available ? normalizeCount(value).toLocaleString('en-US') : '&mdash;';
}

export function normalizeActiveUserCounts(row = {}) {
  return {
    free: normalizeCount(row.free_users),
    paid: normalizeCount(row.paid_users),
  };
}

export function renderActiveUserMetrics(counts = {}) {
  const available = counts.available !== false;
  const freeUsers = metricValue(counts.free, available);
  const paidUsers = metricValue(counts.paid, available);
  const note = available
    ? 'Free includes trials and active accounts without a current paid subscription.'
    : 'User counts are temporarily unavailable.';

  return `    <section aria-label="Active user counts" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">
      <div style="min-width:0;padding:20px;border-radius:24px;border:1px solid rgba(85,231,255,.28);background:linear-gradient(180deg,rgba(85,231,255,.09),rgba(255,255,255,.025));box-shadow:0 20px 60px rgba(0,0,0,.24);">
        <span style="display:block;color:#a8afbf;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;">Active free users</span>
        <strong style="display:block;margin-top:8px;color:#fff8e6;font-size:clamp(36px,6vw,58px);line-height:1;">${freeUsers}</strong>
      </div>
      <div style="min-width:0;padding:20px;border-radius:24px;border:1px solid rgba(119,240,161,.3);background:linear-gradient(180deg,rgba(119,240,161,.1),rgba(255,255,255,.025));box-shadow:0 20px 60px rgba(0,0,0,.24);">
        <span style="display:block;color:#a8afbf;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;">Active paid users</span>
        <strong style="display:block;margin-top:8px;color:#fff8e6;font-size:clamp(36px,6vw,58px);line-height:1;">${paidUsers}</strong>
      </div>
    </section>
    <p style="margin:-8px 2px 0;color:#a8afbf;font-size:12px;line-height:1.5;">${note}</p>`;
}

export function injectActiveUserMetrics(html, counts) {
  if (typeof html !== 'string') return html;
  if (!html.includes(ADMIN_PAGE_MARKER) || html.includes(USER_METRICS_MARKER)) return html;
  if (!html.includes(ADMIN_GRID_MARKER)) return html;
  return html.replace(ADMIN_GRID_MARKER, `${renderActiveUserMetrics(counts)}\n${ADMIN_GRID_MARKER}`);
}

export function getActiveUserCounts(database, logger = console) {
  try {
    const row = database.prepare(ACTIVE_USER_COUNTS_SQL).get() || {};
    return { ...normalizeActiveUserCounts(row), available: true };
  } catch (error) {
    logger?.error?.('Failed to load admin user counts:', error?.message || error);
    return { free: 0, paid: 0, available: false };
  }
}
