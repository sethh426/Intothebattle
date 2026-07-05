const FAR_FUTURE = '2099-12-31 23:59:59';

function sqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function userFixture({ id, token, roomId, email, createdAt, subscription = null }) {
  return {
    type: 'user',
    record: {
      id,
      email,
      name: 'E2E Creator',
      tiktok_username: 'e2e_creator',
      room_id: roomId,
      session_token: token,
      is_active: 1,
      email_verified: 1,
      dashboard_rules_acknowledged_at: sqlTimestamp(new Date()),
      created_at: createdAt,
      updated_at: createdAt,
      last_login: createdAt,
    },
    subscription,
  };
}

function getE2EUserFixtures() {
  const now = Date.now();
  const activeTrialToken = process.env.E2E_ACTIVE_TRIAL_SESSION_TOKEN;
  const expiredTrialToken = process.env.E2E_EXPIRED_TRIAL_SESSION_TOKEN;
  const paidUserToken = process.env.E2E_PAID_USER_SESSION_TOKEN;

  return [
    activeTrialToken && userFixture({
      id: 10001,
      token: activeTrialToken,
      roomId: process.env.E2E_ACTIVE_TRIAL_ROOM_ID || 'e2e-active-trial-room',
      email: 'e2e-active-trial@example.com',
      createdAt: sqlTimestamp(new Date(now - (6 * 24 + 23) * 60 * 60 * 1000)),
      subscription: null,
    }),
    expiredTrialToken && userFixture({
      id: 10002,
      token: expiredTrialToken,
      roomId: process.env.E2E_EXPIRED_TRIAL_ROOM_ID || 'e2e-expired-trial-room',
      email: 'e2e-expired-trial@example.com',
      createdAt: sqlTimestamp(new Date(now - (8 * 24) * 60 * 60 * 1000)),
      subscription: {
        id: 20002,
        user_id: 10002,
        plan_type: '7-Day Full Access',
        status: 'trialing',
        started_at: sqlTimestamp(new Date(now - (8 * 24) * 60 * 60 * 1000)),
        expires_at: sqlTimestamp(new Date(now + 24 * 60 * 60 * 1000)),
        updated_at: sqlTimestamp(new Date()),
      },
    }),
    paidUserToken && userFixture({
      id: 10003,
      token: paidUserToken,
      roomId: process.env.E2E_PAID_USER_ROOM_ID || 'e2e-paid-user-room',
      email: 'e2e-paid-user@example.com',
      createdAt: sqlTimestamp(new Date(now - (30 * 24) * 60 * 60 * 1000)),
      subscription: {
        id: 20003,
        user_id: 10003,
        paypal_subscription_id: 'I-E2EPAID',
        plan_type: 'Creator Pro',
        status: 'active',
        started_at: sqlTimestamp(new Date(now - (20 * 24) * 60 * 60 * 1000)),
        next_billing_date: sqlTimestamp(new Date(now + (10 * 24) * 60 * 60 * 1000)),
        expires_at: null,
        updated_at: sqlTimestamp(new Date()),
      },
    }),
  ].filter(Boolean);
}

export function getE2EAuthRecord(token) {
  if (process.env.NODE_ENV === 'production') return null;
  const userFixture = getE2EUserAuthRecord(token);
  if (userFixture) return userFixture;
  if (!process.env.E2E_SESSION_TOKEN || token !== process.env.E2E_SESSION_TOKEN) return null;

  const roomId = process.env.E2E_ROOM_ID || 'e2e-room';
  return {
    type: 'code',
    record: {
      id: 0,
      code: 'E2E_TEST_CODE',
      email: 'e2e@example.com',
      owner_name: 'E2E User',
      room_id: roomId,
      is_revoked: 0,
      expires_at: FAR_FUTURE,
      fingerprint: null,
      session_token: token,
      trial_started: '2026-01-01 00:00:00',
      trial_days: 36500,
      subscription_status: 'active',
      code_type: 'paid',
    },
  };
}

export function getE2EUserAuthRecord(token) {
  if (process.env.NODE_ENV === 'production') return null;
  if (!token) return null;
  return getE2EUserFixtures().find(fixture => fixture.record.session_token === token) || null;
}

export function getE2ERoomOwnerAuthRecord(roomId) {
  if (process.env.NODE_ENV === 'production') return null;
  const normalizedRoomId = String(roomId || '').trim();
  if (!normalizedRoomId) return null;
  return getE2EUserFixtures().find(fixture => fixture.record.room_id === normalizedRoomId) || null;
}
