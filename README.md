# TIKTOKBR

A TikTok LIVE battle overlay platform with real-time dashboard controls, subscription/paywall support, and Render-friendly persistence.

## Why update the README?

Yes — it should be rewritten now. The project has evolved beyond the original static overlay demo:

- Render deployment support was added
- Disk persistence via `DISK_PATH=/var/data` is now required
- PayPal/subscription and trial flows are in place
- New dashboard, signup, and stats pages exist
- Theme and UI polish are now part of the app

This README now reflects the current system, developer setup, and deployment requirements.

## Project Overview

This project includes:

- `server.js` — Node.js + Express backend for TikTok LIVE ingestion, game state, persistence, and Socket.IO broadcasting.
- `overlay.html` — live game overlay rendered in the browser via Canvas and real-time socket events.
- `dashboard.html` — admin panel for room setup, audio/background uploads, and live system control.
- `signup.html`, `paywall.html`, `home.html` — onboarding and subscription flow pages.
- `tiktokbr/db/db.js` — SQLite database for access codes, room settings, and subscription metadata.
- `roomManager.js` — persistent room storage and file path management for Render disk support.
- `theme-samples.html` — theme preview page for UI direction and button/palette selection.

## Core Features

- Real-time TikTok chat/gift/like/social event processing
- PvP battle arena with HP, strength, kills, and respawn logic
- Overlay rendering for live battle visuals and attack animations
- Dashboard controls for room management and uploads
- Subscription/paywall flow with PayPal integration
- Disk-backed persistence for uploads and SQLite on Render
- Custom theme samples for consistent UI styling

## Deployment (Render)

### Required service settings

- Build command: `npm install`
- Start command: `node server.js`
- Environment variables:
  - `DISK_PATH=/var/data`
  - `API_KEY=<your_tiktok_api_key>`
  - `PAYPAL_CLIENT_ID`
  - `PAYPAL_CLIENT_SECRET`
  - `PAYPAL_WEBHOOK_ID`
  - `NODE_ENV=production`
  - Optional: `SENTRY_DSN`, `LOG_LEVEL`, `API_KEY`, `DEV_TEST_MODE=true`
    - `POSTMARK_API_TOKEN`
    - `APP_BASE_URL=https://intothebattle.com`
    - `EMAIL_FROM=Battle Royale <no-reply@intothebattle.com>`
    - `POSTMARK_TEST_EMAIL=<your_test_email>`

### Disk persistence

- Render should mount a disk at `/var/data`
- The app uses `DISK_PATH` to store:
  - `tiktokbr.db` (SQLite database)
  - audio uploads
  - background image uploads
  - `players_<roomId>.json`
- If `DISK_PATH` is not set, the app falls back to local file-system paths for development only.

### Custom domain

- Add your domain in Render dashboard
- Configure DNS records as Render instructs
- Render provides automatic SSL

### Postmark email testing

- Add `POSTMARK_API_TOKEN` as your Postmark server API token.
- Add `APP_BASE_URL` and `EMAIL_FROM` so verification/reset links generate correctly.
- Add `POSTMARK_TEST_EMAIL` to receive a connectivity test message.
- Run:
  ```bash
  npm run test:postmark
  ```
  This will send a real test email through Postmark.

## Local Development

### Prerequisites

- Node.js 18+ recommended
- npm installed

### Install dependencies

```bash
npm install
```

### Local environment

Create a `.env` file:

```text
API_KEY=your_tiktok_api_key
DISK_PATH=./data
```

> For local development, `DISK_PATH` can point to a directory like `./data`.

### Run locally

```bash
npm start
```

Or if you want to specify a streamer username directly:

```bash
node server.js <streamerUsername>
```

### Run with Docker Compose

The repository includes a `docker-compose.yml` service definition for local development.

```bash
docker-compose up --build
```

This starts:

- `app` on `http://localhost:3000`
- `prometheus` on `http://localhost:9090`

Prometheus is configured from `devops/prometheus/prometheus.yml` and scrapes the app's `/metrics` endpoint.

A local override file `docker-compose.override.yml` also mounts `./data` and sets `DISK_PATH=./data` so uploads and SQLite persist across restarts.

## Important URLs

- `GET /overlay.html` — overlay view
- `GET /dashboard` — admin dashboard
- `GET /stats` — stats page
- `GET /signup` — trial/signup page
- `GET /paywall` — paywall/upgrade page
- `GET /home` — landing page
- `GET /state` — raw JSON game state

## Environment Variables

Required:

- `API_KEY` — TikTok API key or streamer integration token
- `JWT_SECRET` — secret used to sign session tokens
- `DISK_PATH` — persistent storage root (`/var/data` on Render)
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`

Recommended for email flows:

- `POSTMARK_API_TOKEN` — Postmark Server API token for sending verification and password reset emails
- `APP_BASE_URL` — public app URL, e.g. `https://your-app.onrender.com`
- `EMAIL_FROM` — optional sender address, e.g. `Battle Royale <no-reply@yourdomain.com>`

Optional:

- `PAYPAL_PAYMENT_LINK` — custom PayPal purchase link
- `NODE_ENV=production`
- `LOG_LEVEL=info`
- `SENTRY_DSN`
- `DEV_TEST_MODE=true`

## File Structure

- `server.js` — backend server, API routes, game logic, uploads, sockets
- `roomManager.js` — room persistence, file paths, `DISK_PATH` handling
- `tiktokbr/db/db.js` — SQLite initialization and schema
- `overlay.html` — live overlay client
- `dashboard.html` — admin interface
- `signup.html` / `paywall.html` / `home.html` — user flows
- `stats.html` — runtime stats view
- `backgrounds/` — background images
- `audio/` — audio upload files
- `theme-samples.html` — UI theme preview page

## Persistence and storage

The app persists the following data:

- `tiktokbr.db` — subscription, room, and access-code data
- `audio/<roomId>` — uploaded audio files
- `backgrounds/<roomId>` — uploaded background images
- `players_<roomId>.json` — optional player stats files
- room audio config files and metadata in each room folder

## What changed recently

- `DISK_PATH` support was added for Render deployment
- Persistent uploads now use folder paths under the disk mount
- SQLite database is saved to `tiktokbr.db` on the disk
- New UI flow pages exist for signup and paywall
- Theme preview page added for UI selection

## Development Notes

- `getRoomPaths()` now derives file storage from `DISK_PATH`
- `server.js` checks room storage first and falls back to disk-local directories
- PayPal webhook handling is enabled in `tiktokbr/routes/paypal.js`
- Auth and trial enforcement is handled in `tiktokbr/middleware/auth.js` and `checkTrial.js`

## Next work items

- Validate Render deployment and disk persistence
- Add automated tests for audio upload and room persistence
- Polish UI theme across all pages
- Harden PayPal webhook and subscription edge cases
- Add monitoring/logging for runtime production issues
