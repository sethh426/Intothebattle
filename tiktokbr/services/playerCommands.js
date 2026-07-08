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

const PLAYER_UTILITY_COMMAND_LOOKUP = Object.freeze(
  Object.entries(PLAYER_UTILITY_COMMAND_ALIASES).reduce((lookup, [canonical, aliases]) => {
    aliases.forEach(alias => { lookup[alias] = canonical; });
    return lookup;
  }, {})
);

export const VIEWER_COMMAND_TICKER_ITEMS = Object.freeze([
  'Any comment, like, follow, share, or gift enters you',
  'Targets: @name | @horde | @boss',
  'Regular chat: enters you and sends a random 5-damage attack',
  'Attacks: @name | @horde | @boss | !laser @name | !fire @name',
  'Icon: !emoji <emoji> or !<emoji>',
  'Basic attacks: !attack @name / !hit @name / !strike @name / !fight @name',
  'Effects: !laser @name | !fire @name | !nova @name | !railgun @name | !nuke @name',
  'Defense: !shield / !guard / !block',
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
    { command: 'engage', detail: 'enter arena' },
    { command: '@name', detail: 'hit a player' },
    { command: 'chat', detail: 'weak random attack' },
    { command: '!attack @name', detail: 'stronger player hit' },
    { command: '!attack @horde', detail: 'hit The Horde' },
    { command: '!attack @boss', detail: 'hit the boss' },
    { command: '!shield', detail: 'block damage' },
    { command: '!heal @name', detail: 'heal self or ally' },
    { command: '!commands', detail: 'show help' },
  ]),
});

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
    token = String(explicit[2] || '').toLowerCase();
    canonical = PLAYER_UTILITY_COMMAND_LOOKUP[token];
    if (!canonical) return null;
    prefixed = true;
    const commandStart = explicit.index + explicit[0].search(/[!/]/);
    const commandEnd = explicit.index + explicit[0].length;
    rest = `${raw.slice(0, commandStart)} ${raw.slice(commandEnd)}`.trim();
  } else {
    const match = raw.match(/^([a-z][a-z0-9_-]*)([\s\S]*)$/i);
    if (!match) return null;
    token = String(match[1] || '').toLowerCase();
    canonical = PLAYER_UTILITY_COMMAND_LOOKUP[token];
    if (!canonical) return null;
    rest = String(match[2] || '').trim();
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
