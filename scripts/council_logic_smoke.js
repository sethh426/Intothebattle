import assert from 'node:assert/strict';
import {
  buildCouncilPayoutCsv,
  createCouncilPayoutBatch,
  getCouncilMemberSummary,
  joinCouncilMember,
  markCouncilPayoutBatchPaid,
  updateCouncilPayoutProfile,
} from '../tiktokbr/services/councilMembers.js';

function createCouncilMemoryDb() {
  const state = {
    members: [],
    codes: [],
    attributions: [],
    subscriptions: [],
    recurringRewards: [],
    batches: [],
    items: [],
    audits: [],
  };
  const rowsForUser = userId => state.recurringRewards.filter(row => Number(row.referrer_user_id) === Number(userId));
  return {
    state,
    transaction(fn) {
      return (...args) => fn(...args);
    },
    prepare(sql) {
      if (/SELECT \* FROM council_members WHERE user_id/i.test(sql)) {
        return { get: userId => state.members.find(row => Number(row.user_id) === Number(userId)) || null };
      }
      if (/INSERT INTO council_members/i.test(sql)) {
        return {
          run(userId, source) {
            let row = state.members.find(item => Number(item.user_id) === Number(userId));
            if (!row) {
              row = {
                id: state.members.length + 1,
                user_id: userId,
                status: 'active',
                joined_source: source,
                paypal_payout_email: null,
                w9_status: 'needed',
                ftc_acknowledged_at: 'now',
                fine_print_acknowledged_at: 'now',
                elite: 0,
                payout_hold_reason: '',
                created_at: 'now',
                updated_at: 'now',
              };
              state.members.push(row);
            }
            return { rows: [row] };
          },
        };
      }
      if (/UPDATE council_members\s+SET paypal_payout_email/i.test(sql)) {
        return {
          run(email, userId) {
            const row = state.members.find(item => Number(item.user_id) === Number(userId));
            if (row) {
              row.paypal_payout_email = email;
              row.ftc_acknowledged_at ||= 'now';
              row.fine_print_acknowledged_at ||= 'now';
            }
            return { rows: [] };
          },
        };
      }
      if (/INSERT INTO council_audit_events/i.test(sql)) {
        return {
          run(action, targetUserId, actorAdminSessionId, details) {
            const row = { id: state.audits.length + 1, action, target_user_id: targetUserId, actor_admin_session_id: actorAdminSessionId, details };
            state.audits.push(row);
            return { rows: [{ id: row.id }] };
          },
        };
      }
      if (/SELECT \* FROM streamer_referral_codes WHERE user_id/i.test(sql)) {
        return { get: userId => state.codes.find(row => Number(row.user_id) === Number(userId)) || null };
      }
      if (/SELECT \* FROM streamer_referral_codes WHERE UPPER\(code\)/i.test(sql)) {
        return { get: (code, userId) => state.codes.find(row => row.code === String(code).toUpperCase() && Number(row.user_id) !== Number(userId)) || null };
      }
      if (/INSERT INTO streamer_referral_codes/i.test(sql)) {
        return {
          run(userId, code) {
            const row = { id: state.codes.length + 1, user_id: userId, code };
            state.codes.push(row);
            return { rows: [] };
          },
        };
      }
      if (/SELECT a\.referred_user_id\s+FROM referral_attributions/i.test(sql)) {
        return { all: () => [] };
      }
      if (/SELECT status, COUNT\(\*\) AS count\s+FROM referral_attributions/i.test(sql)) {
        return {
          all(userId) {
            const counts = new Map();
            state.attributions.filter(row => Number(row.referrer_user_id) === Number(userId)).forEach(row => {
              counts.set(row.status, (counts.get(row.status) || 0) + 1);
            });
            return [...counts].map(([status, count]) => ({ status, count }));
          },
        };
      }
      if (/SELECT COUNT\(DISTINCT a\.id\) AS count\s+FROM referral_attributions a/i.test(sql)) {
        return {
          get(userId) {
            const count = state.attributions.filter(row => Number(row.referrer_user_id) === Number(userId) && row.status === 'qualified').length;
            return { count };
          },
        };
      }
      if (/SELECT COALESCE\(SUM\(COALESCE\(a\.recurring_reward_cents/i.test(sql)) {
        return {
          get(_defaultAmount, userId) {
            const amount_cents = state.attributions
              .filter(row => Number(row.referrer_user_id) === Number(userId) && row.status === 'qualified')
              .reduce((sum, row) => sum + Number(row.recurring_reward_cents || 300), 0);
            return { amount_cents };
          },
        };
      }
      if (/FROM referral_recurring_rewards\s+WHERE referrer_user_id =/i.test(sql) && /GROUP BY status/i.test(sql)) {
        return {
          all(userId) {
            const groups = new Map();
            rowsForUser(userId).forEach(row => {
              const current = groups.get(row.status) || { status: row.status, count: 0, amount_cents: 0 };
              current.count += 1;
              current.amount_cents += Number(row.amount_cents || 0);
              groups.set(row.status, current);
            });
            return [...groups.values()];
          },
        };
      }
      if (/SELECT\s+COUNT\(\*\) AS total_clicks/i.test(sql)) {
        return { get: () => ({ total_clicks: 0, converted_clicks: 0, unique_clicks: 0 }) };
      }
      if (/FROM referral_attributions a\s+LEFT JOIN users referred/i.test(sql)) {
        return { all: () => [] };
      }
      if (/SELECT\s+rr\.id AS reward_id/i.test(sql)) {
        return {
          all(minimumCents) {
            const approvedByUser = new Map();
            state.recurringRewards.filter(row => row.status === 'approved' && !state.items.some(item => Number(item.reward_id) === Number(row.id))).forEach(row => {
              const member = state.members.find(item => Number(item.user_id) === Number(row.referrer_user_id));
              if (!member || member.status !== 'active' || !member.paypal_payout_email || !['received', 'not_required'].includes(member.w9_status) || member.payout_hold_reason) return;
              const list = approvedByUser.get(row.referrer_user_id) || [];
              list.push(row);
              approvedByUser.set(row.referrer_user_id, list);
            });
            return [...approvedByUser.values()].flatMap(list => {
              const total = list.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
              if (total < Number(minimumCents || 0)) return [];
              return list.map(row => ({
                reward_id: row.id,
                member_user_id: row.referrer_user_id,
                amount_cents: row.amount_cents,
                currency: row.currency || 'USD',
                period_start: row.period_start,
                period_end: row.period_end,
                paypal_payout_email: state.members.find(member => Number(member.user_id) === Number(row.referrer_user_id)).paypal_payout_email,
              }));
            });
          },
        };
      }
      if (/INSERT INTO council_payout_batches/i.test(sql)) {
        return {
          run(batchKey, periodStart, periodEnd, totalAmountCents, memberCount, itemCount, actor, notes) {
            const row = {
              id: state.batches.length + 1,
              batch_key: batchKey,
              period_start: periodStart,
              period_end: periodEnd,
              total_amount_cents: totalAmountCents,
              member_count: memberCount,
              item_count: itemCount,
              created_by_admin_session_id: actor,
              notes,
              status: 'created',
              created_at: 'now',
            };
            state.batches.push(row);
            return { rows: [row] };
          },
        };
      }
      if (/INSERT INTO council_payout_items/i.test(sql)) {
        return {
          run(batchId, memberUserId, rewardId, paypalEmail, amountCents, currency) {
            if (state.items.some(row => Number(row.reward_id) === Number(rewardId))) return { rows: [] };
            state.items.push({ id: state.items.length + 1, batch_id: batchId, member_user_id: memberUserId, reward_id: rewardId, paypal_payout_email: paypalEmail, amount_cents: amountCents, currency, status: 'included', batch_key: state.batches.find(row => Number(row.id) === Number(batchId))?.batch_key });
            return { rows: [] };
          },
        };
      }
      if (/SELECT \* FROM council_payout_batches WHERE id/i.test(sql)) {
        return { get: id => state.batches.find(row => Number(row.id) === Number(id)) || null };
      }
      if (/FROM council_payout_items cpi\s+JOIN council_payout_batches/i.test(sql)) {
        return { all: batchId => state.items.filter(row => Number(row.batch_id) === Number(batchId)).map(row => ({ ...row, batch_key: state.batches.find(batch => Number(batch.id) === Number(batchId))?.batch_key })) };
      }
      if (/UPDATE referral_recurring_rewards\s+SET status = 'paid'/i.test(sql)) {
        return {
          run(rewardId) {
            const row = state.recurringRewards.find(item => Number(item.id) === Number(rewardId));
            if (row) row.status = 'paid';
            return { rows: [] };
          },
        };
      }
      if (/UPDATE council_payout_items\s+SET status = 'paid'/i.test(sql)) {
        return {
          run(batchId) {
            state.items.filter(row => Number(row.batch_id) === Number(batchId)).forEach(row => { row.status = 'paid'; });
            return { rows: [] };
          },
        };
      }
      if (/UPDATE council_payout_batches\s+SET status = 'paid'/i.test(sql)) {
        return {
          run(batchId) {
            const row = state.batches.find(item => Number(item.id) === Number(batchId));
            if (row) row.status = 'paid';
            return { rows: [] };
          },
        };
      }
      throw new Error(`Unexpected Council SQL in smoke test: ${sql}`);
    },
  };
}

const db = createCouncilMemoryDb();
const user = { id: 501, email: 'ambassador@example.com', name: 'Council Member', tiktok_username: 'StormCaster' };

joinCouncilMember(db, user, { source: 'smoke', acknowledge: true });
assert.equal(db.state.members[0].status, 'active');
assert.equal(db.state.codes[0].code, 'STORMCASTER');

let summary = getCouncilMemberSummary(db, user, { settleRewards: false });
assert.equal(summary.member.isMember, true);
assert.equal(summary.payout.eligible, false);
assert.match(summary.payout.blockedReason, /PayPal payout email/);

updateCouncilPayoutProfile(db, user, { paypalPayoutEmail: 'payout@example.com' });
db.state.members[0].w9_status = 'received';

for (let i = 1; i <= 9; i += 1) {
  db.state.recurringRewards.push({
    id: i,
    referrer_user_id: user.id,
    status: 'approved',
    amount_cents: 300,
    currency: 'USD',
    period_start: '2026-07-01 00:00:00',
    period_end: '2026-07-31 23:59:59',
  });
}

summary = getCouncilMemberSummary(db, user, { settleRewards: false });
assert.equal(summary.payout.eligible, true);
assert.equal(summary.payout.approvedUnpaidCents, 2700);

const batchResult = createCouncilPayoutBatch(db, { actorAdminSessionId: 'admin-smoke', now: new Date('2026-07-31T00:00:00Z') });
assert.equal(batchResult.created, true);
assert.equal(batchResult.items.length, 9);
assert.equal(db.state.batches[0].total_amount_cents, 2700);

const csv = buildCouncilPayoutCsv(db.state.items);
assert.match(csv, /payout@example\.com/);
assert.match(csv, /27\.00/);
assert.equal(csv.trim().split('\n').length, 2);

const paid = markCouncilPayoutBatchPaid(db, db.state.batches[0].id, { actorAdminSessionId: 'admin-smoke' });
assert.equal(paid.itemCount, 9);
assert.equal(db.state.batches[0].status, 'paid');
assert.equal(db.state.recurringRewards.every(row => row.status === 'paid'), true);

console.log('Council logic smoke checks passed');
