(function attachOverlayDiagnostics(global) {
  'use strict';

  function normalizeAuditRect(item) {
    if (!item) return null;
    const left = Number(item.left);
    const right = Number(item.right);
    const top = Number(item.top);
    const bottom = Number(item.bottom);
    if (![left, right, top, bottom].every(Number.isFinite)) return null;
    return {
      id: item.id || 'object',
      left,
      right,
      top,
      bottom,
      x: left,
      y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
      type: item.type || '',
      parentId: item.parentId || '',
      position: item.position || '',
      stageBound: Boolean(item.stageBound),
    };
  }

  function rectDistance(a, b) {
    const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    return Math.hypot(dx, dy);
  }

  function auditObjectLayout(objects, frame, minGap) {
    const normalized = objects.map(normalizeAuditRect).filter(Boolean);
    const leaks = normalized
      .filter(item => (
        item.left < frame.x + minGap ||
        item.right > frame.x + frame.w - minGap ||
        item.top < frame.y + minGap ||
        item.bottom > frame.y + frame.h - minGap
      ))
      .map(item => item.id);
    const collisions = [];
    for (let i = 0; i < normalized.length; i += 1) {
      for (let j = i + 1; j < normalized.length; j += 1) {
        const a = normalized[i];
        const b = normalized[j];
        if (rectDistance(a, b) < minGap) collisions.push(`${a.id}<->${b.id}`);
      }
    }
    return { objects: normalized, leaks, collisions };
  }

  function domLayerLeakLabels(domObjects) {
    return domObjects
      .filter(item => !item.stageBound)
      .map(item => `${item.id}:${item.parentId || 'no-parent'}:${item.position || 'static'}`);
  }

  global.IntoTheBattleOverlayDiagnostics = Object.freeze({
    normalizeAuditRect,
    auditObjectLayout,
    domLayerLeakLabels,
  });
})(window);
