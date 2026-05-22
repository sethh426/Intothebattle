# TIKTOKBR

A developer-focused live PvP battle overlay for TikTok LIVE. This project connects TikTok chat and gift events to a real-time battle arena rendered in the browser.

## Project Overview

The system consists of:

- `server.js` — Node.js/Express application that handles TikTok LIVE event ingestion, game state, persistence, and Socket.IO broadcasting.
- `overlay.html` — browser-based overlay that renders the live game state onto a canvas and displays UI panels for status, leaderboard, events, and layout controls.
- `players.json` — optional persistence store for player stats between server restarts.
- `backgrounds/` — directory for uploaded overlay background images.

## Architecture

1. **TikTok LIVE connection**
   - Uses `@tiktool/live` to connect to a TikTok streamer’s LIVE chat.
   - Listens for `member`, `chat`, `gift`, `like`, and `social` events.

2. **Game engine**
   - Maintains `players` state in memory, including HP, strength, kills, position, and alive status.
   - Applies damage, respawns, and buffs from events.
   - Periodically emits game state and movement updates to all connected overlays.
   - Saves persistent player stats to `players.json` every 10 seconds of state updates.

3. **Overlay rendering**
   - Uses Socket.IO to receive `gameState`, `attack`, `giftAttack`, `backgroundChanged`, and other events.
   - Renders a top-20 player grid with HP bars, names, and animated attack visuals.
   - Includes live controls for adjusting horizontal/vertical grid gap and hiding the control panel.

4. **Static UI and API**
   - Serves static files from the project root.
   - Exposes API routes for dashboard control, state access, background uploads, and resets.

## Languages & Systems Used

- JavaScript (Node.js) for backend server logic.
- Express for HTTP routing and static file serving.
- Socket.IO for real-time client-server communication.
- HTML/CSS/Canvas for the overlay frontend.
- `@tiktool/live` for TikTok LIVE integration.
- `multer` for background image uploads.
- `dotenv` for environment variable management.
- File-system persistence with Node `fs`.

## How the Program Connects

- `server.js` starts an Express app and Socket.IO server on port `3000`.
- The overlay page connects to the Socket.IO server and registers as `overlay`.
- When the TikTok LIVE client receives an event, the server updates player state and emits changes.
- The overlay listens for events to update the visual state and draw animations.
- Static pages available:
  - `http://localhost:3000/overlay.html`
  - `http://localhost:3000/dashboard`
  - `http://localhost:3000/stats`
  - `http://localhost:3000/state`

## Game Mechanics

### Player Spawn & State

- Players are spawned when they appear in TikTok chat, gifts, likes, or socials.
- Spawned players receive default values if they are new or re-enter the board when alive.
- The overlay displays only the top 20 alive players sorted by HP, with forced-spawned players prioritized.

### Player Attributes

- `hp` — current hit points.
- `maxHp` — maximum hit points.
- `strength` — damage base for attacks.
- `kills` — number of kills earned.
- `alive` — whether the player is active on the board.
- `messageBoostExpires` — timestamp for gift chat damage boost expiration.
- `forceSpawn` — forced visibility flag for chat-spawned players.

### Event Effects & Damage Rules

The game uses these configured values in `server.js`:

- `BASE_HP`: 100
- `BASE_STRENGTH`: 10
- `CHAT_STRENGTH_BOOST`: +1 strength per chat message received
- `LIKE_HP_BOOST`: +2 HP per like event
- `SOCIAL_STRENGTH_BOOST`: +5 strength per social event
- `GIFT_HP_PER_DIAMOND`: +3 HP per diamond gifted
- `GIFT_STR_PER_DIAMOND`: +1 strength per diamond gifted
- `MESSAGE_LASER_MULTIPLIER`: 2x damage multiplier for mention laser attacks
- `GIFT_MESSAGE_BOOST_MULTIPLIER`: 1.5x additional multiplier for boosted messages
- `GIFT_MESSAGE_BOOST_DURATION_MS`: 45,000ms (45 seconds) of boosted message damage
- `ATTACK_VARIANCE`: 0.4 random variance applied to every attack
- `RESPAWN_DELAY_MS`: 30,000ms (30 seconds) until a killed player respawns
- `IDLE_TIMEOUT_MS`: 600,000ms (10 minutes) to remove idle players
- `RESET_TIMEOUT_MS`: 300,000ms (5 minutes) to reset streamer state

### Chat Damage Flow

- When a chat message contains `@username`, the sender is treated as attacking the mentioned target.
- If the sender is not currently alive, they are auto-spawned first.
- Damage is calculated as:
  - `damage = floor(attacker.strength * multiplier * variance)`
  - `multiplier` is `2` for normal mention lasers
  - if a gift message boost is active, multiplier becomes `2 * 1.5 = 3`
- The attack is emitted via Socket.IO as `attack` with `attacker`, `target`, `damage`, `killed`, and `special`.

### Chat Commands & Message Options

- Special visual commands may be included in chat messages alongside `@username` mentions to request a specific attack animation. Commands are prefixed with `!` (case-insensitive). Examples:
  - `!FIRE` — plays the fire beam effect
  - `!BUBBLES` or `!BUBBLE` — plays the bubble torrent effect
  - `!NEON` — plays the neon hyper-laser
  - `!RIPPLE` — plays the ripple shockwave
  - `!SPHERE` — plays the sphere-mapped plasma
  - `!LASER` — forces the regular laser beam
  - `!SHOT` or `!PROJECTILE` — fires a projectile attack
  - `!GIFT` — renders the gift effect
  - `!BOOM` or `!EXPLOSION` — renders an explosion on hit

- Usage: include the command anywhere in the message together with one or more `@username` mentions. The server will apply the command to the first valid mention found and emit an `attack` event which includes an `effect` field indicating the requested visual. Overlays will honor the `effect` when present and fall back to default animations otherwise.

Examples:

- `@victim !FIRE` — attack `victim` with the fire beam effect
- `!BUBBLES @victim` — attack `victim` with bubble torrent
- `@a @b !NEON` — attacks the first valid mentioned player with neon laser

Note: Effects are cosmetic and do not change damage calculation. Only players present on the top-5 board (or the virtual horde) will produce visible effects on overlays.

### Gift Effects

- Gifts grant the sender:
  - `diamonds * 3` HP (added to current HP and maximum HP)
  - `diamonds * 1` strength
  - a 45-second message damage boost for later chat attacks
- Gift events also trigger instant area damage:
  - the gifter attacks up to 3 random alive players
  - each target takes `diamonds` damage
  - if a target reaches `0` HP, it is marked killed and respawns after 30 seconds
- The server emits `giftAttack` and `giftEffect` events with attack details.

### Like / Social / Member Events

- `like` events:
  - spawn the user if needed
  - apply `+2 HP`
- `social` events:
  - spawn the user if needed
  - apply `+5 strength`
- `member` events:
  - spawn the member and mark them alive immediately

### Respawns & Cleanup

- When HP reaches `0`, the target is killed and removed from alive status.
- The target auto-respawns after 30 seconds with full HP and alive status.
- Idle players are removed from state after 10 minutes of inactivity.

## Developer Setup

### Prerequisites

- Node.js 18+ recommended
- npm installed
- A TikTok API key stored in `.env` as `API_KEY`

### Install

```bash
npm install
```

### Run

```bash
npm start
```

To connect to a TikTok streamer by username, pass the unique ID as an argument:

```bash
node server.js <streamerUsername>
```

### Environment

Create a `.env` file with:

```text
API_KEY=your_tiktok_api_key
```

### Key Endpoints

- `GET /overlay.html` — main overlay view
- `GET /dashboard` — dashboard page
- `GET /stats` — stats page
- `GET /state` — raw JSON game state
- `POST /api/connect` — connect to TikTok streamer
- `POST /api/reset` — disconnect current streamer
- `POST /api/overlay/reload` — force reload overlay pages
- `POST /api/players/clear` — set all players to `alive=false`
- `POST /api/background/upload` — upload overlay background image
- `POST /api/background/clear` — clear current background

## File Summary

- `server.js` — backend logic, event handling, game rules, API routes, persistence
- `overlay.html` — client overlay UI, player rendering, canvas animations, Socket.IO listeners
- `package.json` — project dependencies and startup script
- `players.json` — persisted player stat cache
- `backgrounds/` — uploaded background image storage
- `dashboard.html`, `stats.html` — auxiliary monitoring pages

## Notes for Developers

- The overlay logic uses `forceSpawn` to keep chat-spawned users visible on the top-20 board.
- Positioning is calculated via a 5x4 grid with configurable horizontal/vertical gap sliders.
- Attack events are rendered with animated beams and damage popups.
- Persistent state is intentionally lightweight and only saves nickname, max HP, strength, and kill count.

## Future Improvements

- Add explicit target selection for mentions when multiple similar names exist.
- Store streamer sessions or replay logs for post-stream analysis.
- Improve leaderboard sorting and UI responsiveness for mobile or smaller screens.
- Add tests for damage calculations, spawn logic, and mention parsing.
