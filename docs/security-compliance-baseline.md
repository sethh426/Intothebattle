# Security And Compliance Baseline

This document is a launch baseline, not a certification. IntoTheBattle can enforce strong technical controls in code, but regulated compliance such as SOC 2, PCI DSS, GDPR, CCPA, COPPA, or formal accessibility conformance also requires written policies, vendor records, data retention rules, incident response evidence, and sometimes outside review.

## Enforced In The App

- Authenticated dashboard/API routes use server-side session checks.
- Session cookies are `HttpOnly`, `SameSite`, and `Secure` in production.
- OBS/browser overlay URLs are signed with room-scoped JWTs.
- Socket.IO overlays must present the signed room token before joining a room.
- Room assets, audio, sponsor videos, player state, and live events are scoped to the creator room.
- Cross-origin state-changing browser requests are blocked except explicitly allowed webhooks.
- Protected routes and signed assets send `Cache-Control: no-store`.
- Runtime metrics and diagnostics require bearer/token access in production.
- Stream resets clear old player presence, session state, sponsor breaks, event queues, and runtime epochs.
- Pre-live setup rehearsal is authenticated and room-scoped; it does not create public overlay access.
- Admin mutations are protected by Strict admin session cookies and same-origin request enforcement.
- A machine-checked route security contract covers the highest-risk production endpoints.

## Launch Requirements

- `NODE_ENV=production`
- `APP_BASE_URL=https://intothebattle.com`
- Long random `JWT_SECRET`
- Separate long random `OVERLAY_TOKEN_SECRET`
- `DATABASE_URL` on managed Postgres
- `DISK_PATH` on persistent writable storage
- `TRUST_PROXY_HOPS=1` on Render
- `DIAGNOSTICS_TOKEN` set before enabling launch diagnostics
- `METRICS_TOKEN` set only if Prometheus or another trusted scraper needs `/metrics`
- `POSTMARK_API_TOKEN`, verified `EMAIL_FROM`, and production message stream
- Live PayPal client, plan, mode, and webhook ID
- `SENTRY_DSN` or equivalent error-monitoring DSN
- `METRICS_TOKEN` wired to a trusted scraper
- `INCIDENT_RUNBOOK_URL` or `LAUNCH_RUNBOOK_URL`
- `OPERATIONS_ALERT_EMAIL` or `ALERT_WEBHOOK_URL`
- `BACKUP_RESTORE_VERIFIED_AT` from a successful restore drill

## Regulated Compliance Gaps To Close Before Claiming Compliance

- Publish Privacy Policy, Terms, Cookie Policy, and Refund/Billing Policy.
- Define retention windows for accounts, TikTok usernames, player stats, uploaded files, logs, email events, and sponsor playback reports.
- Add user data export/delete workflow and admin SOP.
- Maintain a subprocessors list for Render, Postmark, PayPal, Google, Microsoft Clarity, GitHub, and analytics/marketing tools.
- Document incident response, access review, backup/restore, vulnerability management, and change control.
- Run `npm run test:security:contracts` and keep the route contract current when adding endpoints.
- Confirm TikTok, PayPal, Postmark, Google OAuth, and Clarity terms match the production use case.
- If children may use the app or streamers target children, complete a COPPA review before launch.
- If taking card data directly in the future, use hosted PayPal/card fields only and complete PCI scope review.

## Engineering Guardrails

- Never expose bare `room_id` overlay access in production.
- Never log session cookies, overlay tokens, OAuth codes, PayPal secrets, Postmark tokens, or API keys.
- Keep creator demo/rehearsal state separate from live TikTok connections.
- On every real TikTok connect, clear old runtime state first.
- Keep sponsor video proof events server-side and room-scoped.
- Keep admin-only growth/marketing automation separate from creator dashboard controls.

## Security References

- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Application Security Verification Standard: https://owasp.org/www-project-application-security-verification-standard/
