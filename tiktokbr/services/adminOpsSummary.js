function safeCount(db, sql, params = []) {
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.count || row?.COUNT || 0) || 0;
  } catch (err) {
    return 0;
  }
}

function storageStatus(storageRisk) {
  if (!storageRisk) return { status: 'unknown', warnings: 0, message: 'Storage scan unavailable' };
  const warnings = Array.isArray(storageRisk.warnings) ? storageRisk.warnings.length : 0;
  const status = storageRisk.ok === false || warnings > 0 ? 'warn' : 'ok';
  return {
    status,
    warnings,
    message: storageRisk.message || storageRisk.summary || (status === 'ok' ? 'Storage looks writable' : 'Storage needs review'),
    humanBytes: storageRisk.humanBytes || '',
    humanConfiguredLimit: storageRisk.humanConfiguredLimit || '',
  };
}

function summarizeLive(liveActivity = []) {
  const now = Date.now();
  const staleMs = 15 * 60 * 1000;
  const staleRooms = liveActivity.filter(room => {
    if (!room?.lastEventAt) return Number(room?.playerCount || 0) > 0 && !room?.connected;
    const last = new Date(room.lastEventAt).getTime();
    return Number.isFinite(last) && now - last > staleMs && Number(room?.playerCount || 0) > 0;
  });
  const disconnectedWithPlayers = liveActivity.filter(room => !room?.connected && Number(room?.playerCount || 0) > 0);
  return {
    rooms: liveActivity.length,
    connected: liveActivity.filter(room => room?.connected).length,
    overlays: liveActivity.reduce((sum, room) => sum + (Number(room?.overlayCount) || 0), 0),
    players: liveActivity.reduce((sum, room) => sum + (Number(room?.playerCount) || 0), 0),
    staleRooms: staleRooms.length,
    disconnectedWithPlayers: disconnectedWithPlayers.length,
  };
}

function buildAlerts({ dbHealth, live, storage, integrations, content }) {
  const alerts = [];
  if (dbHealth && dbHealth.initialized === false) {
    alerts.push({ level: 'danger', title: 'Database is not initialized', detail: dbHealth.lastError || 'DB startup has not completed.' });
  }
  if (live.disconnectedWithPlayers > 0) {
    alerts.push({ level: 'danger', title: 'Disconnected rooms still have players', detail: `${live.disconnectedWithPlayers} room(s) may need live-end cleanup review.` });
  }
  if (live.staleRooms > 0) {
    alerts.push({ level: 'warn', title: 'Stale live room activity', detail: `${live.staleRooms} room(s) have player state without recent TikTok events.` });
  }
  if (storage.status === 'warn') {
    alerts.push({ level: 'warn', title: 'Storage needs review', detail: storage.message });
  }
  if (integrations.emailFailed > 0) {
    alerts.push({ level: 'warn', title: 'Failed email deliveries', detail: `${integrations.emailFailed} delivery row(s) are failed.` });
  }
  if (integrations.marketingFailed > 0) {
    alerts.push({ level: 'warn', title: 'Failed marketing posts', detail: `${integrations.marketingFailed} marketing post(s) need recovery.` });
  }
  if (!content.writefreelyReady) {
    alerts.push({ level: 'warn', title: 'WriteFreely bridge not ready', detail: 'Blog posts can be drafted locally, but external publishing is not fully configured.' });
  }
  if (!alerts.length) alerts.push({ level: 'ok', title: 'No admin alerts', detail: 'Live, content, growth, and account checks are quiet.' });
  return alerts;
}

export function buildAdminOpsSummary({
  db,
  dbHealth,
  userMetrics,
  liveActivity = [],
  storageRisk = null,
  writefreelyConfig = {},
  marketingDiagnostics = {},
} = {}) {
  const live = summarizeLive(liveActivity);
  const counts = {
    users: safeCount(db, 'SELECT COUNT(*) AS count FROM users'),
    activeUsers: safeCount(db, 'SELECT COUNT(*) AS count FROM users WHERE is_active <> 0'),
    accessCodes: safeCount(db, 'SELECT COUNT(*) AS count FROM access_codes'),
    activeAccessCodes: safeCount(db, "SELECT COUNT(*) AS count FROM access_codes WHERE COALESCE(is_revoked, 0) = 0 AND (expires_at IS NULL OR expires_at >= CURRENT_TIMESTAMP)"),
    promos: safeCount(db, 'SELECT COUNT(*) AS count FROM promo_codes'),
    comments: safeCount(db, 'SELECT COUNT(*) AS count FROM creator_comments WHERE deleted_at IS NULL'),
    referralsPending: safeCount(db, "SELECT COUNT(*) AS count FROM referral_rewards WHERE status IN ('pending', 'pending_review')"),
    blogDrafts: safeCount(db, "SELECT COUNT(*) AS count FROM blog_posts WHERE status IN ('draft', 'queued')"),
    sponsorCreatives: safeCount(db, 'SELECT COUNT(*) AS count FROM platform_sponsor_creatives'),
  };
  const integrations = {
    emailQueued: safeCount(db, "SELECT COUNT(*) AS count FROM admin_email_deliveries WHERE status IN ('queued', 'pending')"),
    emailFailed: safeCount(db, "SELECT COUNT(*) AS count FROM admin_email_deliveries WHERE status = 'failed'"),
    marketingFailed: safeCount(db, "SELECT COUNT(*) AS count FROM marketing_posts WHERE status = 'failed'"),
    marketingDueApproved: Number(marketingDiagnostics?.dueApprovedCount || 0),
    marketingEnabled: Boolean(marketingDiagnostics?.enabled),
    marketingDryRun: Boolean(marketingDiagnostics?.dryRun),
  };
  const content = {
    writefreelyReady: Boolean(writefreelyConfig?.enabled || writefreelyConfig?.directEnabled || writefreelyConfig?.webhookEnabled || writefreelyConfig?.ready || writefreelyConfig?.configured),
    blogDrafts: counts.blogDrafts,
    sponsorCreatives: counts.sponsorCreatives,
  };
  const storage = storageStatus(storageRisk);
  const health = {
    database: dbHealth || null,
    status: dbHealth?.initialized === false ? 'danger' : storage.status === 'warn' ? 'warn' : 'ok',
  };

  return {
    generatedAt: new Date().toISOString(),
    health,
    counts,
    accountMetrics: userMetrics || null,
    live,
    integrations,
    storage,
    content,
    alerts: buildAlerts({ dbHealth, live, storage, integrations, content }),
  };
}
