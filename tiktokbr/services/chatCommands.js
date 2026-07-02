export function sanitizeIconEmoji(value = '') {
  const token = String(value || '').trim().split(/\s+/)[0] || '';
  const cleaned = token.replace(/[<>{}[\]\\]/g, '').trim();
  return Array.from(cleaned).slice(0, 4).join('');
}

export function extractIconEmojiCommand(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  const keywordMatch = text.match(/^[!/]\s*emoji(?:(\s+)(.+)|(.+))$/i);
  if (keywordMatch) {
    const compactArg = keywordMatch[3] || '';
    if (compactArg && /^[a-z0-9_-]/i.test(compactArg)) return '';
    return sanitizeIconEmoji(keywordMatch[2] || compactArg);
  }

  const directMatch = text.match(/^[!/]\s*(\S+)/u);
  if (!directMatch) return '';

  const token = directMatch[1] || '';
  if (/^[a-z0-9_-]+$/i.test(token)) return '';
  return sanitizeIconEmoji(token);
}
