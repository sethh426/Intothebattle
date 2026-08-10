import {
  V1_ABILITIES,
  V1_COMMAND_SHOWCASE,
  V1_COMMAND_TICKER_ITEMS,
  commandBannerShowcasePayloadV1,
  parseV1ChatCommand,
  viewerCommandTextV1,
} from '../game/v1Rules.js';

export const PLAYER_ATTACK_COMMANDS = Object.freeze(Object.fromEntries(
  Object.values(V1_ABILITIES).flatMap(ability => ability.aliases.map(alias => [alias, {
    effect: ability.effect,
    multiplier: 1,
    description: ability.description,
    abilityKey: ability.key,
    damage: ability.damage || 0,
    energyCost: ability.energyCost || 0,
    cooldownMs: ability.cooldownMs || 0,
  }]))
));

export const DEPRECATED_ATTACK_COMMANDS = Object.freeze([
  'bubble',
  'bubbles',
  'water',
  'ripple',
  'inferno',
  'sphere',
  'orbital',
  'nuke',
  'tempest',
  'rift',
]);

export const PLAYER_UTILITY_COMMAND_ALIASES = Object.freeze({
  join: Object.freeze(['join', 'spawn', 'play', 'start', 'enter', 'ready']),
  help: Object.freeze(['help', 'commands', 'command', 'comments', 'comment', 'cmd', 'howto']),
  team: Object.freeze(['team', 'squad']),
});

export const VIEWER_COMMAND_TICKER_ITEMS = V1_COMMAND_TICKER_ITEMS;
export const VIEWER_COMMAND_SHOWCASE = V1_COMMAND_SHOWCASE;

export function parseAttackCommand(text = '', options = {}) {
  const command = parseV1ChatCommand(text);
  if (command.type !== 'ability') return null;
  if (options.explicitOnly && command.prefixed !== true) return null;
  return PLAYER_ATTACK_COMMANDS[command.command] || null;
}

export function parseUtilityCommand(text = '') {
  const command = parseV1ChatCommand(text);
  if (command.type !== 'utility') return null;
  return {
    canonical: command.canonical,
    command: command.command,
    rest: command.rest,
    prefixed: command.prefixed,
  };
}

export function viewerCommandText() {
  return viewerCommandTextV1();
}

export function commandBannerShowcasePayload() {
  return commandBannerShowcasePayloadV1();
}
