CREATE TABLE IF NOT EXISTS access_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  email TEXT,
  owner_name TEXT,
  room_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_promo INTEGER DEFAULT 0,
  is_revoked INTEGER DEFAULT 0,
  fingerprint TEXT,
  session_token TEXT,
  last_seen TIMESTAMP,
  paypal_subscription_id TEXT,
  user_id INTEGER,
  code_type TEXT DEFAULT 'trial',
  trial_started TIMESTAMP,
  trial_days INTEGER DEFAULT 14,
  subscription_status TEXT DEFAULT 'active',
  streamer_name TEXT,
  tiktok_username TEXT
);

CREATE TABLE IF NOT EXISTS room_settings (
  room_id TEXT PRIMARY KEY,
  streamer_username TEXT,
  overlay_settings TEXT DEFAULT '{}',
  audio_config TEXT DEFAULT '{}',
  audio_library TEXT DEFAULT '[]',
  background_filename TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  uses_remaining INTEGER DEFAULT 1,
  days_granted INTEGER DEFAULT 30,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  tiktok_username TEXT,
  session_token TEXT,
  is_active INTEGER DEFAULT 1,
  banned_at TIMESTAMP,
  ban_reason TEXT,
  email_verified INTEGER DEFAULT 0,
  email_verification_token TEXT,
  email_verification_expires TIMESTAMP,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMP,
  dashboard_rules_acknowledged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_email TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  endpoint TEXT,
  action_taken TEXT DEFAULT 'blocked',
  matched_terms TEXT,
  payload_summary TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS security_events_created_at_idx ON security_events(created_at);
CREATE INDEX IF NOT EXISTS security_events_event_type_idx ON security_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS security_events_actor_email_idx ON security_events(actor_email, created_at);

CREATE TABLE IF NOT EXISTS user_rooms (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  room_id TEXT UNIQUE NOT NULL,
  room_name TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  tiktok_open_id TEXT UNIQUE NOT NULL,
  union_id TEXT,
  tiktok_username TEXT,
  profile_deep_link TEXT,
  display_name TEXT,
  avatar_url TEXT,
  avatar_large_url TEXT,
  scopes TEXT,
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  access_token_expires_at TIMESTAMP,
  refresh_token_expires_at TIMESTAMP,
  status TEXT DEFAULT 'connected',
  disconnect_reason TEXT,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  disconnected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  plan_type TEXT,
  status TEXT DEFAULT 'active',
  started_at TIMESTAMP,
  next_billing_date TIMESTAMP,
  expires_at TIMESTAMP,
  admin_granted INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS signup_intents (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  tiktok_username TEXT,
  source TEXT DEFAULT 'signup',
  last_path TEXT,
  converted_at TIMESTAMP,
  followup_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS streamer_referral_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  code TEXT UNIQUE NOT NULL,
  reset_count INTEGER DEFAULT 0,
  last_reset_at TIMESTAMP,
  reset_available_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS streamer_referral_codes_code_upper_idx ON streamer_referral_codes (UPPER(code));

CREATE TABLE IF NOT EXISTS referral_clicks (
  id SERIAL PRIMARY KEY,
  referral_code_id INTEGER NOT NULL,
  referrer_user_id INTEGER NOT NULL,
  code_snapshot TEXT NOT NULL,
  anonymous_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  referrer_url TEXT,
  landing_path TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  ttclid TEXT,
  converted_user_id INTEGER,
  converted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(referral_code_id) REFERENCES streamer_referral_codes(id),
  FOREIGN KEY(referrer_user_id) REFERENCES users(id),
  FOREIGN KEY(converted_user_id) REFERENCES users(id)
);

ALTER TABLE referral_clicks ADD COLUMN IF NOT EXISTS converted_user_id INTEGER;
ALTER TABLE referral_clicks ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS referral_clicks_code_created_idx ON referral_clicks(referral_code_id, created_at);
CREATE INDEX IF NOT EXISTS referral_clicks_referrer_created_idx ON referral_clicks(referrer_user_id, created_at);
CREATE INDEX IF NOT EXISTS referral_clicks_converted_idx ON referral_clicks(converted_user_id, converted_at);

CREATE TABLE IF NOT EXISTS referral_attributions (
  id SERIAL PRIMARY KEY,
  referral_code_id INTEGER NOT NULL,
  referrer_user_id INTEGER NOT NULL,
  referred_user_id INTEGER NOT NULL UNIQUE,
  referral_click_id INTEGER,
  code_snapshot TEXT NOT NULL,
  signup_method TEXT DEFAULT 'unknown',
  status TEXT DEFAULT 'signup_pending',
  signup_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  qualified_at TIMESTAMP,
  recurring_reward_cents INTEGER DEFAULT 300,
  founding_rate_locked_at TIMESTAMP,
  disqualified_at TIMESTAMP,
  disqualification_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(referral_code_id) REFERENCES streamer_referral_codes(id),
  FOREIGN KEY(referrer_user_id) REFERENCES users(id),
  FOREIGN KEY(referred_user_id) REFERENCES users(id),
  FOREIGN KEY(referral_click_id) REFERENCES referral_clicks(id)
);

ALTER TABLE referral_attributions ADD COLUMN IF NOT EXISTS referral_click_id INTEGER;
ALTER TABLE referral_attributions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'signup_pending';
ALTER TABLE referral_attributions ADD COLUMN IF NOT EXISTS recurring_reward_cents INTEGER DEFAULT 300;
ALTER TABLE referral_attributions ADD COLUMN IF NOT EXISTS founding_rate_locked_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS referral_attributions_referrer_status_idx ON referral_attributions(referrer_user_id, status);
CREATE INDEX IF NOT EXISTS referral_attributions_code_idx ON referral_attributions(referral_code_id);
CREATE INDEX IF NOT EXISTS referral_attributions_click_idx ON referral_attributions(referral_click_id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id SERIAL PRIMARY KEY,
  attribution_id INTEGER NOT NULL UNIQUE,
  referrer_user_id INTEGER NOT NULL,
  referred_user_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending_review',
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(attribution_id) REFERENCES referral_attributions(id),
  FOREIGN KEY(referrer_user_id) REFERENCES users(id),
  FOREIGN KEY(referred_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS referral_rewards_referrer_status_idx ON referral_rewards(referrer_user_id, status);
CREATE INDEX IF NOT EXISTS referral_rewards_status_idx ON referral_rewards(status, created_at);

CREATE TABLE IF NOT EXISTS referral_recurring_rewards (
  id SERIAL PRIMARY KEY,
  attribution_id INTEGER NOT NULL,
  referrer_user_id INTEGER NOT NULL,
  referred_user_id INTEGER NOT NULL,
  subscription_id INTEGER,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  status TEXT DEFAULT 'pending_review',
  amount_cents INTEGER DEFAULT 300,
  currency TEXT DEFAULT 'USD',
  founding_rate_locked INTEGER DEFAULT 1,
  notes TEXT,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(attribution_id) REFERENCES referral_attributions(id),
  FOREIGN KEY(referrer_user_id) REFERENCES users(id),
  FOREIGN KEY(referred_user_id) REFERENCES users(id),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_recurring_rewards_attr_period_unique ON referral_recurring_rewards(attribution_id, period_start);
CREATE INDEX IF NOT EXISTS referral_recurring_rewards_referrer_status_idx ON referral_recurring_rewards(referrer_user_id, status);
CREATE INDEX IF NOT EXISTS referral_recurring_rewards_period_idx ON referral_recurring_rewards(period_start, period_end);

CREATE TABLE IF NOT EXISTS council_year_bonus_claims (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  originating_referrer_user_id INTEGER,
  originating_attribution_id INTEGER,
  trigger_referral_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending_review',
  grant_months INTEGER DEFAULT 12,
  notes TEXT,
  approved_at TIMESTAMP,
  granted_at TIMESTAMP,
  rejected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(originating_referrer_user_id) REFERENCES users(id),
  FOREIGN KEY(originating_attribution_id) REFERENCES referral_attributions(id)
);

CREATE INDEX IF NOT EXISTS council_year_bonus_claims_status_idx ON council_year_bonus_claims(status, created_at);

CREATE TABLE IF NOT EXISTS council_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  status TEXT DEFAULT 'active',
  joined_source TEXT DEFAULT 'dashboard',
  paypal_payout_email TEXT,
  w9_status TEXT DEFAULT 'needed',
  ftc_acknowledged_at TIMESTAMP,
  fine_print_acknowledged_at TIMESTAMP,
  elite INTEGER DEFAULT 0,
  payout_hold_reason TEXT,
  suspended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS council_members_status_idx ON council_members(status, created_at);
CREATE INDEX IF NOT EXISTS council_members_payout_idx ON council_members(status, w9_status, paypal_payout_email);

CREATE TABLE IF NOT EXISTS council_payout_batches (
  id SERIAL PRIMARY KEY,
  batch_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'created',
  payout_method TEXT DEFAULT 'paypal_csv',
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  total_amount_cents INTEGER DEFAULT 0,
  member_count INTEGER DEFAULT 0,
  item_count INTEGER DEFAULT 0,
  created_by_admin_session_id TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS council_payout_batches_status_idx ON council_payout_batches(status, created_at);

CREATE TABLE IF NOT EXISTS council_payout_items (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL,
  member_user_id INTEGER NOT NULL,
  reward_id INTEGER NOT NULL UNIQUE,
  paypal_payout_email TEXT NOT NULL,
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'included',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES council_payout_batches(id),
  FOREIGN KEY(member_user_id) REFERENCES users(id),
  FOREIGN KEY(reward_id) REFERENCES referral_recurring_rewards(id)
);

CREATE INDEX IF NOT EXISTS council_payout_items_batch_idx ON council_payout_items(batch_id, status);
CREATE INDEX IF NOT EXISTS council_payout_items_member_idx ON council_payout_items(member_user_id, status);

CREATE TABLE IF NOT EXISTS council_audit_events (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  actor_admin_session_id TEXT,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(target_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS council_audit_events_action_idx ON council_audit_events(action, created_at);
CREATE INDEX IF NOT EXISTS council_audit_events_target_idx ON council_audit_events(target_user_id, created_at);

CREATE TABLE IF NOT EXISTS admin_email_campaigns (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_url TEXT,
  status TEXT DEFAULT 'queued',
  recipient_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_message TEXT,
  queued_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_email_deliveries (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  user_id INTEGER,
  email TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TIMESTAMP,
  sent_at TIMESTAMP,
  FOREIGN KEY(campaign_id) REFERENCES admin_email_campaigns(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS admin_email_campaigns_status_idx ON admin_email_campaigns(status, queued_at);
CREATE INDEX IF NOT EXISTS admin_email_deliveries_campaign_status_idx ON admin_email_deliveries(campaign_id, status);
CREATE INDEX IF NOT EXISTS admin_email_deliveries_email_idx ON admin_email_deliveries(email);

CREATE TABLE IF NOT EXISTS creator_comments (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  role TEXT,
  comment TEXT NOT NULL,
  status TEXT DEFAULT 'approved',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS battleground_posts (
  id SERIAL PRIMARY KEY,
  creator_name TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  battle_title TEXT NOT NULL,
  scheduled_for TIMESTAMP,
  timezone TEXT,
  description TEXT,
  battle_url TEXT,
  status TEXT DEFAULT 'approved',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketing_posts (
  id SERIAL PRIMARY KEY,
  campaign_date DATE NOT NULL,
  platform TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  audience TEXT,
  audience_stage TEXT DEFAULT 'cold_visitor',
  goal TEXT DEFAULT 'sales',
  hook TEXT,
  body TEXT NOT NULL,
  cta TEXT,
  url TEXT,
  utm_url TEXT,
  hashtags TEXT,
  seo_keywords TEXT,
  scheduled_for TIMESTAMP,
  status TEXT DEFAULT 'draft',
  error_message TEXT,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(campaign_date, platform, topic_key)
);

CREATE TABLE IF NOT EXISTS marketing_publish_events (
  id SERIAL PRIMARY KEY,
  marketing_post_id INTEGER,
  platform TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS growth_api_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_email TEXT,
  status TEXT DEFAULT 'skipped',
  detail TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS growth_utm_events (
  id SERIAL PRIMARY KEY,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  ttclid TEXT,
  anonymous_id TEXT,
  consent_state TEXT DEFAULT 'unknown',
  path TEXT,
  referrer TEXT,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growth_utm_events_created_at_idx ON growth_utm_events(created_at);
CREATE INDEX IF NOT EXISTS growth_utm_events_campaign_idx ON growth_utm_events(utm_campaign, utm_source);

CREATE TABLE IF NOT EXISTS growth_events (
  id SERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_id TEXT UNIQUE NOT NULL,
  anonymous_id TEXT,
  user_id TEXT,
  user_email TEXT,
  room_id TEXT,
  consent_state TEXT DEFAULT 'unknown',
  eligible_for_segment INTEGER DEFAULT 0,
  segment_status TEXT DEFAULT 'skipped',
  segment_detail TEXT,
  properties_json TEXT,
  attribution_json TEXT,
  path TEXT,
  referrer TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growth_events_created_at_idx ON growth_events(created_at);
CREATE INDEX IF NOT EXISTS growth_events_event_name_idx ON growth_events(event_name, created_at);
CREATE INDEX IF NOT EXISTS growth_events_segment_status_idx ON growth_events(segment_status, created_at);

CREATE TABLE IF NOT EXISTS growth_creative_assets (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  approval_status TEXT DEFAULT 'approved',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS growth_creative_variants (
  id SERIAL PRIMARY KEY,
  template_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  format TEXT,
  status TEXT DEFAULT 'draft',
  asset_id INTEGER,
  asset_url TEXT,
  hook TEXT,
  proof TEXT,
  cta TEXT,
  body TEXT NOT NULL,
  utm_url TEXT,
  block_json TEXT,
  safe_zone_json TEXT,
  quality_status TEXT DEFAULT 'draft',
  quality_score INTEGER DEFAULT 0,
  quality_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_sponsor_creatives (
  id SERIAL PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  original_name TEXT,
  campaign_name TEXT DEFAULT 'Default Campaign',
  partner TEXT,
  title TEXT,
  subtitle TEXT,
  duration_ms INTEGER DEFAULT 15000,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  file_size BIGINT DEFAULT 0,
  mime_type TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  aspect_ratio TEXT,
  thumbnail_data TEXT,
  quality_warnings TEXT,
  quality_status TEXT DEFAULT 'ready',
  quality_score INTEGER DEFAULT 100,
  quality_blockers TEXT,
  quality_recommendations TEXT,
  normalized INTEGER DEFAULT 0,
  processing_status TEXT DEFAULT 'ready',
  processing_message TEXT,
  stats_mode TEXT DEFAULT 'endcap',
  fit TEXT DEFAULT 'cover',
  muted INTEGER DEFAULT 1,
  weight INTEGER DEFAULT 1,
  cooldown_seconds INTEGER DEFAULT 600,
  status TEXT DEFAULT 'active',
  readiness_status TEXT DEFAULT 'ready',
  impressions INTEGER DEFAULT 0,
  completions INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0,
  last_shown_at TIMESTAMP,
  last_completed_at TIMESTAMP,
  last_tested_at TIMESTAMP,
  last_failed_at TIMESTAMP,
  processed_at TIMESTAMP,
  active_starts_at TIMESTAMP,
  active_ends_at TIMESTAMP,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sponsor_playback_events (
  id SERIAL PRIMARY KEY,
  break_id TEXT NOT NULL,
  room_id TEXT,
  source TEXT DEFAULT 'creator',
  creative_id INTEGER,
  filename TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id SERIAL PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  room_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  summary_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS combat_rounds (
  id SERIAL PRIMARY KEY,
  round_id TEXT UNIQUE NOT NULL,
  session_id TEXT,
  room_id TEXT NOT NULL,
  rules_version INTEGER DEFAULT 1,
  mode TEXT DEFAULT 'horde_survival',
  phase TEXT DEFAULT 'lobby',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  result_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS combat_rounds_room_started_idx ON combat_rounds(room_id, started_at);
CREATE INDEX IF NOT EXISTS combat_rounds_session_idx ON combat_rounds(session_id);

CREATE TABLE IF NOT EXISTS combat_events (
  id SERIAL PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  round_id TEXT,
  session_id TEXT,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  payload_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS combat_events_round_created_idx ON combat_events(round_id, created_at);
CREATE INDEX IF NOT EXISTS combat_events_room_created_idx ON combat_events(room_id, created_at);

CREATE TABLE IF NOT EXISTS combat_player_round_stats (
  id SERIAL PRIMARY KEY,
  round_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  unique_id TEXT NOT NULL,
  tiktok_handle TEXT,
  score INTEGER DEFAULT 0,
  kills INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  deaths INTEGER DEFAULT 0,
  damage_dealt INTEGER DEFAULT 0,
  healing_done INTEGER DEFAULT 0,
  shielding_done INTEGER DEFAULT 0,
  objective_score INTEGER DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(round_id, unique_id)
);

CREATE INDEX IF NOT EXISTS combat_player_round_stats_room_idx ON combat_player_round_stats(room_id, score);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS room_player_stats (
  room_id TEXT NOT NULL,
  unique_id TEXT NOT NULL,
  nickname TEXT,
  hp INTEGER DEFAULT 300,
  max_hp INTEGER DEFAULT 300,
  strength INTEGER DEFAULT 10,
  kills INTEGER DEFAULT 0,
  kill_streak INTEGER DEFAULT 0,
  last_kill_time BIGINT DEFAULT 0,
  alive INTEGER DEFAULT 0,
  last_active BIGINT,
  color TEXT,
  message_boost_expires BIGINT DEFAULT 0,
  force_spawn INTEGER DEFAULT 0,
  PRIMARY KEY(room_id, unique_id)
);

CREATE TABLE IF NOT EXISTS global_player_stats (
  unique_id TEXT PRIMARY KEY,
  nickname TEXT,
  hp INTEGER DEFAULT 300,
  max_hp INTEGER DEFAULT 300,
  strength INTEGER DEFAULT 10,
  kills INTEGER DEFAULT 0,
  last_active BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS local_blog_posts (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_html TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  source TEXT DEFAULT 'manual',
  source_key TEXT,
  seo_title TEXT,
  seo_description TEXT,
  seo_keywords TEXT,
  published_at TIMESTAMP,
  writefreely_post_id TEXT,
  writefreely_post_url TEXT,
  writefreely_last_push_error TEXT,
  writefreely_last_push_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS local_blog_posts_slug_idx ON local_blog_posts(slug);
CREATE INDEX IF NOT EXISTS local_blog_posts_status_published_idx ON local_blog_posts(status, published_at);
CREATE INDEX IF NOT EXISTS local_blog_posts_source_idx ON local_blog_posts(source, status);
