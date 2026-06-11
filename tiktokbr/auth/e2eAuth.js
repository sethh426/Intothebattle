const FAR_FUTURE = '2099-12-31 23:59:59';

export function getE2EAuthRecord(token) {
  if (process.env.NODE_ENV === 'production') return null;
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
    },
  };
}
