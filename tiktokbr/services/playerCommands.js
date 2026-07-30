export const PLAYER_ATTACK_COMMANDS = Object.freeze({
  attack:     { effect: 'laser',      multiplier: 1.5, description: 'ATTACK' },
  hit:        { effect: 'laser',      multiplier: 1.5, description: 'HIT' },
  strike:     { effect: 'laser',      multiplier: 1.5, description: 'STRIKE' },
  fight:      { effect: 'laser',      multiplier: 1.5, description: 'FIGHT' },
  laser:      { effect: 'laser',      multiplier: 1.5, description: 'LASER' },
  beam:       { effect: 'beam',       multiplier: 1.5, description: 'BEAM' },
  fire:       { effect: 'fire',       multiplier: 2.0, description: 'FIRE' },
  flame:      { effect: 'fire',       multiplier: 2.0, description: 'FLAME' },
  inferno:    { effect: 'fire',       multiplier: 3.5, description: 'INFERNO' },
  neon:       { effect: 'neon',       multiplier: 1.5, description: 'NEON' },
  sphere:     { effect: 'sphere',     multiplier: 3.0, description: 'SPHERE' },
  orb:        { effect: 'sphere',     multiplier: 3.0, description: 'ORB' },
  projectile: { effect: 'projectile', multiplier: 1.0, description: 'PROJECTILE' },
  gift:       { effect: 'gift',       multiplier: 0.5, description: 'GIFT' },
  hearts:     { effect: 'gift',       multiplier: 0.5, description: 'HEARTS' },
  nova:       { effect: 'pulse',      multiplier: 3.0, description: 'NOVA BLAST' },
  wave:       { effect: 'arc',        multiplier: 2.5, description: 'SHOCK WAVE' },
  spiral:     { effect: 'arc',        multiplier: 3.4, description: 'ARC SPIRAL' },
  shock:      { effect: 'arc',        multiplier: 2.5, description: 'SHOCK ARC' },
  arc:        { effect: 'arc',        multiplier: 2.5, description: 'ARC STRIKE' },
  bullet:     { effect: 'bullet',     multiplier: 1.8, description: 'BULLET' },
  shell:      { effect: 'bullet',     multiplier: 1.8, description: 'SHELL SHOT' },
  shot:       { effect: 'bullet',     multiplier: 1.8, description: 'SHOT' },
  rail:       { effect: 'railgun',    multiplier: 2.8, description: 'RAIL SHOT' },
  railgun:    { effect: 'railgun',    multiplier: 2.8, description: 'RAILGUN' },
  comet:      { effect: 'comet',      multiplier: 3.2, description: 'COMET' },
  meteor:     { effect: 'comet',      multiplier: 4.2, description: 'METEOR' },
  prism:      { effect: 'prism',      multiplier: 2.2, description: 'PRISM' },
  plasma:     { effect: 'plasma',     multiplier: 2.4, description: 'PLASMA' },
  cryo:       { effect: 'cryo',       multiplier: 2.0, description: 'CRYO' },
  ion:        { effect: 'ion',        multiplier: 1.7, description: 'ION' },
  sonic:      { effect: 'sonic',      multiplier: 2.1, description: 'SONIC' },
  gravity:    { effect: 'gravity',    multiplier: 3.2, description: 'GRAVITY' },
  glitch:     { effect: 'glitch',     multiplier: 2.3, description: 'GLITCH' },
  orbital:    { effect: 'orbital',    multiplier: 3.6, description: 'ORBITAL' },
  drone:      { effect: 'drone',      multiplier: 1.6, description: 'DRONE' },
  shard:      { effect: 'shard',      multiplier: 2.0, description: 'SHARD' },
  boom:       { effect: 'explosion',  multiplier: 4.0, description: 'BOOM' },
  explode:    { effect: 'explosion',  multiplier: 4.0, description: 'EXPLODE' },
  explosion:  { effect: 'explosion',  multiplier: 4.0, description: 'EXPLOSION' },
  nuke:       { effect: 'explosion',  multiplier: 6.0, description: 'NUKE' },
  nukes:      { effect: 'explosion',  multiplier: 6.0, description: 'NUKES' },
});

export const DEPRECATED_ATTACK_COMMANDS = Object.freeze([
  'bubble',
  'bubbles',
  'water',
  'ripple',
]);

export const PLAYER_UTILITY_COMMAND_ALIASES = Object.freeze({
  join: Object.freeze(['join', 'spawn', 'play', 'start', 'enter', 'ready']),
  help: Object.freeze(['help', 'commands', 'command', 'comments', 'comment', 'cmd', 'howto']),
  team: Object.freeze(['team', 'squad']),
  heal: Object.freeze(['heal', 'hp', 'health']),
  shield: Object.freeze(['shield', 'guard', 'block', 'defend', 'protect']),
});

export const PLAYER_ATTACK_COMMAND_WORDS = Object.freeze(Object.keys(PLAYER_ATTACK_COMMANDS));
export const PLAYER_SHIELD_DEFAULT_SECONDS = 10;
export const PLAYER_SHIELD_MAX_SECONDS = 100;

const PLAYER_UTILITY_COMMAND_LOOKUP = Object.freeze(
  Object.entries(PLAYER_UTILITY_COMMAND_ALIASES).reduce((lookup, [canonical, aliases]) => {
    aliases.forEach(alias => { lookup[alias] = canonical; });
    return lookup;
  }, {})
);

const ALL_ATTACK_COMMAND_TEXT = PLAYER_ATTACK_COMMAND_WORDS
  .map(command => `!${command} @name`)
  .join(' | ');

export const VIEWER_COMMAND_TICKER_ITEMS = Object.freeze([
  'Any comment, like, follow, share, or gift enters you',
  'Tap likes = gain HP',
  'Share or repost = refill health',
  'Gift = unstoppable power and breaks shields',
  'Targets: !laser @name | !laser @boss | !laser @horde',
  'Shield: shield 5 through shield 100',
  'Icon: !emoji <emoji> or !<emoji>',
  `All attacks: ${ALL_ATTACK_COMMAND_TEXT}`,
  'Support: !heal or !heal @name',
  'Teams/help: !team red / !team leave / !commands or !comments',
]);

export const VIEWER_COMMAND_SHOWCASE = Object.freeze({
  code: 'CMD',
  kicker: 'PLAYER COMMANDS',
  title: 'PLAY BY ENGAGING',
  meta: 'Comment, like, follow, share, or gift',
  durationMs: 13000,
  charge: 86,
  priority: 88,
  tickerItems: VIEWER_COMMAND_TICKER_ITEMS,
  commands: Object.freeze([
    { command: 'tap', detail: 'gain HP' },
    { command: 'share/repost', detail: 'refill health' },
    { command: 'gift', detail: 'unstoppable' },
    { command: '!laser @name', detail: 'attack player' },
    { command: '!laser @boss', detail: 'attack boss' },
    { command: '!laser @horde', detail: 'attack horde' },
    { command: 'shield 5', detail: '5s shield' },
    { command: 'shield 100', detail: 'max shield' },
    { command: '!commands', detail: 'all attacks' },
  ]),
});

function splitCompactUtilityToken(token) {
  const value = String(token || '').toLowerCase();
  const compact = value.match(/^([a-z]+)(\d{1,4})$/);
  if (!compact) return { token: value, suffix: '' };
  const base = compact[1];
  if (!PLAYER_UTILITY_COMMAND_LOOKUP[base]) return { token: value, suffix: '' };
  return { token: base, suffix: compact[2] };
}

export function parseShieldDurationMs(text = '', fallbackMs = PLAYER_SHIELD_DEFAULT_SECONDS * 1000) {
  const raw = String(text || '').trim();
  const fallback = Math.max(1000, Math.min(PLAYER_SHIELD_MAX_SECONDS * 1000, Math.round(Number(fallbackMs) || PLAYER_SHIELD_DEFAULT_SECONDS * 1000)));
  const aliases = PLAYER_UTILITY_COMMAND_ALIASES.shield.join('|');
  const match = raw.match(new RegExp(`(?:^|\\s)[!/]?\\s*(?:${aliases})(?![a-z])\\s*[:=-]?\\s*(\\d{1,4})?\\s*(?:s|sec|secs|second|seconds)?\\b`, 'i'));
  if (!match || !match[1]) return fallback;
  const seconds = Math.max(1, Math.min(PLAYER_SHIELD_MAX_SECONDS, Math.round(Number(match[1]) || PLAYER_SHIELD_DEFAULT_SECONDS)));
  return seconds * 1000;
}

export function parseAttackCommand(text = '', options = {}) {
  const value = String(text || '');
  const explicit = value.match(/(?:^|\s)[!/]\s*([a-z][a-z0-9_-]{1,24})/i);
  const mentionlessValue = value.replace(/@\s*([^\s@]+)/g, ' ');
  const rawCommand = explicit?.[1] || (options.explicitOnly ? '' : mentionlessValue.match(/\b([a-z][a-z0-9_-]{1,24})\b/i)?.[1]) || '';
  const normalized = String(rawCommand || '').toLowerCase().replace(/[^\w-].*$/, '');
  if (PLAYER_ATTACK_COMMANDS[normalized]) return PLAYER_ATTACK_COMMANDS[normalized];
  if (options.explicitOnly) return null;

  const words = mentionlessValue.toLowerCase().match(/[a-z][a-z0-9_-]*/g) || [];
  const naturalEffect = words.find(word => PLAYER_ATTACK_COMMANDS[word]);
  return naturalEffect ? PLAYER_ATTACK_COMMANDS[naturalEffect] : null;
}

export function parseUtilityCommand(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const explicit = raw.match(/(?:^|\s)([!/])\s*([a-z][a-z0-9_-]*)/i);
  let token = '';
  let canonical = '';
  let rest = '';
  let prefixed = false;

  if (explicit) {
    const split = splitCompactUtilityToken(explicit[2]);
    token = split.token;
    canonical = PLAYER_UTILITY_COMMAND_LOOKUP[token];
    if (!canonical) return null;
    prefixed = true;
    const commandStart = explicit.index + explicit[0].search(/[!/]/);
    const commandEnd = explicit.index + explicit[0].length;
    rest = `${raw.slice(0, commandStart)} ${split.suffix} ${raw.slice(commandEnd)}`.trim();
  } else {
    const match = raw.match(/^([a-z][a-z0-9_-]*)([\s\S]*)$/i);
    if (!match) return null;
    const split = splitCompactUtilityToken(match[1]);
    token = split.token;
    canonical = PLAYER_UTILITY_COMMAND_LOOKUP[token];
    if (!canonical) return null;
    rest = `${split.suffix} ${String(match[2] || '')}`.trim();
  }

  return {
    canonical,
    command: token,
    rest,
    prefixed,
  };
}

export function viewerCommandText() {
  return [
    `${VIEWER_COMMAND_SHOWCASE.title}:`,
    ...VIEWER_COMMAND_TICKER_ITEMS,
  ].join('\n');
}

export function commandBannerShowcasePayload() {
  return {
    banners: [{
      code: VIEWER_COMMAND_SHOWCASE.code,
      kicker: VIEWER_COMMAND_SHOWCASE.kicker,
      title: VIEWER_COMMAND_SHOWCASE.title,
      meta: VIEWER_COMMAND_SHOWCASE.meta,
      commands: VIEWER_COMMAND_SHOWCASE.commands,
      tickerItems: VIEWER_COMMAND_SHOWCASE.tickerItems,
      durationMs: VIEWER_COMMAND_SHOWCASE.durationMs,
      priority: VIEWER_COMMAND_SHOWCASE.priority,
      charge: VIEWER_COMMAND_SHOWCASE.charge,
    }],
    createdAt: Date.now(),
  };
}
