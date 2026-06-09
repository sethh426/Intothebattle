# Route Audit

This file tracks route security and cleanup work.

## Risk Levels

- Critical: destructive, billing, admin, or streamer-control route exposed without proper protection
- High: can modify room/game state, uploads, sessions, or production behavior
- Medium: exposes operational or room state
- Low: public marketing/static route

## Initial Findings

| Method | Route | Purpose | Current Status | Risk | Recommendation |
|---|---|---|---|---|---|
| POST | /api/reset | Disconnect streamer | Previously unprotected | Critical | Require room/session auth |
| POST | /api/connect | Connect TikTok streamer | Protected by requireRoom | High | Keep protected |
| POST | /api/players/clear | Clear active players | Protected by requireRoom | High | Keep protected |
| POST | /api/background/upload | Upload background | Protected by requireRoom | High | Keep protected, validate file type/size |
| POST | /api/background/clear | Clear background | Protected by requireRoom | High | Keep protected |
| GET | /api/audio | Get room audio config | Protected by requireRoom | Medium | Keep protected |
| POST | /api/audio/upload | Upload audio | Protected by requireRoom | High | Keep protected, validate file type/size |
| POST | /api/audio/assign | Assign audio event | Protected by requireRoom | High | Keep protected |
| DELETE | /api/audio/delete/:filename | Delete uploaded audio | Protected by requireRoom | High | Keep protected |
| GET | /metrics | Prometheus metrics | Public currently | Medium | Add token, IP allowlist, or private network |
| GET | /state?room_id= | Public room state access | Public by room_id | Medium | Replace with overlay-safe state payload |
| POST | /api/dev/test-mode | Toggle dev mode | Needs stronger guard | High | Block in production and require auth outside local dev |
| POST | /api/dev/sound | Trigger dev sound | Needs stronger guard | Medium | Block in production |
| POST | /api/dev/sound-settings | Trigger sound settings | Needs stronger guard | Medium | Block in production |
| GET | /api/test/status | Test mode status | Public currently | Low/Medium | Block in production or return minimal info |
| POST | /api/test/spawn | Spawn test players | DEV_TEST_MODE only | Medium | Also block in production |
| POST | /api/test/attack | Trigger test attack | DEV_TEST_MODE only | Medium | Also block in production |
| POST | /api/test/gift | Trigger test gift | DEV_TEST_MODE only | Medium | Also block in production |
| POST | /api/paypal/webhook | PayPal webhook | Signature verified | Critical | Keep signature verification and add logging/tests |
| GET/POST | /admin/* | Admin panel/actions | Admin session protected | Critical | Keep protected; consider CSRF protection |

## Next Route Audit Tasks

1. Add tests proving protected routes reject unauthenticated requests.
2. Add production guard for every dev/test endpoint.
3. Decide whether metrics should use METRICS_TOKEN.
4. Split raw /state into /api/overlay/state with safe output only.
5. Add CSRF protection to admin form posts.
6. Document which routes are intentionally public.
