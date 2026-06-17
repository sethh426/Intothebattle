let clarityInitialized = false;

function trackingBlockedByBrowser() {
  const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  return dnt === '1' || dnt === 'yes';
}

async function loadPublicConfig() {
  const response = await fetch('/api/public-config', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return response.json();
}

async function initClarity() {
  if (clarityInitialized || trackingBlockedByBrowser()) return;

  try {
    const config = await loadPublicConfig();
    const clarity = config && config.clarity;
    if (!clarity || !clarity.enabled || !clarity.projectId) return;

    const module = await import('/vendor/microsoft-clarity/index.js');
    const Clarity = module.default;
    if (!Clarity || typeof Clarity.init !== 'function') return;

    Clarity.init(clarity.projectId);
    clarityInitialized = true;

    if (typeof Clarity.setTag === 'function') {
      Clarity.setTag('app', 'intothebattle');
      Clarity.setTag('path', window.location.pathname);
    }
  } catch (_err) {
    // Analytics must never block the app.
  }
}

initClarity();
