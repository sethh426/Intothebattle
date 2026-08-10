(function attachOverlayStageConfig(global) {
  'use strict';

  const zones = Object.freeze({
    banner: Object.freeze({ left: 0.12, top: 0.585, right: 0.88, bottom: 0.695 }),
    players: Object.freeze({ left: 0.075, top: 0.225, right: 0.925, bottom: 0.485 }),
    effects: Object.freeze({ left: 0.17, top: 0.47, right: 0.83, bottom: 0.705 }),
    boss: Object.freeze({ left: 0.23, top: 0.47, right: 0.77, bottom: 0.625 }),
    horde: Object.freeze({ left: 0.03, top: 0.75, right: 0.97, bottom: 0.94 }),
    status: Object.freeze({ left: 0.36, top: 0.925, right: 0.64, bottom: 0.968 }),
  });

  global.IntoTheBattleOverlayStageConfig = Object.freeze({
    framePad: 0.06,
    zones,
  });
})(window);
