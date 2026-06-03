## Plan: Complete Overlay + Dashboard + Subscription Roadmap

TL;DR: Build a production-ready app by polishing the overlay/dashboard UX, connecting page flows, hardening real-time sync, and completing subscription/trial/paywall onboarding. The goal is a full end-to-end experience from landing page through live overlay control and paid access.

**Phases**
1. Architecture stabilization
2. Overlay polish and screen framing
3. Dashboard/admin completion
4. Subscription, onboarding, and paywall flow
5. Verification and deployment readiness
6. Optional Phaser 4 rewrite path

---

### Phase 1: Architecture stabilization

1. Confirm the current page flow and live state sync.
   - `overlay.html`: canvas render loop, banner system, audio playback, player/horde layout, local settings.
   - `dashboard.html`: admin controls, socket registration, audio manager, API hooks.
   - `server.js`: socket auth, `/overlay` routing, `dashboard`/`stats` registration, room state, API endpoints, `/paywall`, `/paywall-link`, `/my-code`, and `/signup` routes.
   - `roomManager.js`: persistent room settings, audio config, background storage, overlay settings storage.
2. Ensure overlay routing is robust.
   - `app.get(['/overlay.html', '/overlay'])` must allow unauthenticated overlays with `?room_id=`.
   - Confirm socket auth can accept overlay clients via room ID and register them as `overlay`.
3. Ensure dashboard and overlay share the same live event state.
   - `overlay` should receive `audioConfig`, `overlaySettings`, `backgroundChanged`, and `gameState` when it connects.
   - `dashboard` must receive `overlayCount`, `overlaySettings`, `laserColor`, and `gameState`.
4. Define missing backend sync fixes.
   - Validate `emitRoomEvent` emits to the correct room namespace for overlay and dashboard.
   - Confirm `overlayCount` updates on disconnect and reconnect.

### Phase 2: Overlay polish and screen framing

1. Redesign `overlay.html` around a single unified broadcast screen.
   - Turn `#overlay-container` into a glass-bezel screen with subtle depth and a cohesive frame.
   - Bring banners inside the screen scene so they appear as part of the overlay, not floating page UI.
   - Consolidate player cards and the horde summary into one visually unified layer.
2. Improve layout and position logic.
   - Optimize player card placement and `THE HORDE` position to feel intentional and centered.
   - Make the overlay appear like a modern broadcast panel rather than simply a canvas with controls.
3. Add a second advertising banner inside the overlay.
   - Build a quick sliding ad banner that matches the main event banner style.
   - Create a server/dashboard toggle for ad banner visibility and fallback state when no ad is active.
4. Enhance visuals and effects.
   - Refine typography, glow, and polished panel shadows.
   - Add screen-level transitions: slide in/out, background vignette pulses, and smoother banner motion.
   - Keep effects professional: strong but not noisy.
5. Improve animation and visual coherence.
   - Integrate event banner transitions and ad banner transitions as a matched pair.
   - Make `gift`, `kill`, `heal`, and `like` effects feel consistent in speed and intensity.

### Phase 3: Dashboard/admin completion

1. Polish the admin interface in `dashboard.html`.
   - Improve clarity of the status chips, labels, and control groups.
   - Add dedicated settings for: ad banner enable, event animation intensity, effect speed, sound spam tolerance, and layout presets.
2. Add a subscription / payments status section.
   - Show trial expiration, subscription state, and PayPal actions in the dashboard header or control panel.
   - Provide a direct overlay of subscription status for the current user.
3. Strengthen audio management.
   - Keep audio upload, preview, assignment, and deletion flows robust.
   - Show clearer errors and success messages for missing assignments.
   - Add ability to preview sounds without affecting overlay state.
4. Improve page navigation and usability.
   - Ensure `dashboard-welcome.html`, `dashboard.html`, and `overlay.html` are consistent in branding and tone.
   - Add explicit open-overlay and open-stats buttons for a professional control workflow.
   - Make page state persistence and refresh behavior predictable.

### Phase 4: Subscription, onboarding, and paywall flow

1. Complete the trial and checkout flow.
   - `signup.html`: ensure trial signup is clear, simple, and correct.
   - `home.html`: make the CTA to start trial obvious and consistent with the paid flow.
   - `paywall.html`: keep the upgrade path strong and ensure PayPal redirect works reliably.
2. Harden PayPal integration.
   - `tiktokbr/routes/paypal.js` already handles PayPal webhook verification and subscription events; verify it works end-to-end.
   - Confirm the server environment supports `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and `PAYPAL_PAYMENT_LINK`.
   - Ensure `BILLING.SUBSCRIPTION.ACTIVATED`, `CANCELLED`, `SUSPENDED`, `EXPIRED`, and `PAYMENT.SALE.COMPLETED` are handled correctly.
3. Improve code retrieval and onboarding.
   - Ensure `/my-code` is clear and works for subscribed users.
   - Ensure `/signup` and `/login` paths correctly lead into the trial/subscription experience.
   - Confirm that subscriber email lookup and code issuance are stable.
4. Add subscription-aware UX in the app.
   - Trial expiration should direct users to `/paywall` with a clear message.
   - Dashboard access should require a valid trial or active subscription via `checkTrial` middleware.
   - Add graceful messaging for revoked, expired, or suspended accounts.
5. Make the subscription path complete.
   - Landing page → sign up → trial start → dashboard access → paywall after trial → PayPal subscription → code retrieval → login.
   - This ensures the full product is deliverable as a complete SaaS experience.

### Phase 5: Verification and release readiness

1. Test UI flows.
   - Signup/trial creation on `signup.html`.
   - Login with access code and session persistence.
   - Dashboard access, overlay opening, and stats page.
   - Trial expiration path and paywall redirect.
2. Test live overlay behavior.
   - Connect overlay with `room_id` and confirm real-time socket updates.
   - Trigger `attack`, `gift`, `kill`, `heal`, `respawn`, and verify banners, effects, and sounds.
   - Test high-frequency likes/gift spam and ensure buffering prevents annoyance.
3. Test payment and subscription flows.
   - Confirm `paywall-link` works with PayPal integration.
   - Simulate webhook events to verify code issuance, renewal, and revocation.
   - Test `/my-code` retrieval by email.
4. Confirm background and audio asset updates.
   - Upload and clear overlay background from `dashboard.html`.
   - Upload audio, assign it, and confirm the overlay receives `audioConfig` updates.
5. Validate server state persistence.
   - Verify `roomManager.js` persists `overlaySettings`, `audioConfig`, `audioLibrary`, and `background_filename`.
   - Ensure room data survives app restarts.

### Phase 6: Optional Phaser 4 rewrite path

1. Decision point: stay with the current canvas system or spin a Phaser 4 branch.
   - If time is limited, keep the current overlay engine and improve it in place.
   - If long-term maintainability and richer effects are desired, create a separate Phaser 4 overlay implementation.
2. Phaser 4 option scope.
   - Migrate overlay rendering and card layout to Phaser scenes.
   - Rebuild event banner and ad banner as Phaser UI layers.
   - Preserve dashboard API, server socket logic, and room state.
3. Keep the rewrite optional.
   - A Phaser rewrite should be a separate track, not blocking the complete app delivery.

---

**Key files to update**
- `overlay.html`
- `dashboard.html`
- `server.js`
- `roomManager.js`
- `tiktokbr/routes/paypal.js`
- `tiktokbr/routes/auth.js`
- `signup.html`, `paywall.html`, `home.html`, `dashboard-welcome.html`

**What this roadmap delivers**
- A complete app experience from landing page to live overlay control.
- Professional overlay and dashboard polish with user-friendly settings.
- Paywall and subscription flow that supports trials, paid access, and code-based login.
- A complete SaaS-ready path for creators who want a polished TikTok Live overlay product.
- A clean optional path for a future Phaser 4 implementation.
