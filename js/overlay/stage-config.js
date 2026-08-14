(function attachOverlayStageConfig(global) {
  'use strict';

  const zones = Object.freeze({
    banner: Object.freeze({ left: 0.11, top: 0.52, right: 0.89, bottom: 0.75 }),
    players: Object.freeze({ left: 0.055, top: 0.18, right: 0.945, bottom: 0.49 }),
    effects: Object.freeze({ left: 0.14, top: 0.49, right: 0.86, bottom: 0.76 }),
    boss: Object.freeze({ left: 0.27, top: 0.49, right: 0.73, bottom: 0.635 }),
    horde: Object.freeze({ left: 0.04, top: 0.76, right: 0.96, bottom: 0.91 }),
    status: Object.freeze({ left: 0.36, top: 0.925, right: 0.64, bottom: 0.968 }),
  });

  global.IntoTheBattleOverlayStageConfig = Object.freeze({
    framePad: 0.06,
    zones,
  });
})(window);
