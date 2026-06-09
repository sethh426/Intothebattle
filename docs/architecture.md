# Architecture

## Current System

Intothebattle / TIKTOKBR is a TikTok LIVE interactive battle overlay platform.

Current runtime flow:

```text
TikTok LIVE
  -> TikTok integration in server.js
  -> Game/event logic
  -> Room manager
  -> PostgreSQL
  -> Socket.IO
  -> Overlay, dashboard, stats clients
```

## Current Backend

The current backend is a Node.js and Express application using:

- Express for HTTP routes
- Socket.IO for real-time overlay/dashboard events
- PostgreSQL for application data
- Redis support for Socket.IO scaling
- PayPal webhooks for subscriptions
- Postmark for email flows
- Prometheus metrics
- Optional Sentry logging

## Current Frontend

Current browser-facing files include:

- overlay.html
- dashboard.html
- home.html
- signup.html
- paywall.html
- stats.html
- theme-samples.html

## Current Persistence

PostgreSQL is the main source of truth for:

- access codes
- users
- rooms
- room settings
- subscriptions
- admin sessions
- player stats where currently implemented

Uploaded files still use disk/object-style storage paths:

- backgrounds/<roomId>
- audio/<roomId>

Legacy JSON persistence is paused because the game layer is planned for a Phaser 4 rewrite.

## Desired Direction

Move toward this structure over time:

```text
src/
  app.js
  server.js
  config/
  db/
  routes/
  controllers/
  services/
  middleware/
  sockets/
  game/
  integrations/
  uploads/
  metrics/
public/
phaser/
docs/
migrations/
tests/
```

## Rules Going Forward

- Do not keep adding major logic to root server.js.
- New backend logic should move into services/controllers/routes over time.
- New persistent application state should go into PostgreSQL.
- Uploaded media should use persistent disk or object storage.
- Dev/test routes must be blocked in production.
- Destructive routes must require auth.
- Metrics should be protected before public production launch.
