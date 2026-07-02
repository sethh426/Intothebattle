# Intothebattle / TIKTOKBR

A TikTok LIVE interactive battle overlay platform. Intothebattle turns TikTok LIVE chat activity into a real-time PvP battle experience with overlay visuals, Command Center controls, room-based configuration, subscriptions, and live game state updates.

## Current Project Status

This project is in beta-stability development.

Current focus:

- Stabilize the Node.js/Express backend.
- Keep PostgreSQL as the primary application database.
- Protect dashboard, room, upload, and streamer-control routes.
- Improve onboarding and beta setup reliability.
- Prepare the game/overlay rewrite for the Phaser 4 JavaScript framework.

Important persistence note:

> Legacy JSON/file-based player persistence is intentionally on hold. The active game-layer rewrite is planned around Phaser 4, so JSON cleanup should not be treated as the main sprint blocker right now. PostgreSQL remains the source of truth for users, rooms, settings, subscriptions, access codes, and database-backed player records where currently implemented.

## What This App Does

Intothebattle lets a streamer connect a TikTok LIVE session and display a browser-based battle overlay where viewers can appear as players, gain stats, attack, receive gift-based boosts, trigger effects, and show up on dashboards or live overlays.

Core product areas:

- TikTok LIVE event ingestion.
- Real-time Socket.IO broadcasting.
- Canvas/overlay battle display.
- Command Center controls.
- Room-based overlay configuration.
- Background and audio uploads.
- Trial, access-code, paywall, and PayPal subscription flows.
- Admin access-code and promo-code management.
- Monitoring hooks through Prometheus metrics and optional Sentry logging.

## Tech Stack

Backend:

- Node.js
- Express
- Socket.IO
- `@tiktool/live`
- PostgreSQL through `pg`
- Redis support for future Socket.IO scaling
- JWT-based sessions
- PayPal webhook integration
- Postmark email support
- Prometheus metrics
- Optional Sentry error reporting

Frontend/runtime pages:

- `overlay.html` for the live overlay
- `dashboard.html` for streamer controls
- `home.html` for landing/onboarding
- `signup.html` and `paywall.html` for trial/subscription flows
- `stats.html` for runtime stats
- `theme-samples.html` for visual direction

Game-layer direction:

- Current overlay/game logic still exists in the Node/HTML/Canvas flow.
- A Phaser 4 JavaScript framework rewrite is planned for the next major game-layer iteration.
- JSON persistence work is paused until the Phaser direction is settled.

## Main Files and Folders

```text
server.js                         Main Express server, API routes, sockets, TikTok connection, uploads, game logic
roomManager.js                    Room lifecycle, room settings, upload paths, in-memory room registry
tiktokbr/db/db.js                 PostgreSQL connection wrapper and schema bootstrapping
tiktokbr/db/schema.sql            Database schema for access codes, users, rooms, subscriptions, player stats, admin sessions
tiktokbr/routes/auth.js           Auth, login/signup, Google OAuth, email/password, promo/trial flows
tiktokbr/routes/admin.js          Admin panel routes for codes, promos, room requirement toggle, admin sessions
tiktokbr/routes/paypal.js         PayPal webhook and subscription/code handling
tiktokbr/middleware/auth.js       Access-code/user session gate for protected pages
tiktokbr/middleware/checkTrial.js Trial/subscription gate for dashboard and stats
overlay.html                      Live battle overlay
dashboard.html                    Streamer dashboard
home.html                         Landing page
signup.html                       Signup/trial page
paywall.html                      Paywall/upgrade page
stats.html                        Stats view
Dockerfile                        Production container definition
docker-compose.yml                Local app + Postgres + Redis + Prometheus stack
devops/prometheus/                Prometheus configuration
```

## Local Development

### Prerequisites

- Node.js 24
- npm
- PostgreSQL connection string, or Docker Compose
- TikTok API key/integration token

### Install

```bash
npm install
```

### Environment

Create a `.env` file for local development:

```text
NODE_ENV=development
PORT=3000
API_KEY=your_tiktok_api_key
JWT_SECRET=replace_with_a_long_random_secret
DATABASE_URL=postgres://postgres:example@localhost:5432/tiktokbr
REDIS_URL=redis://localhost:6379
ENABLE_ROOM_SCOPED=true
APP_BASE_URL=http://localhost:3000
WRITEFREELY_PUBLIC_URL=http://localhost:8080/
```

`OVERLAY_TOKEN_SECRET` is optional locally and recommended in production. If it is not set, signed overlay URLs use `JWT_SECRET`.

Payment/email variables are only needed when testing those flows:

```text
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_PLAN_ID=
PAYPAL_MODE=live
PAYPAL_CURRENCY=USD
PAYPAL_WEBHOOK_ID=
PAYPAL_PAYMENT_LINK=
POSTMARK_API_TOKEN=
POSTMARK_MESSAGE_STREAM=outbound
EMAIL_FROM=IntoTheBattle <no-reply@example.com>
EMAIL_REPLY_TO=support@example.com
POSTMARK_TEST_EMAIL=
```

`PAYPAL_PLAN_ID` (or `PAYPAL_SUBSCRIPTION_PLAN_ID`) is required for the in-app Creator Pro subscription button. `PAYPAL_PAYMENT_LINK` is only a hosted-link fallback.

Production observability/diagnostic variables:

```text
SENTRY_DSN=
LOG_LEVEL=info
DEV_TEST_MODE=false
DISK_PATH=/var/data
TRUST_PROXY_HOPS=1
CLARITY_PROJECT_ID=
METRICS_TOKEN=replace_with_a_metrics_scrape_token
DIAGNOSTICS_TOKEN=
MARKETING_PLATFORMS=x,linkedin,facebook,instagram,tiktok,youtube_shorts
MARKETING_AUTOMATION_ENABLED=false
MARKETING_AUTO_POST_ENABLED=true
MARKETING_DRY_RUN=true
MARKETING_OUTBOUND_WEBHOOK_URL=
GROWTH_API_SYNC_ENABLED=false
HUBSPOT_PRIVATE_APP_TOKEN=
HUBSPOT_SOURCE_PROPERTY=
HUBSPOT_LAST_PATH_PROPERTY=
HUBSPOT_TIKTOK_PROPERTY=
SEGMENT_WRITE_KEY=
```

`CLARITY_PROJECT_ID` enables Microsoft Clarity only in production. Leave it blank to disable browser analytics.

`METRICS_TOKEN` is only needed if Prometheus or another monitor scrapes `/metrics`. In production, `/metrics` returns 404 when no token is configured.

`DIAGNOSTICS_TOKEN` is required for the production launch-readiness gate. `/api/runtime/diagnostics` can fall back to `METRICS_TOKEN`, but production launch checks should use a separate diagnostics token.

Sponsor video uploads can use FFmpeg/ffprobe when those tools are installed on the server:

```text
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
SPONSOR_TRANSCODE_ENABLED=true
SPONSOR_TRANSCODE_PRESET=veryfast
SPONSOR_TRANSCODE_CRF=23
SPONSOR_STRICT_MEDIA_GATE=true
SPONSOR_VIDEO_MAX_SECONDS=120
SPONSOR_VIDEO_RECOMMENDED_MAX_SECONDS=30
SPONSOR_VIDEO_MAX_MB=100
SPONSOR_VIDEO_MIN_WIDTH=1280
SPONSOR_VIDEO_MIN_HEIGHT=720
```

With those tools available, uploaded sponsor videos are normalized to MP4 H.264/AAC at 16:9 720p, probed for duration/codec/resolution, and given server-side thumbnails. In production, the media gate blocks empty files, oversized videos, videos longer than the configured max, very low-resolution uploads, and unsafe formats that cannot be normalized before OBS sees them. Non-ideal but playable files stay usable with dashboard/admin quality warnings and recommendations.

### Company Growth Outbox

The app includes an admin-only company growth workflow at `/admin/marketing`. It is for IntoTheBattle-owned sales channels and outreach, not streamer accounts or Command Center controls. It generates daily SEO and UTM-tagged post drafts from public site pages, then requires approval before anything can be published. Live publishing is intentionally disabled unless all of these are true:

```text
MARKETING_AUTOMATION_ENABLED=true
MARKETING_AUTO_POST_ENABLED=true
MARKETING_DRY_RUN=false
MARKETING_OUTBOUND_WEBHOOK_URL=<authorized Make/Zapier/n8n/webhook>
```

`MARKETING_AUTO_POST_ENABLED` defaults to the same value as `MARKETING_AUTOMATION_ENABLED`. In production that means the scheduler starts automatically once live publishing is configured; set `MARKETING_AUTO_POST_ENABLED=false` to keep manual publishing only.

You can also use platform-specific webhooks such as `MARKETING_WEBHOOK_X`, `MARKETING_WEBHOOK_LINKEDIN`, `MARKETING_WEBHOOK_INSTAGRAM`, `MARKETING_WEBHOOK_TIKTOK`, and `MARKETING_WEBHOOK_YOUTUBE_SHORTS`.

Useful commands:

```bash
npm run marketing:generate
npm run marketing:publish:dry-run
npm run marketing:publish
```

The scheduled GitHub workflow `.github/workflows/marketing-automation.yml` runs daily at 14:00 UTC. It skips safely unless the `MARKETING_DATABASE_URL` repository secret is configured. For live publishing, configure authorized outbound webhook secrets and set repository variables `MARKETING_AUTOMATION_ENABLED=true` and `MARKETING_DRY_RUN=false`.

Optional company growth APIs:

- `HUBSPOT_PRIVATE_APP_TOKEN` syncs signup-intent leads into HubSpot CRM contacts.
- HubSpot sync sends only standard contact fields by default. Set `HUBSPOT_SOURCE_PROPERTY`, `HUBSPOT_LAST_PATH_PROPERTY`, and `HUBSPOT_TIKTOK_PROPERTY` only after creating matching custom contact properties in HubSpot.
- `SEGMENT_WRITE_KEY` sends server-side identify/track events for signup-intent and manual growth tests.
- `GROWTH_API_SYNC_ENABLED=true` must be set before any provider calls are made.
- `POST /api/runtime/growth-sync-test` lets an admin test the integration with `Authorization: Bearer <DIAGNOSTICS_TOKEN>` or `METRICS_TOKEN`.

The Company Growth page also includes a creative template engine for admin-owned content:

- Template library: repeatable hooks, proof blocks, CTAs, landing pages, platform copy limits, and safe-zone guidance.
- Asset vault: approved real overlay clips, screenshots, sponsor-break clips, dashboard shots, logos, and generated backgrounds.
- Quality gate: conversion templates require approved proof assets, tracked UTM URLs, CTA presence, and matching image/video asset types before queueing.
- Variant builder: creates structured hook/proof/CTA drafts with UTM links, frame timing, safe zones, visual prompts, hashtags, and SEO metadata, then requires admin approval before sending anything into the marketing queue.
- Queue guardrails: duplicate variants are skipped, queued variants are revalidated against the latest asset status, and published creative posts are not overwritten.

### Run locally with Node

```bash
npm start
```

Or pass a streamer username directly:

```bash
node server.js <streamerUsername>
```

### Run locally with Docker Compose

```bash
docker-compose up --build
```

This starts:

- app: `http://localhost:3000`
- PostgreSQL: `postgres://postgres:example@postgres:5432/tiktokbr`
- Redis: `redis://redis:6379`
- Prometheus: `http://localhost:9090`

The Docker Compose stack is currently the easiest way to run the full local service because it brings up Postgres, Redis, and Prometheus together.

## Database

The app currently uses PostgreSQL. `tiktokbr/db/db.js` requires one of these connection variables:

```text
DATABASE_URL
PG_CONNECTION_STRING
PG_CONN_STRING
```

The schema includes:

- `access_codes`
- `promo_codes`
- `app_settings`
- `users`
- `user_rooms`
- `subscriptions`
- `admin_sessions`
- `room_settings`
- `marketing_posts`
- `marketing_publish_events`
- `growth_api_events`
- `growth_creative_assets`
- `growth_creative_variants`
- `platform_sponsor_creatives`
- `sponsor_playback_events`
- `live_sessions`
- `room_player_stats`
- `global_player_stats`

Current technical debt:

- Schema bootstrapping and `ALTER TABLE` patches are still handled in `db.js`.
- Future work should move this into versioned migrations.
- Runtime player state is stored in the database and reset per live stream; legacy flat-file player snapshots are no longer loaded.
- Full JSON cleanup is paused until the Phaser 4 rewrite direction is ready.

## Runtime Storage

`DISK_PATH` is still useful for uploaded files, especially on Render or another persistent-disk host.

Expected persistent file storage:

```text
backgrounds/<roomId>/             Uploaded background images
audio/<roomId>/                   Uploaded audio files
```

## Important URLs

Public/user-facing pages:

```text
GET /home
GET /
GET /login
GET /signup
GET /paywall
GET /blog and /updates render the local blog index
GET /my-code
GET /overlay or /overlay.html with signed room_id + overlay_token for OBS/browser-source access
GET /overlay-preview for public demo/recording footage without room auth
```

Protected creator pages:

```text
GET /dashboard
GET /dashboard/welcome (compatibility redirect to /dashboard?welcome=1)
GET /stats
GET /profile
```

Admin pages:

```text
GET /admin/login
GET /admin
GET /admin/sponsors
GET /admin/marketing
```

Health/monitoring:

```text
GET /api/status
GET /api/subscription/status
GET /metrics (requires METRICS_TOKEN in production)
GET /api/runtime/diagnostics (requires DIAGNOSTICS_TOKEN or METRICS_TOKEN in production)
POST /api/runtime/email-test (requires DIAGNOSTICS_TOKEN or METRICS_TOKEN in production)
POST /api/runtime/growth-sync-test (requires DIAGNOSTICS_TOKEN or METRICS_TOKEN in production)
```

## Route Security Direction

Routes should be grouped into clear categories:

1. Public marketing/onboarding pages.
2. Auth and signup endpoints.
3. Creator/session-protected dashboard routes.
4. Room-protected API routes.
5. Admin-only routes.
6. Webhook routes verified by provider signature.
7. Development/test routes disabled or locked down in production.

Current audit priority:

- Confirm every mutation route has the right middleware.
- Lock down `/api/reset` and dev/test endpoints.
- Decide whether `/metrics` should be public, IP-restricted, or token-protected in production.
- Confirm unauthenticated `room_id` overlay access is intentional.
- Confirm public asset routes cannot expose files outside their room folders.

## Deployment Notes

### Render-style deployment

Minimum production settings:

```text
Build command: npm install
Start command: node server.js
NODE_ENV=production
API_KEY=<TikTok API key/integration token>
JWT_SECRET=<long random secret>
DATABASE_URL=<managed PostgreSQL connection string>
APP_BASE_URL=https://intothebattle.com
```

Recommended production settings:

```text
REDIS_URL=<managed Redis connection string>
ENABLE_REDIS_ADAPTER=true
SENTRY_DSN=<Sentry DSN or equivalent error monitor DSN>
LOG_LEVEL=info
DISK_PATH=/var/data
TRUST_PROXY_HOPS=1
CLARITY_PROJECT_ID=x82yl0ggk3
WRITEFREELY_PUBLIC_URL=https://blog.intothebattle.com/   # optional external publishing target
PAYPAL_CLIENT_ID=<PayPal client id>
PAYPAL_CLIENT_SECRET=<PayPal client secret>
PAYPAL_PLAN_ID=<PayPal subscription plan id>
PAYPAL_MODE=live
PAYPAL_CURRENCY=USD
PAYPAL_WEBHOOK_ID=<PayPal webhook id>
POSTMARK_API_TOKEN=<Postmark token>
POSTMARK_MESSAGE_STREAM=outbound
EMAIL_FROM=IntoTheBattle <no-reply@intothebattle.com>
EMAIL_REPLY_TO=support@intothebattle.com
OVERLAY_TOKEN_SECRET=<long random overlay signing secret>
ENABLE_ROOM_SCOPED=true
METRICS_TOKEN=<long random metrics scrape token>
DIAGNOSTICS_TOKEN=<separate launch diagnostics token>
SUPPORT_EMAIL=support@intothebattle.com
INCIDENT_RUNBOOK_URL=<internal incident-response runbook URL>
OPERATIONS_ALERT_EMAIL=<ops alert email or paging route>
BACKUP_RESTORE_VERIFIED_AT=<ISO timestamp from the last successful restore drill>
MARKETING_PLATFORMS=x,linkedin,facebook,instagram,tiktok,youtube_shorts
MARKETING_AUTOMATION_ENABLED=false
MARKETING_AUTO_POST_ENABLED=true
MARKETING_DRY_RUN=true
MARKETING_OUTBOUND_WEBHOOK_URL=<optional authorized outbound webhook>
GROWTH_API_SYNC_ENABLED=false
HUBSPOT_PRIVATE_APP_TOKEN=<optional HubSpot private app token>
HUBSPOT_SOURCE_PROPERTY=<optional custom contact property internal name>
HUBSPOT_LAST_PATH_PROPERTY=<optional custom contact property internal name>
HUBSPOT_TIKTOK_PROPERTY=<optional custom contact property internal name>
SEGMENT_WRITE_KEY=<optional Segment source write key>
```

`ENABLE_ROOM_SCOPED` defaults to `true` in production when unset. Set it explicitly if your host makes env behavior easier to audit.

`OVERLAY_TOKEN_SECRET` can be added later; until then, overlay URLs are signed with `JWT_SECRET`. `METRICS_TOKEN` can also be added later if you are not scraping `/metrics` yet.

Postmark production setup:

- Use a Postmark Server API token in `POSTMARK_API_TOKEN`.
- Verify `intothebattle.com` or the exact `no-reply@intothebattle.com` sender signature in Postmark before sending.
- Keep transactional app emails in the `outbound` Message Stream unless you create a dedicated transactional stream and set `POSTMARK_MESSAGE_STREAM` to that stream ID.
- Set `POSTMARK_TEST_EMAIL` locally or temporarily on Render when running `npm run test:postmark`.
- Check `/api/runtime/diagnostics` with `Authorization: Bearer <diagnostics-or-metrics-token>` for the `email` block; it reports whether the token, sender, stream, and base URL are configured without exposing secrets.
- Send a live production test with `POST /api/runtime/email-test`, `Authorization: Bearer <diagnostics-or-metrics-token>`, and JSON body `{"to":"you@example.com"}`. It returns the Postmark message id or the provider error without exposing secrets.

Use a managed PostgreSQL service for production. Do not rely on local JSON files or ephemeral app storage for production state.

Render recovery checks:

```bash
curl -fsS https://www.intothebattle.com/healthz
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://www.intothebattle.com/api/runtime/diagnostics
```

The diagnostics response reports runtime bind settings, whether required secrets are present, storage writability under `DISK_PATH`, and the background database connection state. It never returns secret values.

## CI & Deployment Guidance

This project uses GitHub Actions (`.github/workflows/ci.yml`) as the canonical CI gate and Render as the primary backend deployment target. Vercel may be connected for frontend previews — if Vercel statuses are noisy or not part of your production flow consider disabling its GitHub commit status integration.

- CI behavior:
	- The `CI` workflow runs on pushes to `main` and PRs and performs:
		- `npm ci` (install dependencies)
		- `node --check server.js` (syntax check)
		- a short startup smoke test that launches the server and probes `GET /healthz`
		- `npm run validate:schemas` (JSON-LD schema validation)
		- `npm run test:http` (local HTTP smoke tests with stub DB and temp storage)
		- `npm run test:socket` (signed overlay/dashboard Socket.IO room-routing smoke tests)
		- `npm run test:e2e` (Chromium Playwright visual smoke tests)
		- `npm audit --audit-level=high` (non-blocking)

- Local reproduction steps (recommended):

```bash
npm ci
python -m pip install -r requirements-dev.txt
node --check server.js
npm run validate:schemas
npm run test:http
npm run test:socket
npm run test:e2e:install
npm run test:e2e
# start the server and verify health endpoint
PORT=3000 npm start &
curl -fsS http://localhost:3000/healthz
```

- Render notes:
	- Render (or other PaaS) expects your process to bind the port in `process.env.PORT`.
	- The `Dockerfile` and healthchecks should probe the runtime `PORT` (not a hard-coded `3000`) to avoid false container health failures.

- Vercel notes:
	- Vercel status checks are useful for frontend previews but can add noise on backend-focused repositories.
	- If Vercel is not part of your production flow, disable its GitHub integration or restrict which branches it reports on.

- CI improvements added:
	- A `node --check server.js` syntax step and a `/healthz` smoke test were added to `.github/workflows/ci.yml` to catch early runtime/syntax issues and provide server logs on failure.

If you want, I can also add a small GitHub Actions job that posts the failing job's tail logs to a GitHub issue automatically when a run fails.

## Available Scripts

```bash
npm start
npm run start:dev
npm run test:http
npm run test:e2e
npm run test:security:contracts
npm run test:company:full
npm run test:production:smoke
npm run test:e2e:install
npm run test:postmark
npm run validate:schema
npm run validate:schema-expand
npm run validate:schemas
```

The project now has baseline automated smoke coverage for startup, protected routes, signed overlay access, schema validation, and browser-visible page rendering. It should still expand into deeper route tests, auth tests, upload tests, persistence tests, and mocked integration tests for TikTok, PayPal, Postmark, and Google OAuth.

## Immediate Sprint Priorities

1. Route audit and protection cleanup.
2. README and architecture documentation cleanup.
3. CI workflow for install/schema validation.
4. PostgreSQL migration discipline.
5. Onboarding flow audit.
6. Phaser 4 rewrite planning for the game/overlay layer.
7. PayPal webhook edge-case hardening.
8. Production monitoring and metrics access control.

## Development Rules Going Forward

- New application state should go into PostgreSQL unless it is a user-uploaded file.
- Uploaded audio/background files belong in persistent disk/object storage.
- JSON game-state cleanup is paused until Phaser 4 rewrite planning is complete.
- Admin, streamer-control, upload, and destructive API routes must be protected.
- Dev/test endpoints must not be available in production unless explicitly protected.
- Database schema changes should move toward versioned migrations instead of ad-hoc startup patches.
