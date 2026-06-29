(function attachOverlayNormalizers(global) {
  'use strict';

  const approvedEffects = Object.freeze(['beam', 'laser', 'arc', 'sphere', 'railgun', 'comet', 'pulse', 'void']);
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
    pulse: 'pulse',
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
    gravity: 'void',
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
