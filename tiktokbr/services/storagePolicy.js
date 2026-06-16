import fs from 'fs';
import path from 'path';

function numberFromEnv(name, fallback = null) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function bytesFromMb(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1024 * 1024) : null;
}

export function uploadLimitBytes(envName, fallbackBytes) {
  return bytesFromMb(process.env[envName]) || fallbackBytes;
}

export function formatStorageBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getStorageCapacity(root) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(root);
    const blockSize = Number(stats.bsize || 0);
    const totalBytes = blockSize * Number(stats.blocks || 0);
    const freeBytes = blockSize * Number(stats.bfree || 0);
    const availableBytes = blockSize * Number(stats.bavail || stats.bfree || 0);
    return {
      totalBytes,
      freeBytes,
      availableBytes,
      humanTotal: formatStorageBytes(totalBytes),
      humanFree: formatStorageBytes(freeBytes),
      humanAvailable: formatStorageBytes(availableBytes),
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

export function configuredStorageLimitBytes() {
  const explicitBytes = numberFromEnv('STORAGE_LIMIT_BYTES');
  if (explicitBytes) return explicitBytes;
  return bytesFromMb(process.env.STORAGE_LIMIT_MB);
}

export function minimumFreeBytes() {
  return bytesFromMb(process.env.STORAGE_MIN_FREE_MB) || 5 * 1024 * 1024;
}

export function getStorageUsage(root, options = {}) {
  const maxEntries = Number(options.maxEntries || 25000);
  const maxDepth = Number(options.maxDepth || 8);
  const resolvedRoot = path.resolve(root);
  const configuredLimit = configuredStorageLimitBytes();
  const summary = {
    root: resolvedRoot,
    exists: fs.existsSync(resolvedRoot),
    bytes: 0,
    humanBytes: '0 B',
    files: 0,
    dirs: 0,
    capacity: null,
    configuredLimitBytes: configuredLimit,
    humanConfiguredLimit: configuredLimit ? formatStorageBytes(configuredLimit) : null,
    truncated: false,
    byTopLevel: {},
    errors: [],
  };

  if (!summary.exists) return summary;

  function addTopLevelBytes(filePath, bytes) {
    const relative = path.relative(resolvedRoot, filePath);
    const topLevel = relative && !relative.startsWith('..')
      ? relative.split(path.sep)[0] || '.'
      : '.';
    summary.byTopLevel[topLevel] = (summary.byTopLevel[topLevel] || 0) + bytes;
  }

  function visit(dir, depth) {
    if (summary.truncated || summary.files + summary.dirs >= maxEntries) {
      summary.truncated = true;
      return;
    }
    if (depth > maxDepth) {
      summary.truncated = true;
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      summary.dirs += 1;
    } catch (err) {
      summary.errors.push({ path: dir, error: err?.message || String(err) });
      return;
    }

    for (const entry of entries) {
      if (summary.truncated || summary.files + summary.dirs >= maxEntries) {
        summary.truncated = true;
        break;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = fs.statSync(fullPath);
        summary.files += 1;
        summary.bytes += stat.size;
        addTopLevelBytes(fullPath, stat.size);
      } catch (err) {
        summary.errors.push({ path: fullPath, error: err?.message || String(err) });
      }
    }
  }

  visit(resolvedRoot, 0);
  summary.humanBytes = formatStorageBytes(summary.bytes);
  summary.capacity = getStorageCapacity(resolvedRoot);
  summary.byTopLevel = Object.fromEntries(
    Object.entries(summary.byTopLevel)
      .sort((a, b) => b[1] - a[1])
      .map(([key, bytes]) => [key, { bytes, humanBytes: formatStorageBytes(bytes) }])
  );
  return summary;
}

export function buildUploadDecision(root, incomingBytes = 0, options = {}) {
  const bytes = Number(incomingBytes || 0);
  const usage = getStorageUsage(root, { maxEntries: options.maxEntries || 25000, maxDepth: options.maxDepth || 8 });
  const configuredLimit = usage.configuredLimitBytes;
  const minFree = minimumFreeBytes();
  const projectedBytes = options.alreadyWritten ? usage.bytes : usage.bytes + bytes;
  const decision = {
    ok: true,
    category: options.category || 'upload',
    incomingBytes: bytes,
    humanIncoming: formatStorageBytes(bytes),
    usage,
    reason: null,
    message: 'Upload capacity looks good.',
  };

  if (configuredLimit && projectedBytes > configuredLimit) {
    decision.ok = false;
    decision.reason = 'storage_limit';
    decision.message = `This upload would exceed the configured storage limit (${formatStorageBytes(configuredLimit)}).`;
    return decision;
  }

  const available = usage.capacity?.availableBytes;
  const requiredAvailable = options.alreadyWritten ? minFree : bytes + minFree;
  if (Number.isFinite(available) && available < requiredAvailable) {
    decision.ok = false;
    decision.reason = 'low_disk_space';
    decision.message = `Not enough disk space for this upload. Available: ${formatStorageBytes(available)}. Required with reserve: ${formatStorageBytes(requiredAvailable)}.`;
    return decision;
  }

  if (usage.errors.length) {
    decision.reason = 'storage_scan_warnings';
    decision.message = 'Storage is writable, but some folders could not be scanned.';
  }

  return decision;
}

export function storageRiskSummary(root) {
  const usage = getStorageUsage(root);
  const warnings = [];
  const failures = [];
  const configuredLimit = usage.configuredLimitBytes;
  const capacity = usage.capacity || {};
  const minFree = minimumFreeBytes();

  if (!usage.exists) failures.push('Storage root does not exist.');
  if (usage.errors.length) warnings.push(`${usage.errors.length} storage path(s) could not be scanned.`);
  if (usage.truncated) warnings.push('Storage scan was truncated.');
  if (configuredLimit && usage.bytes > configuredLimit * 0.85) {
    warnings.push(`Storage usage is above 85% of configured limit (${usage.humanBytes} of ${formatStorageBytes(configuredLimit)}).`);
  }
  if (Number.isFinite(capacity.availableBytes) && capacity.availableBytes < minFree) {
    failures.push(`Available disk space is below reserve (${capacity.humanAvailable} available).`);
  }

  return {
    ok: failures.length === 0,
    warnings,
    failures,
    usage,
  };
}
