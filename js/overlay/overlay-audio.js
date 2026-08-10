(function attachOverlayAudio(global) {
  'use strict';

  const defaultAudioConfig = Object.freeze({
    attack: 'sound1.mp3',
    gift: 'sound2.mp3',
    kill: 'sound3.mp3',
    respawn: 'sound4.mp3',
    heal: 'sound5.mp3',
    follow: 'sound6.mp3',
    socialBoost: 'sound6.mp3',
    engagementSurge: 'sound2.mp3',
    beam: 'sound4.mp3',
    laser: 'sound4.mp3',
    fire: 'sound2.mp3',
    flame: 'sound2.mp3',
    inferno: 'sound9.mp3',
    neon: 'sound7.mp3',
    sphere: 'sound7.mp3',
    orb: 'sound7.mp3',
    pulse: 'sound7.mp3',
    nova: 'sound7.mp3',
    starburst: 'sound7.mp3',
    tempest: 'sound4.mp3',
    storm: 'sound4.mp3',
    rift: 'sound9.mp3',
    portal: 'sound9.mp3',
    projectile: 'sound4.mp3',
    arc: 'sound4.mp3',
    bullet: 'sound4.mp3',
    railgun: 'sound9.mp3',
    comet: 'sound9.mp3',
    prism: 'sound7.mp3',
    plasma: 'sound2.mp3',
    cryo: 'sound4.mp3',
    ion: 'sound4.mp3',
    sonic: 'sound7.mp3',
    gravity: 'sound9.mp3',
    glitch: 'sound4.mp3',
    orbital: 'sound9.mp3',
    drone: 'sound4.mp3',
    shard: 'sound4.mp3',
    explosion: 'sound9.mp3',
  });
  const defaultMasterVolume = 0.5;

  global.IntoTheBattleOverlayAudio = Object.freeze({
    defaultAudioConfig,
    defaultMasterVolume,
  });
})(window);
