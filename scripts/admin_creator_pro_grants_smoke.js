import assert from 'node:assert/strict';
import {
  CREATOR_PRO_PLAN_TYPE,
  findUserForCreatorProGrant,
  grantPermanentCreatorPro,
  publicSubscriptionView,
  removePermanentCreatorPro,
  selectEffectiveSubscription,
} from '../tiktokbr/services/userSubscriptions.js';

const now = '2026-07-04T12:00:00.000Z';

class FakeGrantDb {
  constructor({ users = [], subscriptions = [] } = {}) {
    this.users = users.map(user => ({ ...user }));
    this.subscriptions = subscriptions.map(subscription => ({ ...subscription }));
    this.nextSubscriptionId = Math.max(0, ...this.subscriptions.map(subscription => Number(subscription.id) || 0)) + 1;
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      get: (...args) => this.get(normalized, args),
      all: (...args) => this.all(normalized, args),
      run: (...args) => this.run(normalized, args),
    };
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  get(sql, args) {
    if (sql.includes('FROM users WHERE id = ?')) {
      const id = Number(args[0]);
      return this.users.find(user => Number(user.id) === id) || null;
    }
    if (sql.includes('FROM users WHERE LOWER(email) = ?')) {
      const email = String(args[0] || '').toLowerCase();
      return this.users.find(user => String(user.email || '').toLowerCase() === email) || null;
    }
    if (sql.includes('FROM subscriptions') && sql.includes('WHERE user_id = ? AND COALESCE(admin_granted, 0) <> 0')) {
      const userId = Number(args[0]);
      return selectEffectiveSubscription(
        this.subscriptions.filter(subscription => (
          Number(subscription.user_id) === userId &&
          Number(subscription.admin_granted) !== 0
        ))
      );
    }
    if (sql.includes('FROM subscriptions') && sql.includes('WHERE user_id = ?')) {
      const userId = Number(args[0]);
      return selectEffectiveSubscription(
        this.subscriptions.filter(subscription => Number(subscription.user_id) === userId)
      );
    }
    throw new Error(`Unhandled fake get SQL: ${sql}`);
  }

  all(sql, args) {
    if (sql.includes('paypal_subscription_id IS NOT NULL')) {
      const userId = Number(args[0]);
      return this.subscriptions
        .filter(subscription => (
          Number(subscription.user_id) === userId &&
          subscription.paypal_subscription_id &&
          Number(subscription.admin_granted) === 0 &&
          String(subscription.status || '').toLowerCase() === 'active'
        ))
        .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    }
    throw new Error(`Unhandled fake all SQL: ${sql}`);
  }

  run(sql, args) {
    if (sql.startsWith("UPDATE subscriptions SET status = 'cancelled'") && sql.includes('WHERE id = ?')) {
      const id = Number(args[0]);
      const row = this.subscriptions.find(subscription => Number(subscription.id) === id);
      if (row) {
        row.status = 'cancelled';
        row.updated_at = now;
      }
      return { changes: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE subscriptions SET plan_type = ?')) {
      const [planType, id] = args;
      const row = this.subscriptions.find(subscription => Number(subscription.id) === Number(id));
      if (row) {
        row.plan_type = planType;
        row.status = 'active';
        row.paypal_subscription_id = null;
        row.started_at = row.started_at || now;
        row.next_billing_date = null;
        row.expires_at = null;
        row.admin_granted = 1;
        row.updated_at = now;
      }
      return { changes: row ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO subscriptions')) {
      const [userId, planType] = args;
      this.subscriptions.push({
        id: this.nextSubscriptionId++,
        user_id: Number(userId),
        paypal_subscription_id: null,
        plan_type: planType,
        status: 'active',
        started_at: now,
        next_billing_date: null,
        expires_at: null,
        admin_granted: 1,
        created_at: now,
        updated_at: now,
      });
      return { changes: 1 };
    }
    if (sql.startsWith("UPDATE subscriptions SET status = 'cancelled'") && sql.includes('WHERE user_id = ?')) {
      const userId = Number(args[0]);
      let changes = 0;
      this.subscriptions.forEach(subscription => {
        if (
          Number(subscription.user_id) === userId &&
          Number(subscription.admin_granted) !== 0 &&
          String(subscription.status || '').toLowerCase() === 'active'
        ) {
          subscription.status = 'cancelled';
          subscription.updated_at = now;
          changes += 1;
        }
      });
      return { changes };
    }
    throw new Error(`Unhandled fake run SQL: ${sql}`);
  }
}

function activeGrant(db, userId) {
  return db.subscriptions.find(subscription => (
    Number(subscription.user_id) === Number(userId) &&
    Number(subscription.admin_granted) === 1 &&
    String(subscription.status || '').toLowerCase() === 'active'
  ));
}

async function testFreeUserGrant() {
  const db = new FakeGrantDb({ users: [{ id: 1, email: 'free@example.com', is_active: 1 }] });
  const result = await grantPermanentCreatorPro(db, db.users[0]);
  assert.equal(result.cancelledPayPalSubscriptions.length, 0);
  assert.equal(result.subscription.plan_type, CREATOR_PRO_PLAN_TYPE);
  assert.equal(activeGrant(db, 1)?.status, 'active');
  assert.equal(publicSubscriptionView(result.subscription).admin_granted, undefined);
}

async function testTrialUserGrant() {
  const db = new FakeGrantDb({
    users: [{ id: 2, email: 'trial@example.com', is_active: 1 }],
    subscriptions: [{
      id: 10,
      user_id: 2,
      plan_type: '7-Day Full Access',
      status: 'trialing',
      expires_at: '2099-01-01T00:00:00.000Z',
      admin_granted: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
  });
  const result = await grantPermanentCreatorPro(db, db.users[0]);
  assert.equal(result.subscription.status, 'active');
  assert.equal(result.subscription.admin_granted, 1);
}

async function testPayPalCancelThenGrant() {
  const db = new FakeGrantDb({
    users: [{ id: 3, email: 'paid@example.com', is_active: 1 }],
    subscriptions: [{
      id: 20,
      user_id: 3,
      paypal_subscription_id: 'I-ACTIVE',
      plan_type: CREATOR_PRO_PLAN_TYPE,
      status: 'active',
      admin_granted: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
  });
  const cancelled = [];
  const result = await grantPermanentCreatorPro(db, db.users[0], {
    cancelPayPalSubscription: async id => {
      cancelled.push(id);
      return { success: true };
    },
  });
  assert.deepEqual(cancelled, ['I-ACTIVE']);
  assert.deepEqual(result.cancelledPayPalSubscriptions, ['I-ACTIVE']);
  assert.equal(db.subscriptions.find(subscription => subscription.id === 20).status, 'cancelled');
  assert.equal(activeGrant(db, 3)?.plan_type, CREATOR_PRO_PLAN_TYPE);
}

async function testPayPalCancelFailureBlocksGrant() {
  const db = new FakeGrantDb({
    users: [{ id: 4, email: 'fail@example.com', is_active: 1 }],
    subscriptions: [{
      id: 30,
      user_id: 4,
      paypal_subscription_id: 'I-FAIL',
      plan_type: CREATOR_PRO_PLAN_TYPE,
      status: 'active',
      admin_granted: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
  });
  await assert.rejects(
    () => grantPermanentCreatorPro(db, db.users[0], {
      cancelPayPalSubscription: async () => {
        throw new Error('PayPal unavailable');
      },
    }),
    /PayPal unavailable/
  );
  assert.equal(activeGrant(db, 4), undefined);
  assert.equal(db.subscriptions.find(subscription => subscription.id === 30).status, 'active');
}

async function testAdminGrantBeatsLateWebhook() {
  const db = new FakeGrantDb({
    users: [{ id: 5, email: 'late@example.com', is_active: 1 }],
    subscriptions: [{
      id: 40,
      user_id: 5,
      paypal_subscription_id: 'I-LATE',
      plan_type: CREATOR_PRO_PLAN_TYPE,
      status: 'active',
      admin_granted: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }],
  });
  await grantPermanentCreatorPro(db, db.users[0], {
    cancelPayPalSubscription: async () => ({ success: true }),
  });
  const paypalRow = db.subscriptions.find(subscription => subscription.paypal_subscription_id === 'I-LATE');
  paypalRow.status = 'cancelled';
  paypalRow.updated_at = '2099-01-01T00:00:00.000Z';
  const effective = selectEffectiveSubscription(db.subscriptions.filter(subscription => subscription.user_id === 5));
  assert.equal(effective.admin_granted, 1, 'active admin grant should remain effective after later PayPal webhook metadata');
}

async function testRemoveGrantFallsBackToOtherActivePaidRow() {
  const db = new FakeGrantDb({
    users: [{ id: 6, email: 'remove@example.com', is_active: 1 }],
    subscriptions: [
      {
        id: 50,
        user_id: 6,
        plan_type: CREATOR_PRO_PLAN_TYPE,
        status: 'active',
        admin_granted: 0,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 51,
        user_id: 6,
        plan_type: CREATOR_PRO_PLAN_TYPE,
        status: 'active',
        admin_granted: 1,
        created_at: '2026-07-02T00:00:00.000Z',
        updated_at: '2026-07-02T00:00:00.000Z',
      },
    ],
  });
  const result = removePermanentCreatorPro(db, db.users[0]);
  assert.equal(activeGrant(db, 6), undefined);
  assert.equal(result.subscription.id, 50);
  assert.equal(result.subscription.status, 'active');
}

function testGrantLookup() {
  const db = new FakeGrantDb({ users: [{ id: 7, email: 'lookup@example.com', is_active: 1 }] });
  assert.equal(findUserForCreatorProGrant(db, '7')?.email, 'lookup@example.com');
  assert.equal(findUserForCreatorProGrant(db, 'LOOKUP@example.com')?.id, 7);
  assert.equal(findUserForCreatorProGrant(db, 'not an email'), null);
}

await testFreeUserGrant();
await testTrialUserGrant();
await testPayPalCancelThenGrant();
await testPayPalCancelFailureBlocksGrant();
await testAdminGrantBeatsLateWebhook();
await testRemoveGrantFallsBackToOtherActivePaidRow();
testGrantLookup();

console.log('Admin Creator Pro grant smoke checks passed');
