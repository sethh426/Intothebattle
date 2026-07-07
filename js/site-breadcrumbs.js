const ROUTES = new Map([
  ['/', 'Home'],
  ['/home', 'Home'],
  ['/signup', 'Create Account'],
  ['/register', 'Email Signup'],
  ['/login', 'Login'],
  ['/sponsors', 'Sponsors'],
  ['/how-to-play', 'How To Play'],
  ['/blog', 'Blog'],
  ['/updates', 'Updates'],
  ['/site-map', 'Site Map'],
  ['/privacy', 'Privacy Policy'],
  ['/privacy-policy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/terms-of-service', 'Terms of Service'],
  ['/paywall', 'Creator Pro'],
  ['/profile', 'Profile'],
  ['/dashboard', 'Command Center'],
  ['/stats', 'Stats'],
]);

function normalizePath(pathname) {
  const clean = String(pathname || '/').replace(/\/+$/, '') || '/';
  return clean.endsWith('.html') ? clean.slice(0, -5) : clean;
}

function labelForPath(pathname) {
  const path = normalizePath(pathname);
  if (ROUTES.has(path)) return ROUTES.get(path);
  return path.split('/').filter(Boolean).pop()?.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) || 'Page';
}

function buildTrail(pathname) {
  const path = normalizePath(pathname);
  if (path === '/' || path === '/home') return [];
  return [
    { href: '/', label: 'Home' },
    { href: path, label: labelForPath(path), current: true },
  ];
}

function ensureBreadcrumbStyles() {
  if (document.getElementById('site-breadcrumb-styles')) return;
  const style = document.createElement('style');
  style.id = 'site-breadcrumb-styles';
  style.textContent = `
    .site-breadcrumbs {
      width: min(1180px, calc(100% - 36px));
      margin: 18px auto 0;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #a8afbf;
      font: 800 12px/1.2 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .site-breadcrumbs a {
      color: #ffdf8a;
      text-decoration: none;
    }
    .site-breadcrumbs span[aria-hidden="true"] {
      color: rgba(255,255,255,.34);
    }
    .site-breadcrumbs [aria-current="page"] {
      color: #dce6f6;
    }
    @media (max-width: 620px) {
      .site-breadcrumbs {
        width: min(100% - 24px, 1180px);
        margin-top: 12px;
        font-size: 11px;
        flex-wrap: wrap;
      }
    }
  `;
  document.head.appendChild(style);
}

function insertBreadcrumbs() {
  const trail = buildTrail(window.location.pathname);
  if (!trail.length || document.querySelector('.site-breadcrumbs')) return;
  ensureBreadcrumbStyles();

  const nav = document.createElement('nav');
  nav.className = 'site-breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');
  trail.forEach((item, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      nav.appendChild(sep);
    }
    if (item.current) {
      const current = document.createElement('span');
      current.setAttribute('aria-current', 'page');
      current.textContent = item.label;
      nav.appendChild(current);
    } else {
      const link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.label;
      nav.appendChild(link);
    }
  });

  const anchor = document.querySelector('.nav-wrap, header, main') || document.body.firstElementChild;
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(nav, anchor.nextSibling);
  } else {
    document.body.prepend(nav);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', insertBreadcrumbs);
} else {
  insertBreadcrumbs();
}
