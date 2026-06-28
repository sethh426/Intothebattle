import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { BattleDemoVideo, BATTLE_DEMO_DURATION_FRAMES, BATTLE_DEMO_FPS } from './src/BattleDemoVideo.jsx';

function RemotionRoot() {
  return (
    <>
      <Composition
        id="battle-homepage"
        component={BattleDemoVideo}
        durationInFrames={BATTLE_DEMO_DURATION_FRAMES}
        fps={BATTLE_DEMO_FPS}
        width={1920}
        height={1080}
        defaultProps={{ variant: 'landscape' }}
      />
      <Composition
        id="battle-growth-vertical"
        component={BattleDemoVideo}
        durationInFrames={BATTLE_DEMO_DURATION_FRAMES}
        fps={BATTLE_DEMO_FPS}
        width={1080}
        height={1920}
        defaultProps={{ variant: 'vertical' }}
      />
    </>
  );
}

registerRoot(RemotionRoot);
