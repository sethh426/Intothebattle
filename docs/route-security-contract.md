# Route Security Contract

This is the production route contract for the high-risk IntoTheBattle surface. The machine-readable source is `config/route-security-contract.json`; `npm run test:security:contracts` verifies that the contract and code stay aligned.

## Rules

- Creator dashboard, stream controls, uploads, sponsor controls, and reset endpoints require a valid creator room session.
- Overlay, overlay media, and `/state` require a signed room overlay token.
- Admin pages require an admin session; admin mutations also require same-origin browser request protection.
- PayPal webhooks are the only state-changing cross-origin exception and must verify PayPal signatures.
- Dev/test endpoints must return `404` in production.
- Metrics, diagnostics, and launch readiness require bearer or header tokens in production.

## CSRF-Equivalent Protection

Admin mutations use a layered protection model:

- `HttpOnly`, `SameSite=Strict`, secure admin session cookies in production.
- Global same-origin enforcement for state-changing browser requests.
- Admin-router same-origin enforcement for authenticated mutations.
- PayPal webhook routes are exempt only because they use provider signature verification.

This is the current company-standard baseline. A future token-based CSRF layer can be added, but it must handle multipart admin upload forms without bypassing media validation.
