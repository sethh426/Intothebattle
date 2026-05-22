import jwt from 'jsonwebtoken';

const sub = process.argv[2];
if (!sub) {
  console.error('Usage: node scripts/make_claim_token.js <subscription-id> [ttl_seconds]');
  process.exit(2);
}
const secret = process.env.CLAIM_JWT_SECRET || process.env.JWT_SECRET || 'devsecret';
const ttl = Number(process.argv[3] || process.env.CLAIM_TOKEN_TTL || 3600);
const token = jwt.sign({ sub }, secret, { expiresIn: ttl });
console.log(`/claim?sub=${encodeURIComponent(sub)}&t=${encodeURIComponent(token)}`);
