import '../loadEnv.js';
import {
  getEmailDiagnostics,
  sendTransactionalEmail,
} from '../tiktokbr/email/postmarkMailer.js';

const testEmail = process.env.POSTMARK_TEST_EMAIL;

if (!testEmail) {
  console.error('POSTMARK_TEST_EMAIL is not set.');
  process.exit(1);
}

async function run() {
  const diagnostics = getEmailDiagnostics();
  console.log('Email diagnostics:', diagnostics);
  if (!diagnostics.enabled) {
    console.error('Postmark email is not enabled. Set POSTMARK_API_TOKEN and make sure EMAIL_DISABLE_SEND is not true.');
    process.exit(1);
  }

  try {
    const response = await sendTransactionalEmail({
      to: testEmail,
      subject: 'IntoTheBattle Postmark connectivity test',
      tag: 'postmark-test',
      metadata: { source: 'scripts/test_postmark.js' },
      htmlBody: '<p>This is a Postmark connectivity test from IntoTheBattle.</p>',
      textBody: 'This is a Postmark connectivity test from IntoTheBattle.',
    });
    console.log('Postmark API test succeeded:', response);
  } catch (err) {
    console.error('Postmark API test failed:', err);
    process.exit(1);
  }
}

run();
