(function attachOverlayStageConfig(global) {
  'use strict';

  const zones = Object.freeze({
    banner: Object.freeze({ left: 0.175, top: 0.072, right: 0.825, bottom: 0.182 }),
    players: Object.freeze({ left: 0.075, top: 0.245, right: 0.925, bottom: 0.50 }),
    effects: Object.freeze({ left: 0.18, top: 0.525, right: 0.82, bottom: 0.735 }),
    boss: Object.freeze({ left: 0.335, top: 0.545, right: 0.665, bottom: 0.715 }),
    horde: Object.freeze({ left: 0.145, top: 0.778, right: 0.855, bottom: 0.905 }),
    status: Object.freeze({ left: 0.36, top: 0.925, right: 0.64, bottom: 0.968 }),
  });

  global.IntoTheBattleOverlayStageConfig = Object.freeze({
    framePad: 0.06,
    zones,
  });
})(window);
