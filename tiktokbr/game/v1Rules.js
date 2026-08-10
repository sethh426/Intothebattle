export const V1_MODES = Object.freeze({
  FREE_FOR_ALL: 'free_for_all',
  HORDE_SURVIVAL: 'horde_survival',
  BOSS_RAID: 'boss_raid',
});

export const V1_PHASES = Object.freeze({
  LOBBY: 'lobby',
  BATTLE: 'battle',
  FINAL_EVENT: 'final_event',
  RESULTS: 'results',
});

export const V1_RULES = Object.freeze({
  maxHp: 300,
  maxShield: 50,
  maxEnergy: 100,
  startingEnergy: 0,
  basicDamage: 10,
  basicCooldownMs: 3000,
  globalCooldownMs: 1000,
  critChance: 0.05,
  critMultiplier: 1.5,
  respawnDelayMs: 8000,
  spawnProtectionMs: 2000,
  battleChargeMax: 3,
  battleChargeDamage: 2,
  battleChargeExpiresMs: 30000,
  maxPlayerHitPct: 0.35,
  commentEnergy: 2,
  commentEnergyCooldownMs: 4000,
  commentScore: 1,
  likeHealMin: 8,
  likeHealMax: 36,
  likeHealPerHp: 2,
  shareEnergy: 15,
  shareSelfFullHeal: true,
  repostEnergy: 20,
  repostSelfHeal: 80,
  repostRallyHeal: 36,
  followEnergy: 20,
  followSelfHeal: 45,
  giftHealMin: 12,
  giftHealMax: 80,
  giftHealPerDiamond: 2,
  successfulBasicEnergy: 3,
  successfulHitEnergy: 2,
  lobbyMs: 30000,
  battleMs: 4 * 60 * 1000,
  finalEventMs: 60000,
  resultsMs: 20000,
  bossBaseHp: 2000,
  bossHpPerPlayer: 150,
  bossArmor: 500,
  bossAttackIntervalMs: 8000,
  bossDurationMs: 90000,
  bossEnragePct: 0.2,
  arenaPowerThreshold: 100,
  arenaPowerCountdownMs: 10000,
  arenaPowerDurationMs: 20000,
  arenaPowerMultipliers: Object.freeze([1.5, 1.35, 1.2]),
});

export const V1_ABILITIES = Object.freeze({
  basic: Object.freeze({
    key: 'basic',
    aliases: Object.freeze(['attack', 'hit', 'strike', 'fight']),
    effect: 'laser',
    description: 'BASIC STRIKE',
    damage: 10,
    energyCost: 0,
    cooldownMs: 3000,
    target: 'enemy',
  }),
  laser: Object.freeze({
    key: 'laser',
    aliases: Object.freeze(['laser', 'beam']),
    effect: 'laser',
    description: 'LASER',
    damage: 18,
    energyCost: 20,
    cooldownMs: 7000,
    shieldPenetration: 0.25,
    target: 'enemy',
  }),
  plasma: Object.freeze({
    key: 'plasma',
    aliases: Object.freeze(['plasma']),
    effect: 'plasma',
    description: 'PLASMA',
    damage: 15,
    shieldDamageMultiplier: 2,
    energyCost: 25,
    cooldownMs: 9000,
    target: 'enemy',
  }),
  fire: Object.freeze({
    key: 'fire',
    aliases: Object.freeze(['fire', 'flame']),
    effect: 'fire',
    description: 'FIRE',
    damage: 12,
    energyCost: 25,
    cooldownMs: 10000,
    burnDamage: 4,
    burnTicks: 3,
    burnTickMs: 1000,
    target: 'enemy',
  }),
  shield: Object.freeze({
    key: 'shield',
    aliases: Object.freeze(['shield', 'guard', 'block', 'defend', 'protect']),
    effect: 'shield',
    description: 'SHIELD',
    shieldAmount: 25,
    energyCost: 20,
    cooldownMs: 12000,
    durationMs: 8000,
    target: 'self',
  }),
  heal: Object.freeze({
    key: 'heal',
    aliases: Object.freeze(['heal', 'hp', 'health']),
    effect: 'heal',
    description: 'HEAL',
    allyAmount: 20,
    selfAmount: 15,
    energyCost: 25,
    cooldownMs: 12000,
    fatigueWindowMs: 15000,
    fatigueSteps: Object.freeze([1, 0.75, 0.5, 0.25]),
    target: 'ally_or_self',
  }),
  nova: Object.freeze({
    key: 'nova',
    aliases: Object.freeze(['nova']),
    effect: 'nova',
    description: 'NOVA',
    damage: 12,
    energyCost: 50,
    cooldownMs: 20000,
    maxTargets: 5,
    target: 'area',
  }),
});

const ATTACK_LOOKUP = Object.freeze(Object.values(V1_ABILITIES).reduce((lookup, ability) => {
  ability.aliases.forEach(alias => { lookup[alias] = ability.key; });
  return lookup;
}, {}));

const UTILITY_LOOKUP = Object.freeze({
  commands: 'help',
  command: 'help',
  comments: 'help',
  comment: 'help',
  cmd: 'help',
  help: 'help',
  howto: 'help',
  team: 'team',
  squad: 'team',
  join: 'join',
  spawn: 'join',
  play: 'join',
  start: 'join',
  enter: 'join',
  ready: 'join',
});

export const V1_COMMAND_TICKER_ITEMS = Object.freeze([
  'Any comment, like, follow, share, or gift enters you and charges energy',
  'Plain chat builds energy and battle charges. It does not attack randomly.',
  'Basic: !attack @name | !attack @horde | !attack @boss',
  'Effects: !laser @name | !plasma @name | !fire @name | !nova',
  'Defense/support: !shield | !heal | !heal @name',
  'Teams/help: !team red | !team blue | !commands',
]);

export const V1_COMMAND_SHOWCASE = Object.freeze({
  code: 'CMD',
  kicker: 'PLAYER COMMANDS',
  title: 'PLAY BY ENGAGING',
  meta: 'Build energy, aim attacks, protect allies',
  durationMs: 13000,
  charge: 86,
  priority: 88,
  tickerItems: V1_COMMAND_TICKER_ITEMS,
  commands: Object.freeze([
    { command: 'chat', detail: '+energy, no random hit' },
    { command: '!attack @name', detail: 'basic strike' },
    { command: '!attack @horde', detail: 'hit the horde' },
    { command: '!attack @boss', detail: 'hit the boss' },
    { command: '!laser @name', detail: 'pierce shield' },
    { command: '!plasma @name', detail: 'break shield' },
    { command: '!fire @name', detail: 'burn target' },
    { command: '!nova', detail: 'area blast' },
    { command: '!shield', detail: 'gain barrier' },
    { command: '!heal @name', detail: 'restore ally' },
    { command: '!team red', detail: 'pick team' },
    { command: '!commands', detail: 'show help' },
  ]),
});

export function normalizeV1Mode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (['ffa', 'free_for_all', 'freeforall'].includes(normalized)) return V1_MODES.FREE_FOR_ALL;
  if (['boss', 'boss_raid', 'raid'].includes(normalized)) return V1_MODES.BOSS_RAID;
  if (['horde', 'horde_survival', 'survival'].includes(normalized)) return V1_MODES.HORDE_SURVIVAL;
  return V1_MODES.HORDE_SURVIVAL;
}

export function normalizeV1Phase(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return Object.values(V1_PHASES).includes(normalized) ? normalized : V1_PHASES.BATTLE;
}

export function normalizeV1Name(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function cleanV1Mention(rawMention = '') {
  return String(rawMention || '').trim()
    .replace(/^@+/, '')
    .replace(/^[^\w.]+/, '')
    .replace(/[^\w.]+$/g, '');
}

export function extractV1Mentions(text = '') {
  return [...String(text || '').matchAll(/@\s*([^\s@]+)/g)]
    .map(match => cleanV1Mention(match[1]))
    .filter(Boolean);
}

export function parseV1ChatCommand(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { type: 'comment', raw, rest: '' };
  const explicit = raw.match(/(?:^|\s)([!/])\s*([a-z][a-z0-9_-]*)/i);
  if (!explicit) return { type: 'comment', raw, rest: raw };

  const token = String(explicit[2] || '').toLowerCase();
  const commandStart = explicit.index + explicit[0].search(/[!/]/);
  const commandEnd = explicit.index + explicit[0].length;
  const rest = `${raw.slice(0, commandStart)} ${raw.slice(commandEnd)}`.trim();

  const abilityKey = ATTACK_LOOKUP[token];
  if (abilityKey) {
    return {
      type: 'ability',
      abilityKey,
      command: token,
      ability: V1_ABILITIES[abilityKey],
      rest,
      raw,
      prefixed: true,
    };
  }

  const utility = UTILITY_LOOKUP[token];
  if (utility) {
    return {
      type: 'utility',
      canonical: utility,
      command: token,
      rest,
      raw,
      prefixed: true,
    };
  }

  return { type: 'unknown', command: token, rest, raw, prefixed: true };
}

export function viewerCommandTextV1() {
  return [
    `${V1_COMMAND_SHOWCASE.title}:`,
    ...V1_COMMAND_TICKER_ITEMS,
  ].join('\n');
}

export function commandBannerShowcasePayloadV1() {
  return {
    banners: [{
      code: V1_COMMAND_SHOWCASE.code,
      kicker: V1_COMMAND_SHOWCASE.kicker,
      title: V1_COMMAND_SHOWCASE.title,
      meta: V1_COMMAND_SHOWCASE.meta,
      commands: V1_COMMAND_SHOWCASE.commands,
      tickerItems: V1_COMMAND_SHOWCASE.tickerItems,
      durationMs: V1_COMMAND_SHOWCASE.durationMs,
      priority: V1_COMMAND_SHOWCASE.priority,
      charge: V1_COMMAND_SHOWCASE.charge,
    }],
    createdAt: Date.now(),
  };
}

export function publicV1AbilityCatalog() {
  return Object.fromEntries(Object.entries(V1_ABILITIES).map(([key, ability]) => [key, {
    key,
    aliases: [...ability.aliases],
    effect: ability.effect,
    description: ability.description,
    damage: ability.damage || 0,
    energyCost: ability.energyCost || 0,
    cooldownMs: ability.cooldownMs || 0,
    target: ability.target,
  }]));
}
