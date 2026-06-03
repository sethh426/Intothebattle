## Comprehensive App Completion Roadmap

**Status**: Pre-production  
**Target**: Production-ready TikTok Live overlay SaaS with subscription support  
**Updated**: June 3, 2026

---

## Executive Summary

This roadmap defines the path from current state to a complete, production-ready app. It includes 6 phases with specific acceptance criteria, testing strategies, edge cases, and dependencies.

**Key Outcomes**:
1. Render-ready deployment with persistent disk storage
2. Unified, professional overlay and dashboard UI
3. End-to-end subscription/paywall flow
4. Robust error handling and graceful degradation
5. Complete test coverage for critical flows

---

## Phase 1: Architecture Stabilization & Disk Persistence

### Objectives
- Validate Render deployment with persistent storage
- Ensure socket event routing is consistent across all clients
- Establish database and file system persistence patterns
- Fix any auth or room routing edge cases

### Acceptance Criteria

**1.1 Disk Persistence**
- [ ] `DISK_PATH=/var/data` is used consistently for:
  - SQLite database: `/var/data/tiktokbr.db`
  - Audio uploads: `/var/data/audio/<roomId>/`
  - Background images: `/var/data/backgrounds/<roomId>/`
  - Player stats: `/var/data/players_<roomId>.json`
  - Room configs: `/var/data/<roomId>/audio-config.json`
- [ ] Fallback to local paths when `DISK_PATH` not set (dev mode)
- [ ] Directories auto-create on first file write
- [ ] File upload failures log clearly (missing directory, permission denied, disk full)

**1.2 Socket & Event Routing**
- [ ] Overlay clients (unauthenticated with `?room_id=`) connect and receive:
  - `gameState` (player list, HP, kills)
  - `audioConfig` (assigned sounds)
  - `overlaySettings` (laser color, layout)
  - `backgroundChanged` (current BG filename)
  - Event broadcasts: `attack`, `gift`, `kill`, `heal`, `respawn`
- [ ] Dashboard clients (authenticated) receive:
  - `overlayCount` (# connected overlays)
  - `overlaySettings` (all settings for editing)
  - `audioLibrary` (list of uploaded audio files)
  - Same game state as overlay
- [ ] Server validates room routing via `getRoomPaths(req.room.roomId)`
- [ ] Socket namespaces are clean: `/overlay` and `/dashboard` register separately
- [ ] Disconnect events properly decrement `overlayCount`

**1.3 Authentication & Access Control**
- [ ] `/overlay` route requires `?room_id=` query param OR valid session
- [ ] `/dashboard` route requires valid `session_token` cookie
- [ ] Trial middleware (`checkTrial`) blocks dashboard if trial expired
- [ ] Error responses include actionable messages:
  - 403: "Trial expired. Upgrade to continue."
  - 401: "Session invalid. Please log in again."
  - 400: "Invalid room_id format."

**1.4 Room & State Isolation**
- [ ] Each room has isolated state (players, audio, overlays)
- [ ] Room state loads from database on first access
- [ ] Room state persists to database on change (audio upload, settings update)
- [ ] Orphaned rooms (no overlays, no dashboard) are cleanable
- [ ] `emitRoomEvent(room, event, data)` targets correct Socket.io room

### Implementation Details

**Code Changes**:
- `roomManager.js`: Validate `ROOT_DIR = process.env.DISK_PATH || __dirname`
- `server.js`: Test disk write path on startup; log to indicate persistence mode
- `tiktokbr/db/db.js`: Verify SQLite file path uses `DISK_PATH`
- `tiktokbr/middleware/auth.js`: Add clear error logging for debug

**Database Schema**:
```sql
-- Verify these tables exist:
room_settings (room_id, overlay_settings, audio_config, audio_library, background_filename, created_at, updated_at)
access_codes (code, email, trial_started, trial_days, subscription_status, streamer_name, tiktok_username, expires_at)
app_settings (key, value)
```

**Testing**:
- [ ] Startup: Log "Persistence mode: /var/data" or "Persistence mode: local"
- [ ] Create a test room, upload audio, verify file exists on disk
- [ ] Restart server, verify audio still loaded
- [ ] Simulate disk full error; verify app logs and client gets 507 error
- [ ] Test with 10 concurrent overlays on same room; verify overlayCount is accurate

### Blockers / Dependencies
- None (builds on existing codebase)

---

## Phase 2: Overlay UI Polish & Screen Framing

### Objectives
- Redesign overlay for professional broadcast appearance
- Integrate banners into the overlay canvas (not floating page elements)
- Add second ad banner with toggle control
- Refine animations and visual hierarchy

### Acceptance Criteria

**2.1 Screen Framing & Layout**
- [ ] Overlay container has a cohesive glass-bezel frame
  - Subtle 2-4px border with 1px inner glow
  - Soft drop shadow (0 10px 40px rgba(0,0,0,0.4))
  - Rounded corners (16-20px radius)
  - Slight backdrop blur or vignette on edges
- [ ] Canvas is centered within frame with 12-16px padding
- [ ] Player grid is centered and respects container bounds
- [ ] "THE HORDE" summary card is positioned at bottom-right
- [ ] All UI elements (banners, controls) fit within the frame
- [ ] Overlay appears as a single "broadcast panel" not multiple floating elements

**2.2 Banner System**
- [ ] Event banner (attack, gift, kill, etc.):
  - Slides in from top with easing animation (0.4s)
  - Displays for 3-5s before sliding out
  - Uses theme colors for event type (e.g., red for kills, green for heals)
  - Includes attacker name, target name, and damage value
  - Queues if multiple events occur in quick succession
- [ ] Ad banner (new):
  - Slides in from bottom with easing animation (0.5s)
  - Toggleable via dashboard checkbox ("Show Ad Banner")
  - Can be manually dismissed by user (X button in corner)
  - Reappears after 30 seconds if enabled
  - Fallback message if no ad is set: "Sponsored by [streamer name]"
  - Can display static image or HTML content

**2.3 Visual & Animation Polish**
- [ ] Typography:
  - Player names: 14-16px, semi-bold, white
  - HP/damage values: 12-14px, monospace, color-coded
  - Titles: 18-22px, bold, theme primary color
- [ ] Attack animations:
  - Laser/beam: 0.3s linear, smooth line from attacker to target
  - Projectile: 0.4s ease-out arc, includes particle trail
  - Explosion: 0.5s ease-out, radial burst with shockwave
  - All animations use consistent easing curves
- [ ] Event effect intensity slider:
  - 0% = no animations, just text updates
  - 50% = medium animations, reduced particle count
  - 100% = full animations with all effects
  - Slider updates overlay in real-time (no page reload)
- [ ] Sound spam tolerance:
  - Slider 0-100 (100 = all sounds play, 0 = mute)
  - Prevents audio clipping from rapid events
  - Dashboard shows warning if > 50 events/sec detected

**2.4 Layout Presets**
- [ ] Dashboard offers 3 preset layouts:
  - **Compact**: 4x5 grid, minimal spacing, more players visible
  - **Balanced**: 5x4 grid (current default)
  - **Large**: 3x3 grid, larger cards, fewer players
- [ ] Users can adjust horizontal/vertical gap with sliders (0-20px)
- [ ] Layout preference saves to `overlaySettings` in database

### Implementation Details

**Files to Update**:
- `overlay.html`: Rewrite canvas layout; add banner queue system
- `server.js`: Add ad banner toggle to room settings
- `dashboard.html`: Add effect intensity, sound tolerance, and layout preset controls

**New CSS / Canvas Methods**:
```javascript
// Canvas rendering updates
- drawFrameBezel() - renders glass border
- drawEventBanner() - slides in/out event message
- drawAdBanner() - toggleable ad banner
- queueEventBanner(event) - manages banner queue
- applyEffectIntensity(pct) - reduces animation complexity

// Database schema update (roomManager)
overlaySettings: {
  laserColor, shotType, shotSpeed,  // existing
  effectIntensity: 0-100,  // NEW
  soundTolerance: 0-100,  // NEW
  layoutPreset: 'balanced|compact|large',  // NEW
  showAdBanner: true/false,  // NEW
  adBannerContent: 'static|html'  // NEW (optional)
}
```

**Testing**:
- [ ] Render overlay in browser; verify frame and centering
- [ ] Trigger attack event; verify banner slides in, stays for 3-5s, slides out
- [ ] Queue 5 rapid events; verify banners queue without overlap
- [ ] Toggle ad banner on/off; verify appears/disappears
- [ ] Adjust effect intensity slider; verify animations reduce
- [ ] Switch layout presets; verify grid updates without reload
- [ ] Verify on 1920x1080, 1280x720, 1024x768 resolutions

### Blockers / Dependencies
- Depends on Phase 1 (socket routing must work)

---

## Phase 3: Dashboard Completion & Settings

### Objectives
- Harden admin interface with clear controls
- Add subscription/payment status display
- Strengthen audio management flow
- Improve page navigation and consistency

### Acceptance Criteria

**3.1 Dashboard UI Polish**
- [ ] Status chips are clear and color-coded:
  - Green: Connected/Active/Healthy
  - Red: Disconnected/Error/Expired
  - Yellow: Warning/Timeout/Degraded
- [ ] All sections have consistent spacing, fonts, and color palette
- [ ] Labels are descriptive and include tooltips (?) for non-obvious controls
- [ ] Action buttons are prominent and clearly labeled
- [ ] Error messages appear in toasts/banners, not console-only
- [ ] Loading states show spinners, not stalled UI

**3.2 Subscription Status Section**
- [ ] New card in dashboard header displaying:
  - Current subscription status (Trial/Active/Expired/Suspended)
  - Trial expiration date (if applicable)
  - Days remaining (if trial)
  - Next billing date (if subscription)
  - PayPal subscription ID (for reference)
  - Manual action button: "Renew Trial", "Upgrade Now", or "Reactivate"
- [ ] Color-coded status:
  - Green: Active subscription
  - Blue: Trial in progress
  - Orange: Trial expiring in < 3 days
  - Red: Trial/subscription expired
- [ ] Clicking status section links to `/paywall` if action needed

**3.3 Audio Management**
- [ ] Upload flow:
  - Drag-and-drop zone with visual feedback
  - Progress bar during upload
  - Success message with filename and file size
  - Error message if file is invalid/too large
- [ ] Audio library display:
  - Sortable list (by name, upload date, size)
  - Preview button: plays audio for 5 seconds (stops if user clicks again)
  - Preview doesn't affect overlay (isolated from audio assignment)
  - Delete button with confirmation dialog
- [ ] Audio assignment:
  - Dropdown for each event (attack, gift, kill, heal, follow)
  - "Preview" button next to each dropdown
  - Unassigned events show placeholder text "No audio"
  - Dashboard shows warning if any event is unassigned
- [ ] Error handling:
  - Network error: "Upload failed. Retrying..."
  - Disk full: "Upload failed: Storage full. Contact support."
  - Invalid format: "File type not supported. Use MP3, WAV, or OGG."
  - Duplicate name: "File already exists. Rename and try again."

**3.4 Settings Panel**
- [ ] Collapsible sections:
  - **Overlay Controls**: effect intensity, sound tolerance, layout preset, ad banner toggle
  - **Audio Settings**: upload, preview, assign, delete flows (from 3.3)
  - **Room Settings**: room name, room ID (read-only), timezone
  - **Appearance**: theme selection (link to theme-samples.html)
- [ ] Each setting saves immediately or shows explicit "Save" button
- [ ] Settings are stored in `overlaySettings` and synced to all connected overlays

**3.5 Page Navigation & Consistency**
- [ ] Navbar appears on all pages (home, signup, dashboard, overlay, stats)
  - Logo and app name (left)
  - Current page title (center)
  - User menu + logout (right)
  - Active page is highlighted
- [ ] Consistent color scheme across all pages (use chosen theme)
- [ ] All buttons use the same style and sizing
- [ ] All forms use the same input styling
- [ ] Consistent error/success toast styling
- [ ] Mobile-responsive layout (stacks nav on small screens)

**3.6 Overlay & Stats Quick Links**
- [ ] Dashboard has prominent buttons:
  - "Open Overlay" (new tab, opens `/overlay?room_id=<roomId>`)
  - "View Stats" (new tab, opens `/stats?room_id=<roomId>`)
  - "Copy Overlay URL" (copies `/overlay?room_id=<roomId>` to clipboard)
- [ ] Buttons show feedback (highlight on hover, confirmation toast after copy)

### Implementation Details

**Files to Update**:
- `dashboard.html`: Rewrite with new sections and controls
- `server.js`: Add new API endpoints for settings (GET/POST `/api/settings`)
- `tiktokbr/middleware/checkTrial.js`: Enhance to provide subscription status

**Database Schema Update**:
```sql
-- Add to room_settings:
room_name TEXT
timezone TEXT
-- Add to access_codes:
next_billing_date DATETIME
paypal_subscription_id TEXT
```

**API Endpoints**:
```
GET /api/settings/<roomId> - fetch all settings
POST /api/settings/<roomId> - update settings
GET /api/subscription/status - fetch subscription status for logged-in user
```

**Testing**:
- [ ] Verify all dashboard sections render correctly
- [ ] Upload audio, verify file appears in library
- [ ] Preview audio without affecting overlay
- [ ] Delete audio with confirmation
- [ ] Assign/unassign sounds to events
- [ ] Adjust all settings; verify they sync to overlay
- [ ] Click "Open Overlay" button; verify new tab opens correct URL
- [ ] Test on mobile; verify nav stacks and is usable

### Blockers / Dependencies
- Depends on Phase 1 (auth/room routing)
- Depends on Phase 2 (overlay updates to receive settings)

---

## Phase 4: Subscription & Paywall Flow

### Objectives
- Complete end-to-end trial and subscription flow
- Harden PayPal integration
- Implement code retrieval for subscribers
- Add subscription-aware UX throughout app

### Acceptance Criteria

**4.1 Trial & Signup Flow**
- [ ] `/signup` page displays:
  - "Start Your Trial" headline
  - "14 days free, no credit card required"
  - Step 1: Generate access code (if no code yet)
    - Button: "Get My Access Code"
    - Displays code in monospace font with copy button
    - Codes are 8-12 alphanumeric characters
  - Step 2: Create account
    - Fields: Streamer Name, TikTok Username, Email
    - Validation: Email is required, Streamer Name is 2-50 chars
    - Submit button: "Start Trial"
  - After submit: Redirect to `/dashboard?trial_started=true` with success message
- [ ] Trial access code:
  - Stores in database with `trial_started = CURRENT_TIMESTAMP`
  - Sets `trial_days = 14`
  - Sets `subscription_status = 'active'`
  - Sets `expires_at = CURRENT_TIMESTAMP + 14 days`
- [ ] `/home` page displays:
  - Hero section with "TikTok Live Battle Overlay" headline
  - CTA button: "Start Free Trial"
  - Features list (overlay, dashboard, audio control, etc.)
  - Pricing section: "$9/month or $99/year" after trial
  - Link to demo video (if available)
- [ ] After trial expires:
  - Dashboard shows trial expiration message
  - `/dashboard` redirects to `/paywall` with message "Trial ended. Upgrade to continue."
  - Trial access code becomes `inactive`

**4.2 PayPal Integration**
- [ ] Environment variables are set:
  - `PAYPAL_CLIENT_ID`
  - `PAYPAL_CLIENT_SECRET`
  - `PAYPAL_WEBHOOK_ID`
  - `PAYPAL_PAYMENT_LINK` (payment link ID)
- [ ] `/paywall` page displays:
  - Trial status if applicable
  - Pricing plans:
    - **Monthly**: $9/month, recurring
    - **Annual**: $99/year, recurring (best value badge)
  - CTA button: "Upgrade Now" (links to PayPal payment link)
  - Money-back guarantee: "14-day money-back guarantee"
  - FAQ: Common questions about billing, cancellation, etc.
- [ ] PayPal webhook `/webhooks/paypal` handles events:
  - `BILLING.SUBSCRIPTION.ACTIVATED`: Create subscription record, issue new access code
  - `BILLING.SUBSCRIPTION.RENEWED`: Extend subscription expiration
  - `BILLING.SUBSCRIPTION.CANCELLED`: Set `subscription_status = 'cancelled'`
  - `BILLING.SUBSCRIPTION.SUSPENDED`: Set `subscription_status = 'suspended'`
  - `BILLING.SUBSCRIPTION.EXPIRED`: Set `subscription_status = 'expired'`
  - `PAYMENT.SALE.COMPLETED`: Log payment, verify subscription status
  - Webhook validates signature via `PAYPAL_WEBHOOK_ID`
  - Errors are logged (not silent failures)
- [ ] Subscription record stores:
  - User email
  - PayPal subscription ID
  - Start date
  - Next billing date
  - Plan (monthly/annual)
  - Status (active/suspended/cancelled/expired)
- [ ] Code issuance on subscription:
  - New code generated for each subscription
  - Code sent via email to subscriber
  - Code stored in database with `paypal_subscription_id` reference
  - Same access code is used for trial extension or new subscription

**4.3 Code Retrieval**
- [ ] `/my-code` route (authenticated only):
  - Requires `session_token` cookie or valid email
  - If email provided: looks up subscriber by email
  - Displays: "Your Access Code" + code in monospace font
  - Displays: "Next Billing Date" + date
  - Displays: "Subscription Status" + status
  - Copy button copies code to clipboard
  - Shows QR code linking to `/login?code=<code>`
- [ ] Email retrieval flow:
  - User enters email on a "Retrieve Code" form
  - System looks up subscriber by email
  - If found: Sends access code to email
  - Toast confirms: "Code sent to [email]. Check your inbox."
  - If not found: "No subscription found for this email."

**4.4 Subscription-Aware UX**
- [ ] Navbar shows subscription status:
  - "Free Trial (13 days left)" or "Active Subscriber"
  - Link to manage subscription (external PayPal link)
- [ ] Dashboard shows trial countdown:
  - Card at top: "Trial expires in 13 days" or "Trial expired"
  - Upgrade button if expiring soon (< 3 days left)
- [ ] Expired/suspended users see:
  - Modal or banner: "Your subscription is [expired/suspended]. Renew now."
  - Dashboard is blocked, redirects to `/paywall`
  - Overlay still works (doesn't affect live streams mid-broadcast)
- [ ] Cancelled/revoked accounts:
  - Dashboard blocked with message: "Your subscription was cancelled."
  - Provide cancel reason if available (user cancel, payment failed, fraud, etc.)
  - Link to PayPal to reactivate or contact support

**4.5 Email Flows**
- [ ] Emails sent on:
  - Trial started: "Your trial has begun. Here's your access code."
  - Trial expiring soon (3 days): "Your trial ends in 3 days. Upgrade now."
  - Subscription activated: "Welcome! Your subscription is active. Here's your access code."
  - Subscription renewing: "Your subscription has been renewed."
  - Subscription cancelled: "Your subscription has been cancelled. Questions?"
- [ ] Email template includes:
  - Access code (if applicable)
  - Link to dashboard
  - Link to support/FAQ
  - Unsubscribe link (for trial expiration/renewal notices only)

### Implementation Details

**Files to Update / Create**:
- `signup.html`: Create or expand with trial flow
- `home.html`: Update with better hero and CTA
- `paywall.html`: Complete with pricing, PayPal link, FAQ
- `server.js`: Add `/webhooks/paypal` route
- `tiktokbr/routes/paypal.js`: Implement webhook handlers
- `tiktokbr/routes/auth.js`: Add `/my-code` endpoint
- `tiktokbr/middleware/checkTrial.js`: Enhance to check subscription status

**Database Updates**:
```sql
ALTER TABLE access_codes ADD COLUMN paypal_subscription_id TEXT UNIQUE;
ALTER TABLE access_codes ADD COLUMN next_billing_date DATETIME;
ALTER TABLE access_codes ADD COLUMN plan_type TEXT ('monthly'/'annual');
ALTER TABLE access_codes ADD COLUMN issued_at DATETIME DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_subscription_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  next_billing_date DATETIME,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**PayPal Webhook Handler Pseudocode**:
```javascript
POST /webhooks/paypal
  - Verify signature with PAYPAL_WEBHOOK_ID
  - Extract event.resource (subscription data)
  - On BILLING.SUBSCRIPTION.ACTIVATED:
    - Create subscription record
    - Generate new access code
    - Send welcome email with code
  - On BILLING.SUBSCRIPTION.CANCELLED:
    - Update subscription.status = 'cancelled'
    - Update access_code.subscription_status = 'cancelled'
  - Log all events for debugging
  - Return 200 OK (idempotent)
```

**Email Service** (use provider like SendGrid, Mailgun, or built-in SMTP):
- Template variables: `{name}`, `{code}`, `{expiration_date}`, `{next_billing_date}`
- Transactional emails (no delay)
- Resend logic if delivery fails (3 retries)

**Testing**:
- [ ] Sign up for trial, verify code is issued and trial starts
- [ ] Wait 14 days (or mock time), verify trial expiration redirect
- [ ] Simulate PayPal webhook: subscription activated
- [ ] Verify access code is generated and subscription status is updated
- [ ] Retrieve code via `/my-code` endpoint
- [ ] Verify subscription-aware messages in UI
- [ ] Test cancelled/suspended account access
- [ ] Verify all emails are sent and formatted correctly

### Blockers / Dependencies
- Depends on Phase 1 (auth)
- Requires PayPal API credentials setup (outside scope)

---

## Phase 5: Verification & Release Readiness

### Objectives
- Comprehensive testing of all user flows
- Performance and load testing
- Security hardening
- Documentation and runbooks

### Acceptance Criteria

**5.1 UI Flow Testing**
- [ ] **Signup/Trial Flow**:
  - [ ] Sign up page loads and displays correctly
  - [ ] Generate access code; code is unique
  - [ ] Fill form with invalid data; validation errors appear
  - [ ] Submit form; trial starts, redirect to dashboard, success message appears
  - [ ] Check email for trial confirmation
- [ ] **Login Flow**:
  - [ ] Login page loads
  - [ ] Login with invalid code; error message appears
  - [ ] Login with valid code; creates session, redirects to dashboard
  - [ ] Session persists across page reload
  - [ ] Logout clears session
- [ ] **Dashboard Flow**:
  - [ ] Dashboard loads and displays all sections
  - [ ] All buttons/controls are clickable
  - [ ] Settings changes persist (refresh page, verify still there)
  - [ ] Audio upload, preview, assign, delete flows work
  - [ ] "Open Overlay" button opens correct URL in new tab
- [ ] **Overlay Flow**:
  - [ ] Overlay loads with `?room_id=<id>`
  - [ ] Receives live events (attack, gift, kill, etc.)
  - [ ] Events display correctly with animations
  - [ ] Audio plays on events (if assigned)
  - [ ] Settings changes (intensity, sound level) take effect immediately
  - [ ] Layout preset changes update grid
- [ ] **Paywall Flow** (after trial ends):
  - [ ] Dashboard redirects to paywall with message
  - [ ] Paywall displays pricing and upgrade button
  - [ ] PayPal redirect works
  - [ ] After payment, access code is issued and emailed
  - [ ] Can now log in with new code and access dashboard

**5.2 Live Overlay Testing**
- [ ] **Event Handling**:
  - [ ] Attack event: banner appears, animation plays, sound plays (if assigned)
  - [ ] Gift event: banner appears, area damage is applied, sound plays
  - [ ] Kill event: player HP goes to 0, killed message appears, respawn timer starts
  - [ ] Like event: player HP increases, no sound (or assigned sound plays)
  - [ ] Follow event: banner appears (if enabled)
- [ ] **High-Frequency Events**:
  - [ ] Simulate 50 events/sec; verify no lag or memory leaks
  - [ ] Sound spam tolerance kicks in (mutes rapid duplicates)
  - [ ] Event queue doesn't overflow (drop oldest if > 100 queued)
- [ ] **Concurrent Overlays**:
  - [ ] Open 5 overlays on same room; all receive events
  - [ ] Close overlays; overlayCount updates on dashboard
  - [ ] Add new overlay after removing one; state is correct
- [ ] **Network Issues**:
  - [ ] Simulate disconnect; overlay shows "Disconnected" banner
  - [ ] Simulate reconnect; overlay resumes receiving events
  - [ ] Socket auto-reconnects after 5 seconds of disconnect

**5.3 Subscription Flow Testing**
- [ ] **Trial Testing**:
  - [ ] Start trial, verify expiration date is 14 days away
  - [ ] Mock time to 13 days left; verify UI shows countdown
  - [ ] Mock time to 1 day left; verify warning message appears
  - [ ] Mock time to after expiration; verify redirect to paywall
- [ ] **Subscription Testing** (with PayPal sandbox):
  - [ ] Create subscription via PayPal
  - [ ] Verify webhook fires and updates database
  - [ ] Verify access code is generated and emailed
  - [ ] Cancel subscription; verify status updates
  - [ ] Renew subscription; verify next billing date updates
- [ ] **Code Retrieval**:
  - [ ] Retrieve code via `/my-code` endpoint
  - [ ] Retrieve code by email
  - [ ] Code is accurate and can be used to log in

**5.4 Performance & Load Testing**
- [ ] **Render Load Test**:
  - [ ] Deploy to Render with production settings
  - [ ] Simulate 10 concurrent overlays + dashboard
  - [ ] Monitor memory usage (should not exceed 500MB)
  - [ ] Monitor disk usage (should not grow continuously)
  - [ ] Response times should be < 500ms for all API calls
- [ ] **Database Performance**:
  - [ ] Query `/state` with 1000 players; should respond in < 1s
  - [ ] Update room settings; should complete in < 100ms
  - [ ] Audio file lookup should be < 10ms
- [ ] **Canvas Rendering**:
  - [ ] Overlay should maintain 30+ FPS with 20 players on screen
  - [ ] Animations should be smooth (no jank)
  - [ ] Memory usage should be stable (not growing over time)

**5.5 Security Hardening**
- [ ] **Authentication**:
  - [ ] All sensitive routes require auth (GET /dashboard, POST /api/*)
  - [ ] JWTs expire correctly (e.g., 24 hours for session_token)
  - [ ] Expired tokens are rejected with 401
- [ ] **Authorization**:
  - [ ] Users can only access their own room (room_id isolation)
  - [ ] Admin endpoints (e.g., `/api/admin/*`) require role check
- [ ] **Input Validation**:
  - [ ] File uploads are validated (size, type, malware scan if available)
  - [ ] Form inputs are sanitized (no script injection)
  - [ ] SQL queries use parameterized statements (no SQL injection)
- [ ] **CORS & Headers**:
  - [ ] `Access-Control-Allow-Origin` is set correctly (not *)
  - [ ] Security headers are present: `X-Content-Type-Options: nosniff`
  - [ ] HTTPS is enforced on production
- [ ] **Secrets & Credentials**:
  - [ ] No credentials in code or logs
  - [ ] Environment variables are used for all secrets
  - [ ] PayPal secrets are never exposed to client
  - [ ] Error messages don't reveal sensitive info (e.g., "Invalid code" not "Email not found")

**5.6 Error Handling & Logging**
- [ ] **Server Errors**:
  - [ ] 500 errors are logged with full stack trace
  - [ ] Client receives generic error message ("Something went wrong")
  - [ ] Admin dashboard (if available) shows error summary
- [ ] **User Errors**:
  - [ ] Invalid input shows clear validation error (e.g., "Email is required")
  - [ ] File upload errors are specific (e.g., "File size exceeds 10MB")
  - [ ] Network errors show retry option or contact support
- [ ] **Logging**:
  - [ ] All auth attempts are logged (success and failure)
  - [ ] All subscription events are logged
  - [ ] All file uploads are logged
  - [ ] Logs are accessible (Render logs dashboard or Sentry)

**5.7 Documentation**
- [ ] **README.md**:
  - [ ] Updated with current features and deployment steps
  - [ ] Quick start guide for new developers
  - [ ] Environment variable reference
- [ ] **API Documentation**:
  - [ ] All endpoints documented with method, path, request/response
  - [ ] Example curl commands for each endpoint
  - [ ] Error codes and what they mean
- [ ] **Deployment Runbook**:
  - [ ] Step-by-step Render deployment
  - [ ] Environment setup checklist
  - [ ] Monitoring and alerting setup
  - [ ] Rollback procedure
- [ ] **Troubleshooting Guide**:
  - [ ] Common issues and solutions
  - [ ] How to check logs
  - [ ] How to reset a stuck room/user state

### Implementation Details

**Testing Checklist**:
- [ ] Manual testing of all flows (QA checklist)
- [ ] Automated tests for critical paths (Playwright/Jest)
- [ ] Load testing script (k6 or similar)
- [ ] Security audit checklist

**Monitoring Setup** (Render):
- [ ] CPU usage alerts (> 80%)
- [ ] Memory usage alerts (> 70%)
- [ ] Disk usage alerts (> 80%)
- [ ] Error rate alerts (> 1% of requests fail)
- [ ] Response time alerts (p95 > 1s)

### Blockers / Dependencies
- Depends on Phases 1-4 (all features must be complete)

---

## Phase 6: Optional Phaser 4 Rewrite (Future)

### Objectives
- Evaluate if current canvas system is sufficient or if Phaser 4 is needed
- If Phaser: Create separate overlay implementation
- Maintain backward compatibility with current system

### Acceptance Criteria

**6.1 Decision Point**
- [ ] **Stay with Current Canvas**:
  - Current system meets performance requirements (30+ FPS)
  - Visual quality is acceptable for production
  - Development velocity is maintained
- [ ] **Start Phaser 4 Rewrite**:
  - Current system has performance issues (< 20 FPS with 20+ players)
  - Visual effects are limited and hard to extend
  - Development team has bandwidth for rewrite

**6.2 Phaser 4 Implementation** (if chosen)
- [ ] New overlay at `/overlay-phaser.html`
- [ ] Phaser scenes for:
  - Player grid scene
  - Event banner scene
  - Ad banner scene
  - Background/effects scene
- [ ] Maintain all existing socket events and API contracts
- [ ] Feature parity with canvas version:
  - All animations and effects
  - All settings (intensity, sound, layout)
  - All performance optimizations
- [ ] Parallel deployment (keep canvas as fallback)
- [ ] A/B test both versions before full migration

### Blockers / Dependencies
- Optional; does not block production release

---

## Cross-Cutting Concerns

### Performance Targets
- API response time: < 200ms (p95)
- Overlay FPS: 30+ with 20 players
- Memory usage: < 500MB on Render
- Database query time: < 100ms
- WebSocket message latency: < 100ms

### Security & Compliance
- All inputs validated (client + server)
- HTTPS enforced on production
- CORS properly configured
- Rate limiting on auth endpoints (5 attempts / 15 min)
- Secrets never logged or exposed
- GDPR compliance: user data deletion on request

### Error Handling
- 400: Bad request (validation error)
- 401: Unauthorized (invalid auth)
- 403: Forbidden (no permission)
- 404: Not found
- 500: Internal server error
- 507: Insufficient storage (disk full)

### Monitoring & Alerts
- Error rate > 1% ⚠️
- Response time p95 > 1s ⚠️
- Disk usage > 80% ⚠️
- Memory usage > 70% ⚠️
- WebSocket disconnects > 5/min ⚠️

---

## Success Criteria (Final)

By end of all phases:

1. ✅ App deploys to Render without manual intervention
2. ✅ Disk persistence works: uploads survive restarts
3. ✅ Overlay displays live events with smooth animations
4. ✅ Dashboard allows full room control and customization
5. ✅ End-to-end signup → trial → paywall → subscription flow works
6. ✅ PayPal webhook integration is robust and tested
7. ✅ Email confirmations are sent on key events
8. ✅ UI is consistent, professional, and theme-able
9. ✅ All critical flows have test coverage
10. ✅ Documentation is complete and current
11. ✅ Performance meets targets (30+ FPS, < 500MB memory)
12. ✅ Security audit passes (input validation, auth, secrets)

---

## Timeline Estimate

- **Phase 1**: 1-2 weeks (validation)
- **Phase 2**: 2-3 weeks (UI/UX)
- **Phase 3**: 1-2 weeks (polish)
- **Phase 4**: 2-3 weeks (subscription + PayPal)
- **Phase 5**: 1-2 weeks (testing + hardening)
- **Phase 6**: 4-6 weeks (if chosen)

**Total**: 8-12 weeks for full release (Phases 1-5)

---

## Notes

- Priorities: Phase 1 (stability) > Phase 4 (revenue) > Phase 2 (UX) > Phase 3 (polish)
- Phases can run in parallel where dependencies allow
- Code review required for all changes
- Test all changes locally before Render deployment
- Keep git history clean with descriptive commit messages
