import '../loadEnv.js';
import postmark from 'postmark';

const token = process.env.POSTMARK_API_TOKEN;
const testEmail = process.env.POSTMARK_TEST_EMAIL;

if (!token) {
  console.error('POSTMARK_API_TOKEN is not set.');
  process.exit(1);
}

if (!testEmail) {
  console.error('POSTMARK_TEST_EMAIL is not set.');
  process.exit(1);
}

const client = new postmark.ServerClient(token);

async function run() {
  try {
    const response = await client.sendEmail({
      From: process.env.EMAIL_FROM || `Battle Royale <no-reply@${new URL(process.env.APP_BASE_URL || 'http://localhost').hostname}>`,
      To: testEmail,
      Subject: 'Postmark connectivity test',
      HtmlBody: '<p>This is a Postmark connectivity test from Battle Royale LIVE.</p>',
      MessageStream: 'outbound',
    });
    console.log('Postmark API test succeeded:', response);
  } catch (err) {
    console.error('Postmark API test failed:', err);
    process.exit(1);
  }
}

run();
