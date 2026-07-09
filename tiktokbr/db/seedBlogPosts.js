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
];
