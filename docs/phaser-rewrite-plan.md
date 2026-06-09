# Phaser 4 Rewrite Plan

## Purpose

The Phaser rewrite is intended to move the battle rendering/game presentation layer into a cleaner JavaScript game framework instead of continuing to grow the current overlay script.

## Current Decision

Legacy JSON player persistence cleanup is paused while the Phaser 4 direction is planned.

PostgreSQL remains the source of truth for platform data such as:

- users
- rooms
- settings
- subscriptions
- access codes
- admin sessions
- persistent player records where currently implemented

## Proposed Folder

```text
phaser/
  README.md
  src/
    main.js
    scenes/
      BootScene.js
      BattleScene.js
      OverlayUIScene.js
    entities/
      PlayerSprite.js
      Projectile.js
      Effect.js
    systems/
      CombatSystem.js
      EffectsSystem.js
      AudioSystem.js
      LayoutSystem.js
    net/
      socketClient.js
    ui/
      healthBars.js
      leaderboard.js
```

## Integration Strategy

Phase 1:

- Keep current overlay.html working.
- Create Phaser proof of concept separately.
- Connect Phaser client to existing Socket.IO events.
- Render simple players, health bars, and attack effects.

Phase 2:

- Replace current overlay rendering with Phaser scene.
- Keep server API stable.
- Add overlay-safe state endpoint if needed.
- Keep dashboard unchanged.

Phase 3:

- Move combat display logic into Phaser systems.
- Keep authoritative game state on server.
- Avoid storing Phaser-only state in PostgreSQL unless needed.

## Rules

- Do not break current overlay while Phaser is experimental.
- Do not restart JSON cleanup until Phaser data needs are clear.
- Keep server events stable where possible.
- Phaser should consume safe public room state, not private account data.
