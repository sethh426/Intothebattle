# TikTok Native Overlay Feasibility Research

Last checked: 2026-07-07

## Finding

No public TikTok developer document found in this pass exposes a third-party API that places a custom app surface on TikTok LIVE's native gift-animation layer. Treat native viewer-only battle rendering as approval-dependent until TikTok confirms an official LIVE/effect-plane capability in App Management.

The documented developer surfaces are currently useful for account identity, videos, webhooks, content posting, mini games, and app review. They do not describe a real-time LIVE gift/effect injection endpoint or a viewer-only overlay plane for external apps.

## Source Notes

- TikTok for Developers lists developer kits and API references such as Login Kit, Share Kit, Green Screen Kit, Display API, Content Posting API, and Research API. It does not list a public LIVE overlay/effect-layer API on the overview page: https://developers.tiktok.com/doc/overview
- Display API is HTTP-based profile/video access through `/v2/user/info/`, `/v2/video/list/`, and `/v2/video/query/`; it is not a live rendering surface: https://developers.tiktok.com/doc/display-api-overview
- TikTok Webhooks deliver HTTPS POST notifications to a callback URL and require idempotent handling; they are not a render plane: https://developers.tiktok.com/doc/webhooks-overview/
- TikTok Mini Games run inside TikTok and require app/code review. They may be relevant to future TikTok-native game distribution, but the public docs describe a launched mini game experience, not a LIVE gift-animation overlay plane: https://developers.tiktok.com/doc/mini-games-overview
- Mini game release requires code upload, TikTok preview, review, and release; this is a separate track from a creator's live stream overlay: https://developers.tiktok.com/doc/submit-your-app-for-review
- TikTok Support describes LIVE Gifts as viewer interactions with a creator's LIVE stream. It does not expose third-party rendering controls for the gift animation layer: https://support.tiktok.com/en/live-gifts-wallet/tiktok-live/live-gifts-on-tiktok

## Delivery Path Matrix

| Path | Feasibility | Streamer sees it? | Viewer sees it? | Notes |
| --- | --- | --- | --- | --- |
| Native TikTok gift/effect layer | Unknown / not publicly documented | Ideally no | Ideally yes | Needs TikTok partner confirmation. Do not build against assumptions. |
| TikTok Studio Link/browser source | Likely testable now | Likely yes in preview/source controls | Likely yes if included in scene | Use signed `/overlay/mobile` or `/overlay` URL and test ordering against native Gifts. |
| OBS/RTMP browser source | Supported by current app flow | Yes in OBS preview | Yes in program output | Best current path for full battle overlay. |
| TikTok Mini Game runtime | Research / future product track | App/game context, not necessarily creator stream | Users launch in TikTok | Could become a separate interactive game product, not a proven live overlay plane. |
| Streamer-private mobile rail | Buildable now | Yes, intentionally minimal | No, unless captured by stream | Use `/overlay/mobile` as a compact status aid while TikTok chat PiP remains separate. |

## TikTok App Review Questions

Ask TikTok directly during app management/review:

1. Is there an approved third-party surface for rendering custom game state on the same viewer plane as LIVE Gift animations?
2. Can a third-party app render viewer-visible LIVE overlays without appearing in the streamer's own preview or phone screen?
3. If the answer is Mini Games, can a Mini Game be attached to an active creator LIVE stream and receive live gift/comment/like events?
4. Are there documented LIVE event APIs for comments, gifts, likes, follows, shares, and LIVE state, or must account linking remain separate from live event handling?
5. What review evidence is required for overlay URLs, trusted domains, callback URLs, and real-time event handling?

## Practical Validation Protocol

Run this before claiming TikTok-native overlay support:

1. Start a private/test TikTok LIVE session with the approved test account.
2. Add a signed IntoTheBattle mobile rail URL as a TikTok Studio Link/browser source if available.
3. Send a gift from a second test account.
4. Record the streamer device, TikTok Studio preview, and viewer device simultaneously.
5. Confirm whether the IntoTheBattle source renders above, below, or separate from native gift animations.
6. Confirm whether the streamer can hide the source locally while viewers still see it.
7. Repeat with the full `/overlay` source and with `/overlay/mobile?layout=pip-corner`.

## Current Product Direction

Until TikTok confirms a native gift/effect layer, `/overlay/mobile` should stay streamer-only and minimal:

- Show KOs, Gifts, like surges, Arena Power, boss waves, winners, and session state.
- Include a tiny scrolling comment crawl when comments are available.
- Keep normal chat out of the primary signal card; routine attacks, follows, joins, and command spam should not displace KOs, Gifts, like surges, Arena Power, or boss moments.
- Preserve screen space for creators who are gaming or managing TikTok chat PiP.
- Keep the full battle overlay on `/overlay` and `/overlay-preview`.
