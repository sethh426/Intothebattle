import crypto from 'crypto';

const MAX_SUMMARY_LENGTH = 900;

const SECURITY_PATTERNS = [
  { label: 'hacking the system', pattern: /\bhack(?:ed|ing)?\s+(?:the|your|this|our)?\s*(?:system|site|server|database|db|admin|platform|app|account)s?\b/i },
  { label: 'threat to hack', pattern: /\b(?:i|we|im|i'm|ill|i'll|going to|gonna|will)\s+(?:try\s+to\s+)?hack\b/i },
  { label: 'system compromise', pattern: /\b(?:breach(?:ed|ing)?|compromis(?:e|ed|ing))\s+(?:the|your|this|our)?\s*(?:system|site|server|database|db|admin|platform|app|account)s?\b/i },
  { label: 'exploit attempt', pattern: /\bexploit(?:ed|ing)?\s+(?:the|your|this|our)?\s*(?:system|site|server|database|db|admin|platform|app|account|vulnerability|bug)s?\b/i },
  { label: 'injection attack', pattern: /\b(?:sql\s*injection|xss|cross[-\s]?site\s+scripting|csrf|rce|remote\s+code\s+execution)\b/i },
  { label: 'credential attack', pattern: /\b(?:credential\s+stuffing|password\s+spray(?:ing)?|brute[-\s]?force)\b/i },
  { label: 'service disruption', pattern: /\b(?:ddos|denial\s+of\s+service)\b/i },
  { label: 'ownership claim', pattern: /\b(?:pwn(?:ed)?|owned)\s+(?:the|your|this|our)?\s*(?:system|site|server|database|db|admin|platform|app|account)s?\b/i },
];

function textFromFields(fields) {
  if (Array.isArray(fields)) return fields.filter(Boolean).join('\n');
  if (!fields || typeof fields !== 'object') return String(fields || '');
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${String(value || '')}`)
    .join('\n');
}

export function detectSecurityAbuse(fields) {
  const text = textFromFields(fields).replace(/\s+/g, ' ').trim();
  if (!text) return { flagged: false, matchedTerms: [], text: '' };

  const matchedTerms = SECURITY_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  return {
    flagged: matchedTerms.length > 0,
    matchedTerms,
    text,
  };
}

export function publicSecurityRejectionMessage() {
  return 'Security-related threats or compromise claims are not allowed here.';
}

export function summarizeSecurityPayload(fields, maxLength = MAX_SUMMARY_LENGTH) {
  return textFromFields(fields)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(80, Number(maxLength) || MAX_SUMMARY_LENGTH));
}

function hashValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const salt = process.env.SECURITY_EVENT_HASH_SALT || process.env.JWT_SECRET || 'local-security-events';
  return crypto.createHmac('sha256', salt).update(text).digest('hex');
}

function requestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.ip || req?.socket?.remoteAddress || '';
}

export function recordSecurityEvent(database, {
  req = null,
  eventType = 'security_abuse_detected',
  actorUserId = null,
  actorEmail = '',
  endpoint = '',
  actionTaken = 'blocked',
  detection = null,
  payloadSummary = '',
} = {}) {
  if (!database?.prepare) return false;
  const matchedTerms = Array.isArray(detection?.matchedTerms) ? detection.matchedTerms.join(', ') : '';
  try {
    database.prepare(`
      INSERT INTO security_events (
        event_type, actor_user_id, actor_email, ip_hash, user_agent_hash,
        endpoint, action_taken, matched_terms, payload_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      eventType,
      actorUserId || null,
      String(actorEmail || '').trim().toLowerCase().slice(0, 254) || null,
      hashValue(requestIp(req)),
      hashValue(req?.get?.('user-agent') || req?.headers?.['user-agent'] || ''),
      String(endpoint || req?.originalUrl || req?.url || '').slice(0, 240),
      String(actionTaken || 'blocked').slice(0, 80),
      matchedTerms.slice(0, 300),
      String(payloadSummary || detection?.text || '').slice(0, MAX_SUMMARY_LENGTH)
    );
    return true;
  } catch (err) {
    console.warn('Failed to record security event:', err?.message || err);
    return false;
  }
}
