# IntoTheBattle Launch Checklist

Use this checklist before each production launch or major deploy. The goal is simple: confirm payment, email, storage, overlay, and sponsor media are ready before a creator or viewer finds the problem first.

## Automated Gates

Run these before pushing a release:

```bash
npm ci
node --check server.js
npm run audit:stability
npm run validate:schemas
npm run test:logic
npm run test:http
npm run test:socket
npm run test:e2e
```

Run local launch readiness:

```bash
npm run launch:check:local
```

Run production launch readiness after deploy:

```bash
DIAGNOSTICS_TOKEN=your-token npm run launch:check:remote
```

The production readiness endpoint is protected at `/api/runtime/launch-readiness` and should be called with `Authorization: Bearer <token>` or `x-diagnostics-token`. Do not put production tokens in query strings.

## Required Production Environment

- `NODE_ENV=production`
- `APP_BASE_URL=https://www.intothebattle.com`
- `DATABASE_URL`
- `DISK_PATH=/var/data`
- `JWT_SECRET`
- `OVERLAY_TOKEN_SECRET`
- `API_KEY`
- `DIAGNOSTICS_TOKEN`
- `POSTMARK_API_TOKEN`
- `POSTMARK_MESSAGE_STREAM=outbound`
- `EMAIL_FROM=IntoTheBattle <no-reply@intothebattle.com>`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MODE=live`
- `PAYPAL_PLAN_ID`
- `PAYPAL_WEBHOOK_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI=https://www.intothebattle.com/auth/google/callback`

Optional public blog redirect:

- `WRITEFREELY_PUBLIC_URL=https://blog.intothebattle.com/`

Optional storage controls:

- `STORAGE_LIMIT_MB`
- `STORAGE_MIN_FREE_MB`
- `BACKGROUND_UPLOAD_MAX_MB`
- `AUDIO_UPLOAD_MAX_MB`
- `SPONSOR_UPLOAD_MAX_MB`
- `PLATFORM_SPONSOR_UPLOAD_MAX_MB`

## Manual Production Smoke

- `/healthz` returns `200 ok`.
- Home, signup, login, paywall, sponsor, and blog redirect pages load.
- Logged-out `/api/status` returns `401`.
- Signup sends verification email through Postmark.
- Login with Google reaches the dashboard.
- PayPal subscription returns to the success page, activates the account, and webhook events verify.
- Dashboard image, audio, and creator sponsor uploads either fit within the frame or fail with a clear storage/format message.
- Admin sponsor creative uploads show metadata, thumbnail, readiness, and storage warnings.
- Admin "Preview" and "Run Live" use the actual overlay and report playback events.
- Signed overlay URL includes `room_id` and `overlay_token`, connects, and plays sponsor breaks without blank media.

## Launch Stop Conditions

Do not launch if any of these are true:

- Persistent disk is not writable or has less than the configured reserve.
- PayPal is not in live mode for production.
- Postmark diagnostics say email is disabled, missing, or using a placeholder.
- Google redirect URI does not match production exactly.
- `/api/runtime/launch-readiness` has hard failures.
- Sponsor videos cannot reach `ready`, `started`, `first_frame`, and `completed` events during a live overlay test.
