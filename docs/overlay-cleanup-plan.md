# IntoTheBattle Overlay Cleanup Plan

## Current Decision

Use `overlay.html` as the only production overlay renderer.

The server already treats `overlay.html` as the canonical renderer for:

- `/overlay`
- `/overlay.html`
- `/overlay-preview`
- `/overlay-preview.html`
- `/overlay-demo`
- `/overlay-demo.html`

That means dashboard links, signed OBS URLs, homepage previews, and demo routes should all resolve to the same current renderer.

## File Roles

### `overlay.html`

Status: **canonical production overlay**

This is the file the app should use for all live overlay, preview, and demo routes. Any future Phaser/stage/event-system work should happen here or in shared JS modules loaded by this file.

### `overlay-phaser.html`

Status: **deprecated compatibility alias**

This used to be a separate Phaser experiment. Keeping it as a full alternate overlay creates confusion because it competes with `overlay.html` and can drift from the production implementation.

It has been converted into a redirect/compatibility page that preserves query parameters and sends users to `/overlay`.

### `overlay-legacy.html`

Status: **archived legacy reference**

This is the older overlay reference. It should not be linked from the dashboard, homepage, or onboarding flow. Keep it only as a temporary fallback while the current overlay is stabilized.

Recommended future move:

```txt
archive/overlay-legacy.html
```

or delete it after we confirm nothing needs to be recovered from it.

## Recommended Next Step

Do not keep three active overlay implementations. The repo should have:

```txt
overlay.html                 # current production renderer
overlay-phaser.html          # compatibility redirect only
overlay-legacy.html          # archived reference, not active
```

Future cleanup should extract shared overlay code into:

```txt
js/overlay/
  stage-config.js
  OverlayStageScene.js
  OverlayEventController.js
  OverlayTransitionManager.js
  overlay-normalizers.js
```

## Phaser Rewrite Direction

The Phaser rewrite should not live as a separate root HTML page forever. Instead, it should become the production renderer inside `overlay.html`.

The intended future architecture is:

```txt
overlay.html
└── loads shared overlay modules
    ├── fixed 1280x720 stage config
    ├── player slots
    ├── event controller
    ├── transition manager
    └── sponsor/gift/kill scene transitions
```

## Route Rule

All public and dashboard overlay links should point to:

```txt
/overlay
```

Preview/demo links should use:

```txt
/overlay-preview?demo=1&controls=0
```

Avoid linking directly to:

```txt
overlay-phaser.html
overlay-legacy.html
```

## Why This Matters

Keeping three real overlays causes bugs because changes may be made in one file while the dashboard, homepage, or OBS route serves another. The clean model is one production renderer, one preview route, and one archived fallback.
