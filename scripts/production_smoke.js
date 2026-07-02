const baseUrl = (process.env.PRODUCTION_SMOKE_URL || process.env.APP_BASE_URL || 'https://intothebattle.com').replace(/\/$/, '');
const token = process.env.PRODUCTION_SMOKE_TOKEN || process.env.DIAGNOSTICS_TOKEN || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
  });
  return response;
}

async function expectStatus(pathname, statuses, options = {}) {
  const expected = Array.isArray(statuses) ? statuses : [statuses];
  const response = await request(pathname, options);
  assert(expected.includes(response.status), `${pathname} expected ${expected.join('/')} but received ${response.status}`);
  return response;
}

try {
  await expectStatus('/healthz', 200);
  for (const pathname of ['/', '/signup', '/login', '/paywall', '/sponsors']) {
    const response = await expectStatus(pathname, 200);
    const body = await response.text();
    assert(body.length > 1000, `${pathname} returned unexpectedly small HTML`);
  }

  await expectStatus('/dashboard', 302);
  await expectStatus('/api/status', 401);
  await expectStatus('/api/stream/setup/start', 401, { method: 'POST' });
  await expectStatus('/metrics', [401, 404]);
  await expectStatus('/api/runtime/diagnostics', 401);
  await expectStatus('/api/runtime/launch-readiness', 401);
  await expectStatus('/api/test/status', 404);
  await expectStatus('/api/test/spawn', 404, { method: 'POST' });
  await expectStatus('/overlay?room_id=production-smoke', 401);

  if (!token) {
    console.log('Production smoke basic checks passed. Set PRODUCTION_SMOKE_TOKEN to include diagnostics and launch-readiness checks.');
    process.exit(0);
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  const diagnostics = await expectStatus('/api/runtime/diagnostics', 200, { headers: authHeaders });
  const diagnosticsBody = await diagnostics.json();
  assert(diagnosticsBody.ok === true, 'runtime diagnostics should report ok');
  assert(diagnosticsBody.storage?.ok === true, 'runtime diagnostics should report writable storage');
  assert(diagnosticsBody.database?.initialized === true, 'runtime diagnostics should report initialized database');

  const readiness = await expectStatus('/api/runtime/launch-readiness', 200, { headers: authHeaders });
  const readinessBody = await readiness.json();
  assert(readinessBody.launchReady === true, `launch readiness is not clean:\n${JSON.stringify(readinessBody.summary, null, 2)}`);

  console.log('Production smoke checks passed');
} catch (err) {
  console.error(err?.stack || err);
  process.exitCode = 1;
}
