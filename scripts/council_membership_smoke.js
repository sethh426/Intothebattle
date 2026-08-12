import assert from 'node:assert/strict';
import {
  appointCouncilMember,
  getCouncilMembershipStatus,
  removeCouncilMember,
} from '../tiktokbr/services/councilMemberships.js';

function createMemoryDb() {
  const state = {
    users: [{ id: 1, email: 'creator@example.com', is_active: 1, banned_at: null }],
    memberships: [],
    codes: [{ user_id: 1, code: 'CREATOR', is_active: 0 }],
  };
  return {
    state,
    transaction(callback) { return callback; },
    prepare(sql) {
      if (/SELECT \* FROM users WHERE id/i.test(sql)) {
        return { get: id => state.users.find(row => Number(row.id) === Number(id)) || null };
      }
      if (/FROM council_memberships cm[\s\S]*JOIN users u/i.test(sql)) {
        return { get: id => {
          const user = state.users.find(row => Number(row.id) === Number(id) && row.is_active && !row.banned_at);
          return user ? [...state.memberships].reverse().find(row => Number(row.user_id) === Number(id) && row.status === 'active') || null : null;
        } };
      }
      if (/FROM council_memberships cm[\s\S]*WHERE cm\.user_id/i.test(sql)) {
        return { get: id => [...state.memberships].reverse().find(row => Number(row.user_id) === Number(id)) || null };
      }
      if (/INSERT INTO council_memberships/i.test(sql)) {
        return { run(userId, appointedBy, note) {
          const row = { id: state.memberships.length + 1, user_id: userId, status: 'active', appointed_by: appointedBy, appointment_note: note, appointed_at: `appointment-${state.memberships.length + 1}` };
          state.memberships.push(row);
          return { rows: [row] };
        } };
      }
      if (/UPDATE council_memberships/i.test(sql)) {
        return { run(removedBy, reason, id) {
          const row = state.memberships.find(item => Number(item.id) === Number(id));
          row.status = 'removed';
          row.removed_by = removedBy;
          row.removal_reason = reason;
          row.removed_at = 'removed-now';
          return { rows: [] };
        } };
      }
      if (/UPDATE streamer_referral_codes[\s\S]*SET is_active = 1/i.test(sql)) {
        return { run(userId) {
          const row = state.codes.find(item => Number(item.user_id) === Number(userId));
          if (row) row.is_active = 1;
          return { rows: [] };
        } };
      }
      if (/UPDATE streamer_referral_codes[\s\S]*SET is_active = 0/i.test(sql)) {
        return { run(reason, userId) {
          const row = state.codes.find(item => Number(item.user_id) === Number(userId));
          if (row) { row.is_active = 0; row.disabled_reason = reason; }
          return { rows: [] };
        } };
      }
      throw new Error(`Unexpected Council SQL: ${sql}`);
    },
  };
}

const db = createMemoryDb();
assert.deepEqual(getCouncilMembershipStatus(db, 1), { status: 'regular', eligible: false, appointedAt: null, removedAt: null });

const appointed = appointCouncilMember(db, 1, { note: 'Founding creator' });
assert.equal(appointed.created, true);
assert.equal(db.state.codes[0].is_active, 1);
assert.equal(getCouncilMembershipStatus(db, 1).eligible, true);

const duplicate = appointCouncilMember(db, 1);
assert.equal(duplicate.created, false);
assert.equal(db.state.memberships.length, 1);

assert.throws(() => removeCouncilMember(db, 1), /removal reason/i);
const removed = removeCouncilMember(db, 1, { reason: 'Program review' });
assert.equal(removed.removed, true);
assert.equal(db.state.codes[0].is_active, 0);
assert.equal(getCouncilMembershipStatus(db, 1).status, 'regular');

const reappointed = appointCouncilMember(db, 1, { note: 'Review complete' });
assert.equal(reappointed.created, true);
assert.equal(db.state.memberships.length, 2);
assert.equal(db.state.codes[0].is_active, 1);

db.state.users[0].is_active = 0;
assert.equal(getCouncilMembershipStatus(db, 1).eligible, false);
assert.throws(() => appointCouncilMember(db, 1), /active, non-banned/i);

console.log('Council membership smoke checks passed');
