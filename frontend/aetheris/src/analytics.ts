// Thin wrapper around the page-level growth-tracking global (js/growth-tracker.js),
// loaded as a <script> tag by whichever page mounts this app (home.html or world.html).
// Safe to call even if that script hasn't loaded (ad blocker, a future embed context
// that doesn't include it, local dev without it) -- becomes a silent no-op rather than
// letting an analytics failure affect the actual feature.

interface IntoTheBattleGrowth {
  track: (eventName: string, properties?: Record<string, unknown>) => void
}

declare global {
  interface Window {
    intothebattleGrowth?: IntoTheBattleGrowth
  }
}

export function trackWorldEvent(eventName: string, properties: Record<string, unknown> = {}): void {
  try {
    window.intothebattleGrowth?.track(eventName, properties)
  } catch {
    // Analytics must never break the feature it's observing.
  }
}
