const STORAGE_PREFIX = 'itb_growth_';
const CONSENT_KEY = `${STORAGE_PREFIX}consent`;
const ANON_KEY = `${STORAGE_PREFIX}anon`;
const ATTRIBUTION_KEY = `${STORAGE_PREFIX}attribution`;
const SESSION_EVENT_PREFIX = `${STORAGE_PREFIX}event_`;
const CONSENT_COOKIE = 'itb_growth_consent';
const ANON_COOKIE = 'itb_growth_anon';

function safeStorage(type = 'localStorage') {
  try {
    const storage = window[type];
    const testKey = `${STORAGE_PREFIX}test`;
    storage.setItem(testKey, '1');
    storage.removeItem(testKey);
    return storage;
  } catch (_err) {
    return null;
  }
}

const localStore = safeStorage('localStorage');
const sessionStore = safeStorage('sessionStorage');

function cleanText(value = '', max = 240) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cookieValue(name) {
  return document.cookie.split(';').map(part => part.trim()).reduce((found, part) => {
    if (found) return found;
    const prefix = `${name}=`;
    return part.startsWith(prefix) ? decodeURIComponent(part.slice(prefix.length)) : '';
  }, '');
}

function setCookie(name, value, days = 180) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}

function randomId(prefix = 'anon') {
  const value = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
}

function anonymousId() {
  const existing = cleanText(localStore?.getItem(ANON_KEY) || cookieValue(ANON_COOKIE), 120);
  if (existing) {
    setCookie(ANON_COOKIE, existing);
    return existing;
  }
  const created = randomId();
  localStore?.setItem(ANON_KEY, created);
  setCookie(ANON_COOKIE, created);
  return created;
}

function readConsent() {
  const value = cleanText(localStore?.getItem(CONSENT_KEY) || cookieValue(CONSENT_COOKIE) || '', 40).toLowerCase();
  if (value === 'granted') return { analytics: true, ads: true, state: 'granted' };
  if (value === 'denied') return { analytics: false, ads: false, state: 'denied' };
  return { analytics: false, ads: false, state: 'unknown' };
}

function setConsent(state) {
  const normalized = state === 'granted' ? 'granted' : 'denied';
  localStore?.setItem(CONSENT_KEY, normalized);
  setCookie(CONSENT_COOKIE, normalized);
  window.dispatchEvent(new CustomEvent('itb:growth-consent-changed', { detail: readConsent() }));
  removeConsentBanner();
  if (normalized === 'granted') {
    trackAutomaticPageEvents();
  }
}

function readStoredAttribution() {
  try {
    return JSON.parse(localStore?.getItem(ATTRIBUTION_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function captureAttribution() {
  const params = new URLSearchParams(window.location.search);
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ttclid'];
  const incoming = keys.reduce((acc, key) => {
    const value = cleanText(params.get(key) || '', key === 'ttclid' ? 240 : 160);
    if (value) acc[key] = value;
    return acc;
  }, {});
  const stored = readStoredAttribution();
  const next = {
    ...stored,
    ...incoming,
    landing_path: stored.landing_path || window.location.pathname + window.location.search,
    referrer: stored.referrer || document.referrer || '',
    updated_at: new Date().toISOString(),
  };
  if (Object.keys(incoming).length || !stored.landing_path) {
    localStore?.setItem(ATTRIBUTION_KEY, JSON.stringify(next));
  }
  return next;
}

function eventIdFor(eventName, seed = '') {
  const base = `${eventName}:${seed || window.location.pathname}`;
  const key = `${SESSION_EVENT_PREFIX}${base}`.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 180);
  const existing = sessionStore?.getItem(key);
  if (existing) return existing;
  const id = `${eventName}:${randomId('evt').slice(0, 48)}`;
  sessionStore?.setItem(key, id);
  return id;
}

async function loadPublicConfig() {
  try {
    const response = await fetch('/api/public-config', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return {};
    return response.json();
  } catch (_err) {
    return {};
  }
}

let publicConfigPromise = null;
function publicConfig() {
  if (!publicConfigPromise) publicConfigPromise = loadPublicConfig();
  return publicConfigPromise;
}

async function track(eventName, properties = {}, options = {}) {
  const consent = readConsent();
  if (!consent.analytics || !consent.ads) return { skipped: true, reason: `consent:${consent.state}` };
  const config = await publicConfig();
  if (config?.growth && config.growth.enabled === false) return { skipped: true, reason: 'growth_disabled' };
  const safeName = cleanText(eventName, 80).replace(/[^a-zA-Z0-9_:-]/g, '_');
  if (!safeName) return { skipped: true, reason: 'missing_event' };

  const body = {
    eventName: safeName,
    eventId: options.eventId || eventIdFor(safeName, options.seed || properties.stage || properties.action || ''),
    anonymousId: anonymousId(),
    consent,
    properties: {
      path: window.location.pathname,
      title: document.title,
      ...properties,
    },
    attribution: captureAttribution(),
    context: {
      path: window.location.pathname + window.location.search,
      referrer: document.referrer || '',
      userAgent: navigator.userAgent || '',
    },
  };

  try {
    const response = await fetch('/api/growth/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json().catch(() => ({ success: response.ok }));
  } catch (_err) {
    return { success: false, error: 'network_error' };
  }
}

let automaticTracked = false;
function pageSpecificEvent() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/signup') return 'signup_viewed';
  if (path === '/paywall') return 'paywall_viewed';
  if (path === '/dashboard') return 'dashboard_opened';
  return '';
}

function trackAutomaticPageEvents() {
  if (automaticTracked) return;
  if (!readConsent().analytics) return;
  automaticTracked = true;
  track('page_viewed', { page_type: pageSpecificEvent() || 'public' }, { seed: `page:${window.location.pathname}` });
  const specific = pageSpecificEvent();
  if (specific) track(specific, {}, { seed: `specific:${window.location.pathname}` });
}

function removeConsentBanner() {
  document.getElementById('itb-growth-consent')?.remove();
}

function renderConsentBanner() {
  if (readConsent().state !== 'unknown' || document.getElementById('itb-growth-consent')) return;
  const banner = document.createElement('div');
  banner.id = 'itb-growth-consent';
  banner.innerHTML = `
    <div class="itb-growth-consent-copy">
      <strong>Help improve creator setup</strong>
      <span>Allow analytics and TikTok ad measurement for IntoTheBattle.</span>
    </div>
    <div class="itb-growth-consent-actions">
      <button type="button" data-growth-consent="denied">No thanks</button>
      <button type="button" data-growth-consent="granted">Allow</button>
    </div>
  `;
  const style = document.createElement('style');
  style.id = 'itb-growth-consent-style';
  style.textContent = `
    #itb-growth-consent {
      position: fixed;
      z-index: 2147483000;
      left: 16px;
      right: 16px;
      bottom: 16px;
      width: min(720px, calc(100% - 32px));
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 14px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 16px;
      background: rgba(5,7,11,.94);
      color: #fff8e6;
      box-shadow: 0 22px 70px rgba(0,0,0,.42);
      font-family: Inter, Arial, sans-serif;
    }
    .itb-growth-consent-copy { display: grid; gap: 3px; min-width: 0; }
    .itb-growth-consent-copy strong { font-size: 14px; line-height: 1.2; }
    .itb-growth-consent-copy span { color: #c5d3f5; font-size: 12px; line-height: 1.35; }
    .itb-growth-consent-actions { display: flex; gap: 8px; flex: 0 0 auto; }
    .itb-growth-consent-actions button {
      min-height: 38px;
      padding: 0 12px;
      border-radius: 11px;
      border: 1px solid rgba(255,255,255,.14);
      color: #fff8e6;
      background: rgba(255,255,255,.07);
      font-weight: 850;
      cursor: pointer;
    }
    .itb-growth-consent-actions button[data-growth-consent="granted"] {
      color: #081014;
      border: 0;
      background: linear-gradient(135deg,#55e7ff,#fff0b9 60%,#ff6a3d);
    }
    @media (max-width: 620px) {
      #itb-growth-consent { align-items: stretch; flex-direction: column; }
      .itb-growth-consent-actions { width: 100%; }
      .itb-growth-consent-actions button { flex: 1; }
    }
  `;
  document.head.appendChild(style);
  banner.addEventListener('click', event => {
    const button = event.target.closest('[data-growth-consent]');
    if (!button) return;
    setConsent(button.dataset.growthConsent);
  });
  document.body.appendChild(banner);
}

captureAttribution();
anonymousId();

window.intothebattleGrowth = {
  track,
  consent: readConsent,
  setConsent,
  flushPageEvents: trackAutomaticPageEvents,
  attribution: readStoredAttribution,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    renderConsentBanner();
    trackAutomaticPageEvents();
  }, { once: true });
} else {
  renderConsentBanner();
  trackAutomaticPageEvents();
}
