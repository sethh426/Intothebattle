export const seedBlogPosts = [
  {
    slug: 'intothebattle-update-july-8-9-2026',
    title: 'IntoTheBattle Update: July 8-9, 2026',
    summary: 'A simple recap of the IntoTheBattle overlay, dashboard, admin, and testing updates from July 8 and July 9, 2026.',
    status: 'published',
    source: 'manual',
    sourceKey: 'release-update-2026-07-08-09',
    seoTitle: 'IntoTheBattle Update: July 8-9, 2026',
    seoDescription: 'A simple reader-friendly recap of IntoTheBattle updates from July 8 and July 9, including overlay readability, dashboard controls, admin tools, and live-action testing.',
    seoKeywords: 'IntoTheBattle update, TikTok LIVE overlay, creator dashboard, battle overlay, release notes',
    publishedAt: '2026-07-09 12:55:00',
    contentHtml: `
      <p>Here is the short version of what changed on July 8 and July 9, 2026.</p>

      <h2>July 8, 2026</h2>
      <ul>
        <li>Player cards were redesigned so names, status, and health are easier to read on stream.</li>
        <li>The dashboard now lets you set Boss HP before sending out a boss wave.</li>
        <li>Live chat command handling was tightened up, including direct attacks and comments shaped differently by TikTok.</li>
        <li>Google OAuth cookie handling was fixed for the new domain setup.</li>
        <li>Admin tools gained free-forever grants and a clearer operations runbook.</li>
      </ul>

      <h2>July 9, 2026</h2>
      <ul>
        <li>The legacy overlay HUD got another visual polish pass.</li>
        <li>Alert banners were fixed so they stay in a steady lane instead of drifting around the screen.</li>
        <li>The command banner is wider and easier to read.</li>
        <li>The dashboard gained a master volume control.</li>
        <li>Admin email campaign tools were added.</li>
        <li>Chat comment attack coverage was added so we can catch command issues earlier.</li>
        <li>The overlay went through extended live-action testing across player cards, boss waves, horde pressure, support effects, command banners, event storms, desktop, and mobile.</li>
      </ul>

      <h2>What this means</h2>
      <p>For viewers, the battle should be easier to follow. Names are clearer, cards are stronger, and important banners should stay where they belong.</p>
      <p>For creators, the dashboard has more control before going live, especially around boss waves and audio. The system also has more checks around the parts that matter during an actual stream.</p>
      <p>We are still tightening the first official version, but these updates move the overlay and dashboard closer to the live show we want.</p>
    `.replace(/\s+/g, ' ').trim(),
  },
  {
    slug: 'live-connection-cleanup-and-player-privacy-update',
    title: 'Live Connection Cleanup and Player Privacy Update',
    summary: 'IntoTheBattle now clears stale stream connections more aggressively so a new creator session does not inherit old players or another streamer identity.',
    status: 'published',
    source: 'manual',
    sourceKey: 'release-update-live-cleanup-2026-07-22',
    seoTitle: 'Live Connection Cleanup and Player Privacy Update | IntoTheBattle',
    seoDescription: 'IntoTheBattle update notes covering safer TikTok LIVE session cleanup, streamer identity isolation, and protections against old stream data appearing in a new room.',
    seoKeywords: 'IntoTheBattle update, TikTok LIVE connection, player privacy, streamer session cleanup, live overlay',
    publishedAt: '2026-07-22 15:00:00',
    contentHtml: `
      <p>One of the most important updates this month was not a flashy arena effect. It was the kind of fix creators should barely notice because it keeps the stream feeling trustworthy.</p>

      <h2>What changed</h2>
      <ul>
        <li>When a TikTok LIVE connection ends, IntoTheBattle now treats that room as ended instead of quietly keeping old stream state around.</li>
        <li>Saved streamer auto-resume is disabled by default, so startup does not restore an old streamer into a fresh session.</li>
        <li>Player state from an inactive stream is cleared more carefully before the next live connection starts.</li>
        <li>Production keeps the auto-resume guard off with <code>TIKTOK_AUTO_RESUME_SAVED_STREAM=false</code>.</li>
      </ul>

      <h2>Why it matters</h2>
      <p>Creators should never sign in and see another person&apos;s username, and viewers should never see players from an old stream bleeding into the current battle. This update focuses on that boundary: one creator, one room, one live session.</p>
      <p>For the audience, the result is simple. The arena should start clean when the creator connects, and it should stop following a stream once that live has ended.</p>

      <h2>What to expect on stream</h2>
      <p>If a live ends without someone manually disconnecting in the app, the game server now has a safer path to stop that session too. That protects the next connection from stale player cards, old horde pressure, and old streamer identity data.</p>
      <p>This is part of a bigger reliability pass before broader creator onboarding. The goal is boring in the best way: the right room loads, the right streamer connects, and nobody sees someone else&apos;s information.</p>
    `.replace(/\s+/g, ' ').trim(),
  },
  {
    slug: 'attack-visuals-and-hot-load-smoothing-update',
    title: 'Attack Visuals and Hot-Load Smoothing Update',
    summary: 'Attack effects now use safer placement and adaptive hot-mode smoothing so the overlay stays readable when chat sends a burst of attacks.',
    status: 'published',
    source: 'manual',
    sourceKey: 'release-update-attack-smoothing-2026-07-22',
    seoTitle: 'Attack Visuals and Hot-Load Smoothing Update | IntoTheBattle',
    seoDescription: 'IntoTheBattle update notes covering attack effect placement, adaptive animation smoothing, hot-mode diagnostics, and better overlay performance under event storms.',
    seoKeywords: 'IntoTheBattle update, attack effects, TikTok LIVE overlay performance, animation smoothing, hot mode',
    publishedAt: '2026-07-22 16:30:00',
    contentHtml: `
      <p>Attack effects are one of the loudest parts of IntoTheBattle, so they need two things at the same time: they need to look exciting, and they need to stay smooth when chat gets rowdy.</p>

      <h2>Cleaner attack placement</h2>
      <ul>
        <li>Attack origin and target points now go through one shared geometry resolver.</li>
        <li>Player, horde, and boss attacks use clamped canvas positions so effects are less likely to appear detached from their target.</li>
        <li>Impact bursts and damage numbers now use the same resolved target point as the rendered attack path.</li>
        <li>New diagnostics record the latest attack geometry so visual bugs are easier to reproduce.</li>
      </ul>

      <h2>Smoother when the overlay is running hot</h2>
      <p>The overlay now watches frame health, active attacks, particle count, and queue depth. When those numbers climb, hot mode temporarily trims visual work instead of letting everything stack up.</p>
      <ul>
        <li>Particle counts drop while hot mode is active.</li>
        <li>Older low-priority effects are trimmed before they can slow the canvas down.</li>
        <li>Arena shake gets softer and shorter during heavy bursts.</li>
        <li>Gameplay, ambient, and sound lanes use tighter budgets while high-priority battle moments keep their place.</li>
      </ul>

      <h2>How we checked it</h2>
      <p>The visual confidence tests now include attack geometry probes and hot attack storm coverage. That means the test suite checks that attacks still fire, stay owned, avoid collapsed paths, and keep particle counts under the hot-mode cap.</p>
      <p>The intended feeling is not less action. It is steadier action: the overlay should still pop, but it should stop wasting frames when the battle gets crowded.</p>
    `.replace(/\s+/g, ' ').trim(),
  },
  {
    slug: 'aetheris-world-map-and-territory-visual-update',
    title: 'Aetheris World Map and Territory Visual Update',
    summary: 'IntoTheBattle has a new Aetheris world presentation with richer globe visuals, clearer TikTok-handle labels, and stronger territory interaction.',
    status: 'published',
    source: 'manual',
    sourceKey: 'release-update-aetheris-2026-07-28',
    seoTitle: 'Aetheris World Map and Territory Visual Update | IntoTheBattle',
    seoDescription: 'IntoTheBattle update notes covering the Aetheris globe, territory visuals, TikTok handle labels, and shared world interaction improvements.',
    seoKeywords: 'IntoTheBattle Aetheris, TikTok LIVE game world, territory map, creator battle map, globe visuals',
    publishedAt: '2026-07-28 19:30:00',
    contentHtml: `
      <p>The Aetheris side of IntoTheBattle is starting to feel more like a shared world instead of a flat menu. Recent updates focused on the globe, territory readability, and how creator identity appears on the map.</p>

      <h2>What improved</h2>
      <ul>
        <li>The Aetheris globe received a richer graphics pass so territory and world movement feel more intentional.</li>
        <li>Territory visuals and interactions were upgraded to make the map easier to scan.</li>
        <li>Labels now stay focused on TikTok handles, which keeps the world tied to the creators and players people recognize from live battles.</li>
        <li>The shared Aetheris world work moved closer to a complete foundation for future territory and engagement features.</li>
      </ul>

      <h2>Why this belongs in IntoTheBattle</h2>
      <p>IntoTheBattle is still built around live creator battles first. Aetheris adds a second layer: a persistent world where those creators, handles, and battle outcomes can have a place beyond a single overlay session.</p>
      <p>That matters because live games are not just about one moment of chat activity. The best streams build memory. A world map gives that memory somewhere to live.</p>

      <h2>What comes next</h2>
      <p>The current update is visual and structural. It gives the map a stronger base for territory ownership, engagement analytics, and clearer logged-in navigation into the Aetheris experience.</p>
      <p>In plain terms: the world is becoming more legible, more interactive, and more connected to the people who show up in battle.</p>
    `.replace(/\s+/g, ' ').trim(),
  },
];
