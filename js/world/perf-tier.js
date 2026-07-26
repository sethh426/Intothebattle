export const PARTICLE_TIER_FACTOR = { high: 1, medium: 0.6, low: 0.3 };

// Instant heuristic from device signals, used before any frame has rendered so particle
// budgets can be set on the very first frame rather than waiting on an FPS sample.
export function quickPerfTier() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4; // Chrome-only; other browsers fall back to a mid-range assumption
  const width = window.innerWidth || 1024;

  let score = 0;
  if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;
  if (memory >= 8) score += 2;
  else if (memory >= 4) score += 1;
  if (width >= 1200) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

// Samples real frame rate over the first ~1s of rendering; call `sample(dt)` once per
// frame and it invokes `onSettled(fps)` exactly once when the window closes, so the caller
// can downgrade the tier if the quick heuristic was too optimistic.
export function createFpsMonitor(onSettled, windowSeconds = 1) {
  let frames = 0;
  let elapsed = 0;
  let settled = false;

  function sample(deltaSeconds) {
    if (settled) return;
    frames += 1;
    elapsed += deltaSeconds;
    if (elapsed >= windowSeconds) {
      settled = true;
      onSettled(frames / elapsed);
    }
  }

  return { sample };
}

export function tierFromFps(fps) {
  if (fps >= 50) return 'high';
  if (fps >= 30) return 'medium';
  return 'low';
}

export function applyPerfTier(tier, particleSystems) {
  const factor = PARTICLE_TIER_FACTOR[tier] ?? 1;
  particleSystems.forEach(({ system }) => {
    system.setActiveCount(Math.floor(system.count * factor));
  });
}
