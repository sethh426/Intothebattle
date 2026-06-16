import fs from 'fs';
import path from 'path';

export function formatStorageBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getStorageUsage(root, options = {}) {
  const maxEntries = Number(options.maxEntries || 25000);
  const maxDepth = Number(options.maxDepth || 8);
  const resolvedRoot = path.resolve(root);
  const summary = {
    root: resolvedRoot,
    exists: fs.existsSync(resolvedRoot),
    bytes: 0,
    humanBytes: '0 B',
    files: 0,
    dirs: 0,
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
  summary.byTopLevel = Object.fromEntries(
    Object.entries(summary.byTopLevel)
      .sort((a, b) => b[1] - a[1])
      .map(([key, bytes]) => [key, { bytes, humanBytes: formatStorageBytes(bytes) }])
  );
  return summary;
}
