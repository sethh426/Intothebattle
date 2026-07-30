const ADMIN_NAV_ITEMS = [
  { href: '/admin', label: 'Command Center', key: 'dashboard' },
  { href: '/admin/email', label: 'Email Accounts', key: 'email' },
  { href: '/admin/sponsors', label: 'Video Platform', key: 'sponsors' },
  { href: '/admin/marketing', label: 'Company Growth', key: 'marketing' },
  { href: '/admin/blog', label: 'Blog Posts', key: 'blog' },
  { href: '/admin/referrals', label: 'Referrals', key: 'referrals' },
  { href: '/admin/logout', label: 'Logout', key: 'logout' },
];

export function escapeAdminHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAdminAttr(value) {
  return escapeAdminHtml(value).replace(/"/g, '&quot;');
}

export function renderAdminNav(active = 'dashboard') {
  return `<nav class="admin-nav" aria-label="Admin navigation">${ADMIN_NAV_ITEMS.map(item => {
    const current = item.key === active ? ' aria-current="page"' : '';
    return `<a href="${escapeAdminAttr(item.href)}"${current}>${escapeAdminHtml(item.label)}</a>`;
  }).join('')}</nav>`;
}

export function adminMetricCard(label, key, value, note = '', tone = '') {
  const toneClass = tone ? ` metric-card-${escapeAdminAttr(tone)}` : '';
  return `<div class="metric-card${toneClass}">
    <span>${escapeAdminHtml(label)}</span>
    <strong data-count-key="${escapeAdminAttr(key)}">${escapeAdminHtml(String(value ?? 0))}</strong>
    ${note ? `<small>${escapeAdminHtml(note)}</small>` : ''}
  </div>`;
}

export function renderAdminNotices({ message = '', error = '', createdCode = '' } = {}) {
  return [
    message ? `<div class="notice success">${escapeAdminHtml(message)}</div>` : '',
    createdCode ? `<div class="notice success">New access code created: <strong>${escapeAdminHtml(createdCode)}</strong> <button type="button" onclick="navigator.clipboard.writeText('${escapeAdminAttr(createdCode)}')">Copy</button></div>` : '',
    error ? `<div class="notice error">${escapeAdminHtml(error)}</div>` : '',
  ].join('');
}

export function renderAdminStyles() {
  return `<style>
    * { box-sizing: border-box; }
    body { min-height:100vh; font-family: Inter, Arial, sans-serif; background:radial-gradient(circle at 16% 0,rgba(246,201,91,.18),transparent 30%),radial-gradient(circle at 88% 12%,rgba(232,59,95,.14),transparent 28%),linear-gradient(180deg,#050608,#030406); color:#fff8e6; margin:0; padding:24px; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(246,201,91,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(246,201,91,.035) 1px,transparent 1px); background-size:58px 58px; mask-image:radial-gradient(circle at top,black,transparent 72%); z-index:-1; }
    .wrapper { max-width: 1220px; margin: 0 auto; display:grid; gap:18px; }
    .admin-hero { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px; border:1px solid rgba(246,201,91,.24); border-radius:26px; background:rgba(5,7,11,.78); box-shadow:0 28px 80px rgba(0,0,0,.38); }
    .admin-brand { display:flex; align-items:center; gap:14px; min-width:0; }
    .admin-brand img { width:58px; height:58px; border-radius:18px; border:1px solid rgba(246,201,91,.34); background:rgba(246,201,91,.08); object-fit:cover; }
    h1 { margin:0; font-size:clamp(28px,4vw,48px); line-height:1; text-transform:uppercase; }
    .admin-brand p { margin:6px 0 0; color:#a8afbf; font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
    .notice { padding: 14px 16px; border-radius: 16px; border:1px solid rgba(255,255,255,.1); background: rgba(255,255,255,0.06); }
    .error { color: #ffb6b6; }
    .success { color: #c6ffc3; }
    .muted { color:#a8afbf; line-height:1.5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .metrics-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr)); gap:12px; }
    .metric-card { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.22); box-shadow:inset 0 1px 0 rgba(255,255,255,.05); }
    .metric-card-warn { border-color:rgba(255,186,73,.34); background:rgba(255,186,73,.08); }
    .metric-card-danger { border-color:rgba(232,59,95,.36); background:rgba(232,59,95,.1); }
    .metric-card-ok { border-color:rgba(82,196,134,.3); background:rgba(82,196,134,.08); }
    .metric-card span { display:block; color:#a8afbf; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; }
    .metric-card strong { display:block; margin-top:7px; color:#fff8e6; font-size:clamp(25px,3.2vw,40px); line-height:1; }
    .metric-card small { display:block; min-height:32px; margin-top:8px; color:#8590a4; font-size:11px; line-height:1.4; }
    .metrics-footnote { margin-top:-8px; color:#8590a4; font-size:12px; text-align:right; }
    .card { background: linear-gradient(180deg,rgba(255,255,255,.065),rgba(255,255,255,.025)); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 20px; box-shadow:0 20px 60px rgba(0,0,0,.24); }
    .card h2 { margin:0 0 12px; font-size:20px; }
    .control-panel { min-width:0; padding:16px; border-radius:18px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.2); }
    .control-panel h2 { margin:0 0 12px; font-size:18px; }
    .section-grid { display:grid; gap:14px; }
    .admin-section { padding:0; overflow:hidden; scroll-margin-top:16px; }
    .admin-section summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; cursor:pointer; }
    .admin-section summary::-webkit-details-marker { display:none; }
    .admin-section summary span { color:#fff8e6; font-size:20px; font-weight:900; }
    .admin-section summary small { color:#a8afbf; font-size:12px; font-weight:800; line-height:1.4; text-align:right; }
    .admin-section summary::after { content:"Open"; min-width:58px; min-height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:999px; color:#ffdf8a; background:rgba(246,201,91,.08); border:1px solid rgba(246,201,91,.22); font-size:11px; font-weight:900; text-transform:uppercase; }
    .admin-section[open] summary::after { content:"Hide"; }
    .section-body { padding:0 20px 20px; }
    .section-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; margin:0 0 10px; }
    .section-toolbar input { max-width:340px; }
    .button-link { display:inline-flex; align-items:center; justify-content:center; min-height:38px; padding:0 12px; border-radius:12px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#fff8e6; font-size:12px; font-weight:900; }
    .status-pill { display:inline-flex; align-items:center; min-height:24px; padding:0 9px; border-radius:999px; font-size:11px; font-weight:900; text-transform:uppercase; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#fff8e6; }
    .status-pill.warn { border-color:rgba(255,186,73,.35); color:#ffd27a; background:rgba(255,186,73,.08); }
    .status-pill.danger { border-color:rgba(232,59,95,.38); color:#ffb7c1; background:rgba(232,59,95,.1); }
    .status-pill.ok { border-color:rgba(82,196,134,.34); color:#baf7d2; background:rgba(82,196,134,.08); }
    .alert-list { display:grid; gap:10px; margin:0; padding:0; list-style:none; }
    .alert-list li { padding:12px 14px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.18); }
    label { display: block; margin: 10px 0 6px; color: #a8afbf; font-size: 12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    input, select { width: 100%; min-height:46px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: #111827; color: #fff8e6; }
    select option, select optgroup { background:#111827; color:#fff8e6; }
    input[type="checkbox"] { width:auto; min-height:0; margin-right:8px; }
    button { margin-top: 12px; width: 100%; min-height:44px; padding: 0 14px; border: none; border-radius: 14px; background: linear-gradient(135deg,#f6c95b,#fff0b9 52%,#ff6a3d); color: #170c02; cursor: pointer; font-weight: 900; }
    .danger-button { background: rgba(232,59,95,.16); color:#ffb7c1; border:1px solid rgba(232,59,95,.32); }
    .secondary-button { background: rgba(255,255,255,.07); color:#fff8e6; border:1px solid rgba(255,255,255,.12); }
    .free-forever-badge { display:inline-flex; align-items:center; min-height:26px; padding:0 10px; border-radius:999px; border:1px solid rgba(246,201,91,.42); color:#ffe99a; background:rgba(246,201,91,.12); font-weight:900; box-shadow:0 0 18px rgba(246,201,91,.12); }
    .mini-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; min-width:260px; }
    .mini-form input { min-height:38px; padding:8px 10px; border-radius:10px; font-size:12px; }
    .mini-form button { grid-column:1 / -1; min-height:36px; margin-top:0; }
    .table-shell { width:100%; overflow-x:auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; overflow:hidden; border-radius:16px; }
    th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px; font-size: 13px; vertical-align:top; }
    th { background: rgba(246,201,91,0.09); color:#ffdf8a; text-align: left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .button-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .button-row button { width: auto; flex: 1; }
    table button { min-height:36px; padding: 0 12px; border-radius: 12px; }
    a { color: #ffdf8a; text-decoration: none; font-weight:800; }
    .admin-nav { display:flex; gap:10px; flex-wrap:wrap; }
    .admin-nav a { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:#fff8e6; background:rgba(255,255,255,.055); }
    .admin-nav a[aria-current="page"] { border-color:rgba(246,201,91,.42); color:#ffdf8a; background:rgba(246,201,91,.1); }
    @media(max-width:720px){ body{padding:12px}.admin-hero{align-items:flex-start;flex-direction:column}.admin-brand img{width:46px;height:46px}.admin-nav{width:100%;display:grid;grid-template-columns:1fr 1fr}.admin-nav a{padding:0 10px}.metrics-footnote{text-align:left}.mini-form{grid-template-columns:1fr;min-width:0}.admin-section summary{align-items:flex-start;flex-direction:column}.admin-section summary small{text-align:left}.admin-section summary::after{align-self:flex-start}.section-body{padding:0 12px 14px}.grid{grid-template-columns:1fr}.section-toolbar{align-items:stretch;flex-direction:column}.section-toolbar input{max-width:none} table,thead,tbody,tr,th,td{display:block} thead{display:none} tr{border:1px solid rgba(255,255,255,.08); border-radius:16px; margin-bottom:12px; overflow:hidden} td{border-bottom:1px solid rgba(255,255,255,.06)} td::before{content:attr(data-label);display:block;margin-bottom:4px;color:#ffdf8a;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em} }
    @media(max-width:420px){ .admin-nav{grid-template-columns:1fr} }
  </style>`;
}

export function renderAdminShell({ title = 'Admin Panel', subtitle = 'IntoTheBattle operations', active = 'dashboard', message = '', error = '', createdCode = '', body = '', scripts = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeAdminHtml(title)} - IntoTheBattle Admin</title>
  ${renderAdminStyles()}
</head>
<body>
  <div class="wrapper">
    <header class="admin-hero">
      <div class="admin-brand">
        <img src="/intothebattlelogo_logo_only.svg" alt="IntoTheBattle logo" />
        <div><h1>${escapeAdminHtml(title)}</h1><p>${escapeAdminHtml(subtitle)}</p></div>
      </div>
      ${renderAdminNav(active)}
    </header>
    ${renderAdminNotices({ message, error, createdCode })}
    ${body}
  </div>
  ${scripts}
</body>
</html>`;
}
