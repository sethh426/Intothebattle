import dotenv from 'dotenv';

dotenv.config();

// Production hotfix: use the legacy direct LIVE connector and keep the
// unfinished official TikTok OAuth integration hidden from streamer-facing UI.
// Remove these overrides only after the official integration is production-ready.
process.env.TIKTOK_LIVE_MODE = 'direct';
process.env.TIKTOK_LIVE_EVENT_PROVIDER = 'legacy';
process.env.TIKTOK_REQUIRE_ACCOUNT_LINK_FOR_LIVE = 'false';
delete process.env.TIKTOK_CLIENT_KEY;
delete process.env.TIKTOK_CLIENT_ID;
delete process.env.TIKTOK_CLIENT_SECRET;
delete process.env.TIKTOK_APP_ID;
