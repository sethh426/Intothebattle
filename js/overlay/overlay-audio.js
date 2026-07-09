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
  });
  const defaultMasterVolume = 0.5;

  global.IntoTheBattleOverlayAudio = Object.freeze({
    defaultAudioConfig,
    defaultMasterVolume,
  });
})(window);
