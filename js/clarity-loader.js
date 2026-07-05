let clarityInitialized = false;
let clarityClient = null;
const pendingEvents = window.__intothebattlePendingEvents || [];
window.__intothebattlePendingEvents = pendingEvents;

window.intothebattleTrack = function intothebattleTrack(eventName, options = {}) {
  const safeName = String(eventName || '').trim().replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
  if (!safeName) return;
  const payload = {
    eventName: safeName,
    tags: options && typeof options === 'object' ? options.tags || {} : {},
    upgrade: Boolean(options && options.upgrade),
  };

  if (!clarityInitialized || !clarityClient) {
    pendingEvents.push(payload);
    if (pendingEvents.length > 25) pendingEvents.shift();
    return;
  }

  try {
    if (typeof clarityClient.event === 'function') clarityClient.event(payload.eventName);
    if (typeof clarityClient.setTag === 'function') {
      Object.entries(payload.tags).forEach(([key, value]) => {
        clarityClient.setTag(String(key).slice(0, 60), String(value).slice(0, 120));
      });
    }
    if (payload.upgrade && typeof clarityClient.upgrade === 'function') {
      clarityClient.upgrade(payload.eventName);
    }
  } catch (_err) {
    // Tracking must never block the app.
  }
};

function trackingBlockedByBrowser() {
  const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  return dnt === '1' || dnt === 'yes';
}

function consentGranted() {
  try {
    const stored = window.localStorage?.getItem('itb_growth_consent');
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('itb_growth_consent='));
    const cookieValue = cookie ? decodeURIComponent(cookie.slice('itb_growth_consent='.length)) : '';
    return (stored || cookieValue) === 'granted';
  } catch (_err) {
    return false;
  }
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
  if (clarityInitialized || trackingBlockedByBrowser() || !consentGranted()) return;

  try {
    const config = await loadPublicConfig();
    const clarity = config && config.clarity;
    if (!clarity || !clarity.enabled || !clarity.projectId) return;

    const module = await import('/vendor/microsoft-clarity/index.js');
    const Clarity = module.default;
    if (!Clarity || typeof Clarity.init !== 'function') return;

    Clarity.init(clarity.projectId);
    clarityInitialized = true;
    clarityClient = Clarity;

    if (typeof Clarity.setTag === 'function') {
      Clarity.setTag('app', 'intothebattle');
      Clarity.setTag('path', window.location.pathname);
    }

    while (pendingEvents.length) {
      const event = pendingEvents.shift();
      window.intothebattleTrack(event.eventName, event);
    }
  } catch (_err) {
    // Analytics must never block the app.
  }
}

window.addEventListener('itb:growth-consent-changed', () => initClarity());
initClarity();
