import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SKIP_DB = process.env.SKIP_DB || 'true';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.intothebattle.com';

process.env.WRITEFREELY_API_URL = 'http://localhost:8080/';
process.env.WRITEFREELY_PUBLIC_URL = 'http://localhost:8080/';
process.env.WRITEFREELY_COLLECTION_ALIAS = 'owner';
process.env.WRITEFREELY_SINGLE_USER = 'true';
process.env.WRITEFREELY_USERNAME = 'owner';
process.env.WRITEFREELY_PASSWORD = 'local-password';
delete process.env.WRITEFREELY_API_TOKEN;
delete process.env.WRITEFREELY_POST_WEBHOOK_URL;

const {
  buildWritefreelyPostBody,
  renderWritefreelyPayload,
  writefreelyPublishConfig,
} = await import('../tiktokbr/services/blogEngine.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const cfg = writefreelyPublishConfig();
assert(cfg.enabled === true, 'WriteFreely config should enable direct API publishing with username/password');
assert(cfg.publishMethod === 'direct-api', 'WriteFreely config should prefer direct API publishing');
assert(cfg.apiUrl === 'http://localhost:8080', 'WriteFreely API URL should be normalized without trailing slash');
assert(cfg.collectionAlias === 'owner', 'WriteFreely collection alias should be normalized');
assert(cfg.singleUser === true, 'WriteFreely single-user mode should default from env');
assert(cfg.credentialSource === 'env-username-password', 'Explicit username/password env should be reported as the credential source');

const previousEnv = {
  nodeEnv: process.env.NODE_ENV,
  username: process.env.WRITEFREELY_USERNAME,
  password: process.env.WRITEFREELY_PASSWORD,
  token: process.env.WRITEFREELY_API_TOKEN,
  webhook: process.env.WRITEFREELY_POST_WEBHOOK_URL,
  localPath: process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH,
};
const tempCredentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itb-writefreely-'));
const tempCredentialsPath = path.join(tempCredentialsDir, 'ADMIN_CREDENTIALS.txt');
fs.writeFileSync(tempCredentialsPath, 'Username: owner\nPassword: local-file-password\n', 'utf8');
process.env.NODE_ENV = 'development';
process.env.WRITEFREELY_API_URL = 'http://localhost:8080/';
process.env.WRITEFREELY_PUBLIC_URL = 'http://localhost:8080/';
delete process.env.WRITEFREELY_USERNAME;
delete process.env.WRITEFREELY_PASSWORD;
delete process.env.WRITEFREELY_API_TOKEN;
delete process.env.WRITEFREELY_POST_WEBHOOK_URL;
process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH = tempCredentialsPath;
const localCfg = writefreelyPublishConfig();
assert(localCfg.enabled === true, 'Local WriteFreely config should enable direct API publishing from the local credentials file');
assert(localCfg.credentialSource === 'local-admin-file', 'Local credentials file should be reported as the credential source');
assert(localCfg.hasCredentials === true, 'Local credentials file should provide username/password without requiring env secrets');
fs.rmSync(tempCredentialsDir, { recursive: true, force: true });
if (previousEnv.nodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv.nodeEnv;
if (previousEnv.username == null) delete process.env.WRITEFREELY_USERNAME; else process.env.WRITEFREELY_USERNAME = previousEnv.username;
if (previousEnv.password == null) delete process.env.WRITEFREELY_PASSWORD; else process.env.WRITEFREELY_PASSWORD = previousEnv.password;
if (previousEnv.token == null) delete process.env.WRITEFREELY_API_TOKEN; else process.env.WRITEFREELY_API_TOKEN = previousEnv.token;
if (previousEnv.webhook == null) delete process.env.WRITEFREELY_POST_WEBHOOK_URL; else process.env.WRITEFREELY_POST_WEBHOOK_URL = previousEnv.webhook;
if (previousEnv.localPath == null) delete process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH; else process.env.WRITEFREELY_LOCAL_CREDENTIALS_PATH = previousEnv.localPath;

const post = {
  title: 'Site context update',
  slug: 'site-context-update',
  summary: 'A generated post from the public site.',
  sourceKey: 'home',
  seoTitle: 'Site context update | IntoTheBattle',
  seoDescription: 'Generated site-context smoke test.',
  seoKeywords: 'IntoTheBattle, TikTok LIVE',
  contentHtml: `
    <p>Turn TikTok LIVE chat into a playable battle arena.</p>
    <h2>What this page covers</h2>
    <ul>
      <li>How creators launch faster.</li>
      <li>Why viewers understand the fight.</li>
    </ul>
    <p>Read more on: <a href="https://www.intothebattle.com/how-to-play">How to play</a>.</p>
    <p>This is a generated draft from live site context and is ready for SEO review before publishing.</p>
  `,
};

const body = buildWritefreelyPostBody(post);
assert(body.includes('## What this page covers'), 'WriteFreely body should preserve headings as Markdown');
assert(body.includes('- How creators launch faster.'), 'WriteFreely body should preserve list items as Markdown');
assert(body.includes('[How to play](https://www.intothebattle.com/how-to-play)'), 'WriteFreely body should preserve links as Markdown');
assert(!body.includes('<p>') && !body.includes('<li>'), 'WriteFreely body should not contain raw HTML tags');
assert(!body.includes('generated draft from live site context'), 'WriteFreely body should remove internal generated-draft notice');

const payload = renderWritefreelyPayload(post);
assert(payload.content === body, 'Webhook payload should include markdown-ready content');
assert(payload.contentHtml.includes('<h2>What this page covers</h2>'), 'Webhook payload should retain sanitized HTML for bridges that use it');
assert(!payload.contentHtml.includes('generated draft from live site context'), 'Webhook payload HTML should remove internal generated-draft notice');
assert(payload.slug === post.slug, 'Webhook payload should include slug');

const blogEngineSource = fs.readFileSync(new URL('../tiktokbr/services/blogEngine.js', import.meta.url), 'utf8');
const insertMatch = blogEngineSource.match(/INSERT INTO local_blog_posts\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/);
assert(insertMatch, 'Blog engine must define a local_blog_posts insert');
const insertColumns = insertMatch[1].split(',').map(value => value.trim()).filter(Boolean);
const insertExpressions = insertMatch[2].split(',').map(value => value.trim()).filter(Boolean);
assert(
  insertColumns.length === insertExpressions.length,
  `local_blog_posts insert has ${insertColumns.length} columns but ${insertExpressions.length} expressions`
);

console.log(JSON.stringify({
  ok: true,
  publishMethod: cfg.publishMethod,
  collectionAlias: cfg.collectionAlias,
  markdownLength: body.length,
}, null, 2));
