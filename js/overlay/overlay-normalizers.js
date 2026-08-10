(function attachOverlayNormalizers(global) {
  'use strict';

  const approvedEffects = Object.freeze([
    'beam', 'laser', 'arc', 'sphere', 'railgun', 'comet', 'pulse', 'void',
    'prism', 'plasma', 'cryo', 'ion', 'sonic', 'gravity', 'glitch', 'orbital', 'drone', 'shard',
    'nova', 'tempest', 'rift',
  ]);
  const defaultEffect = 'beam';
  const effectAliases = Object.freeze({
    beam: 'beam',
    laser: 'laser',
    neon: 'laser',
    rail: 'railgun',
    railgun: 'railgun',
    arc: 'arc',
    shock: 'arc',
    bolt: 'arc',
    lightning: 'arc',
    sphere: 'sphere',
    orb: 'sphere',
    projectile: 'comet',
    comet: 'comet',
    fire: 'comet',
    flame: 'comet',
    meteor: 'comet',
    prism: 'prism',
    plasma: 'plasma',
    cryo: 'cryo',
    ice: 'cryo',
    freeze: 'cryo',
    ion: 'ion',
    sonic: 'sonic',
    gravity: 'gravity',
    singularity: 'gravity',
    glitch: 'glitch',
    orbital: 'orbital',
    orbit: 'orbital',
    drone: 'drone',
    shard: 'shard',
    shards: 'shard',
    pulse: 'pulse',
    nova: 'nova',
    starburst: 'nova',
    flare: 'nova',
    tempest: 'tempest',
    storm: 'tempest',
    thunder: 'tempest',
    cyclone: 'tempest',
    rift: 'rift',
    portal: 'rift',
    slash: 'rift',
    phase: 'rift',
    ripple: 'pulse',
    wave: 'pulse',
    bubble: 'pulse',
    bubbles: 'pulse',
    water: 'pulse',
    explosion: 'pulse',
    boom: 'pulse',
    nuke: 'pulse',
    nukes: 'pulse',
    void: 'void',
    blackhole: 'void',
    vortex: 'void',
    dark: 'void',
    bullet: 'railgun',
    shot: 'railgun',
    shell: 'railgun',
    gift: 'beam',
    hearts: 'beam',
    heart: 'beam',
    boss: 'railgun',
    bosswave: 'railgun',
    default: 'beam',
  });

  function normalizeEffectType(value, fallback = defaultEffect) {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const mapped = effectAliases[key] || key;
    if (approvedEffects.includes(mapped)) return mapped;
    if (approvedEffects.includes(fallback)) return fallback;
    return defaultEffect;
  }

  global.IntoTheBattleOverlayNormalizers = Object.freeze({
    approvedEffects,
    defaultEffect,
    effectAliases,
    normalizeEffectType,
  });
})(window);
