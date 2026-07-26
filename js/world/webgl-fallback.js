export function detectWebglSupport() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch (err) {
    return false;
  }
}

export function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Calls `onChange(matches)` immediately and again whenever the OS-level preference flips.
// Returns a cleanup function.
export function watchReducedMotion(onChange) {
  if (typeof window.matchMedia !== 'function') {
    onChange(false);
    return () => {};
  }
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
  onChange(mql.matches);
  const listener = (event) => onChange(event.matches);
  mql.addEventListener?.('change', listener) ?? mql.addListener?.(listener);
  return () => {
    mql.removeEventListener?.('change', listener) ?? mql.removeListener?.(listener);
  };
}

export function showPosterFallback(canvas, posterEl) {
  if (canvas) canvas.hidden = true;
  if (posterEl) posterEl.hidden = false;
}
