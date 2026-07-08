const TEXT_KEYS = [
  'comment',
  'message',
  'text',
  'content',
  'displayText',
  'display_text',
  'value',
];

function cleanLiveText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text === '[object Object]') return '';
  return text;
}

function extractFromValue(value, depth = 0, seen = new Set()) {
  const direct = cleanLiveText(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractFromValue(item, depth + 1, seen);
      if (text) return text;
    }
    return '';
  }

  for (const key of TEXT_KEYS) {
    const text = extractFromValue(value[key], depth + 1, seen);
    if (text) return text;
  }
  return '';
}

export function extractLiveCommentText(eventPayload = {}) {
  return extractFromValue(eventPayload);
}
