(function attachOverlayStageConfig(global) {
  'use strict';

  const zones = Object.freeze({
    banner: Object.freeze({ left: 0.205, top: 0.065, right: 0.795, bottom: 0.154 }),
    players: Object.freeze({ left: 0.075, top: 0.225, right: 0.925, bottom: 0.485 }),
    effects: Object.freeze({ left: 0.17, top: 0.47, right: 0.83, bottom: 0.705 }),
    boss: Object.freeze({ left: 0.30, top: 0.465, right: 0.70, bottom: 0.705 }),
    horde: Object.freeze({ left: 0.062, top: 0.725, right: 0.938, bottom: 0.881 }),
    status: Object.freeze({ left: 0.36, top: 0.925, right: 0.64, bottom: 0.968 }),
  });

  global.IntoTheBattleOverlayStageConfig = Object.freeze({
    framePad: 0.06,
    zones,
  });
})(window);
