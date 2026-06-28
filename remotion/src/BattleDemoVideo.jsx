import React from 'react';
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const BATTLE_DEMO_FPS = 30;
export const BATTLE_DEMO_DURATION_FRAMES = 600;

const SOURCE_VIDEO = 'remotion/homepage-real-overlay-source.mp4';

const colors = {
  black: '#02040a',
  cream: '#fff8e6',
  muted: '#b9c6da',
  gold: '#f6c95b',
  cyan: '#55e7ff',
  red: '#e83b5f',
  green: '#77f0a1',
};

const shots = [
  {
    start: 0,
    end: 112,
    kicker: 'Real overlay capture',
    headline: 'Chat becomes combat',
    subcopy: 'Viewer actions hit the arena while the stream is live.',
    tone: colors.gold,
    side: 'left',
  },
  {
    start: 112,
    end: 232,
    kicker: 'Live events',
    headline: 'Every action lands',
    subcopy: 'Follows, shares, gifts, and attacks become visible moments.',
    tone: colors.cyan,
    side: 'right',
  },
  {
    start: 232,
    end: 352,
    kicker: 'Battle pressure',
    headline: 'The room can read it',
    subcopy: 'Health, horde pressure, and impact effects stay on-screen.',
    tone: colors.green,
    side: 'left',
  },
  {
    start: 352,
    end: 472,
    kicker: 'Stream-ready',
    headline: 'Built for OBS',
    subcopy: 'Drop in the browser source and test the fight before going live.',
    tone: colors.red,
    side: 'right',
  },
  {
    start: 472,
    end: 600,
    kicker: 'IntoTheBattle',
    headline: 'Start the fight',
    subcopy: 'A TikTok LIVE overlay that makes chat impossible to ignore.',
    tone: colors.gold,
    side: 'center',
  },
];

const cameraKeys = {
  landscape: {
    frame: [0, 82, 112, 194, 232, 314, 352, 432, 472, 600],
    scale: [1.42, 1.62, 1.85, 2.05, 1.88, 2.12, 1.62, 1.78, 1.34, 1.48],
    x: [-90, -180, -420, -520, -80, -160, -310, -370, -20, -110],
    y: [10, -8, -72, -96, -210, -248, -70, -88, 8, -12],
  },
  vertical: {
    frame: [0, 82, 112, 194, 232, 314, 352, 432, 472, 600],
    scale: [2.08, 2.32, 2.6, 2.82, 2.42, 2.7, 2.24, 2.46, 2.04, 2.18],
    x: [-360, -420, -690, -770, -470, -540, -610, -680, -420, -500],
    y: [80, 60, -20, -48, -300, -340, 10, -20, 92, 58],
  },
};

function ease(frame, input, output, easing = Easing.bezier(0.16, 1, 0.3, 1)) {
  return interpolate(frame, input, output, {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

function linear(frame, input, output) {
  return interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

function shotOpacity(frame, start, end, fadeIn = 12, fadeOut = 14) {
  const inOpacity = linear(frame, [start, start + fadeIn], [0, 1]);
  const outOpacity = linear(frame, [end - fadeOut, end], [1, 0]);
  return Math.max(0, Math.min(inOpacity, outOpacity));
}

function currentShot(frame) {
  return shots.find((shot) => frame >= shot.start && frame < shot.end) || shots[shots.length - 1];
}

function getCamera(frame, vertical) {
  const keys = vertical ? cameraKeys.vertical : cameraKeys.landscape;
  return {
    scale: ease(frame, keys.frame, keys.scale, Easing.bezier(0.45, 0, 0.55, 1)),
    x: ease(frame, keys.frame, keys.x, Easing.bezier(0.45, 0, 0.55, 1)),
    y: ease(frame, keys.frame, keys.y, Easing.bezier(0.45, 0, 0.55, 1)),
  };
}

function RealFootage({ frame, vertical }) {
  const cam = getCamera(frame, vertical);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: colors.black }}>
      <OffthreadVideo
        src={staticFile(SOURCE_VIDEO)}
        muted
        volume={0}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transformOrigin: '50% 50%',
          transform: `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.scale})`,
          filter: 'saturate(1.28) contrast(1.16) brightness(0.88)',
        }}
      />
    </AbsoluteFill>
  );
}

function ColorGrade({ frame, vertical }) {
  const drift = linear(frame % 180, [0, 180], [-18, 118]);
  const warm = 0.42 + Math.sin(frame / 32) * 0.08;
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(90deg, rgba(2,4,10,0.9), rgba(2,4,10,0.18) 36%, rgba(2,4,10,0.16) 66%, rgba(2,4,10,0.82)), ' +
            'linear-gradient(180deg, rgba(2,4,10,0.38), transparent 42%, rgba(2,4,10,0.76))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at 18% 22%, rgba(246,201,91,${warm}), transparent 30%), radial-gradient(circle at 82% 28%, rgba(85,231,255,0.28), transparent 34%), radial-gradient(circle at 62% 82%, rgba(232,59,95,0.22), transparent 34%)`,
          mixBlendMode: 'screen',
          opacity: 0.56,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${drift}%`,
          top: vertical ? -240 : -180,
          width: vertical ? 190 : 250,
          height: vertical ? 2500 : 1500,
          background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.18), rgba(85,231,255,0.08), transparent)',
          transform: 'skewX(-18deg)',
          mixBlendMode: 'screen',
          opacity: 0.8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.055) 0, transparent 1px)',
          backgroundSize: '100% 6px',
          opacity: 0.1,
        }}
      />
    </AbsoluteFill>
  );
}

function BigType({ frame, width, height, vertical }) {
  const shot = currentShot(frame);
  const opacity = shotOpacity(frame, shot.start, shot.end);
  const enter = ease(frame, [shot.start, shot.start + 24], [34, 0]);
  const left = vertical
    ? 70
    : shot.side === 'right'
      ? width - 720
      : shot.side === 'center'
        ? 126
        : 78;
  const top = vertical
    ? height - 650
    : shot.side === 'center'
      ? height - 380
      : height - 470;
  const maxWidth = vertical
    ? width - 140
    : shot.side === 'center'
      ? width - 252
      : 640;
  const align = shot.side === 'right' && !vertical ? 'right' : 'left';
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: top + enter,
        width: maxWidth,
        opacity,
        textAlign: align,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: vertical ? 14 : 12,
          color: shot.tone,
          fontSize: vertical ? 28 : 24,
          fontWeight: 950,
          textTransform: 'uppercase',
          textShadow: '0 3px 22px rgba(0,0,0,0.72)',
        }}
      >
        <span
          style={{
            width: vertical ? 52 : 46,
            height: 5,
            borderRadius: 8,
            background: shot.tone,
            boxShadow: `0 0 24px ${shot.tone}`,
          }}
        />
        {shot.kicker}
      </div>
      <div
        style={{
          marginTop: vertical ? 18 : 14,
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: vertical ? 112 : 92,
          lineHeight: 0.92,
          textTransform: 'uppercase',
          textShadow: '0 8px 44px rgba(0,0,0,0.82)',
          letterSpacing: 0,
        }}
      >
        {shot.headline}
      </div>
      <div
        style={{
          marginTop: vertical ? 22 : 18,
          color: colors.muted,
          fontSize: vertical ? 34 : 30,
          lineHeight: 1.18,
          fontWeight: 850,
          textShadow: '0 5px 26px rgba(0,0,0,0.82)',
          maxWidth: vertical ? width - 140 : 570,
          marginLeft: align === 'right' ? 'auto' : 0,
        }}
      >
        {shot.subcopy}
      </div>
    </div>
  );
}

function CutLight({ frame, width, height, vertical }) {
  const cutFrames = shots.slice(1).map((shot) => shot.start);
  return (
    <>
      {cutFrames.map((cut) => {
        const opacity = shotOpacity(frame, cut - 7, cut + 19, 3, 15);
        const x = linear(frame, [cut - 7, cut + 19], [-26, 126]);
        return (
          <div
            key={cut}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: vertical ? -260 : -200,
              width: vertical ? 240 : 340,
              height: vertical ? height + 520 : height + 400,
              opacity,
              background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.58), rgba(85,231,255,0.26), transparent)',
              transform: 'skewX(-18deg)',
              mixBlendMode: 'screen',
            }}
          />
        );
      })}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: Math.max(
            ...cutFrames.map((cut) => shotOpacity(frame, cut - 2, cut + 8, 2, 8))
          ) * 0.34,
          background: `linear-gradient(135deg, ${colors.gold}, ${colors.cyan}, ${colors.red})`,
          mixBlendMode: 'screen',
        }}
      />
    </>
  );
}

function EdgeBrand({ frame, width, height, vertical }) {
  const opacity = shotOpacity(frame, 0, 600, 16, 16);
  return (
    <div
      style={{
        position: 'absolute',
        left: vertical ? 52 : 58,
        top: vertical ? 44 : 40,
        right: vertical ? 52 : 58,
        height: vertical ? 74 : 58,
        opacity,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        color: colors.cream,
        fontWeight: 950,
        textTransform: 'uppercase',
        textShadow: '0 4px 28px rgba(0,0,0,0.8)',
      }}
    >
      <div style={{ fontSize: vertical ? 32 : 26 }}>IntoTheBattle</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: colors.cyan,
          fontSize: vertical ? 20 : 16,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: colors.green,
            boxShadow: `0 0 ${14 + Math.sin(frame / 8) * 6}px ${colors.green}`,
          }}
        />
        Live overlay
      </div>
    </div>
  );
}

export function BattleDemoVideo({ variant = 'landscape' }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = variant === 'vertical' || height > width;

  return (
    <AbsoluteFill
      style={{
        fontFamily: 'Inter, Arial, sans-serif',
        background: colors.black,
        color: colors.cream,
        overflow: 'hidden',
      }}
    >
      <RealFootage frame={frame} vertical={vertical} />
      <ColorGrade frame={frame} vertical={vertical} />
      <CutLight frame={frame} width={width} height={height} vertical={vertical} />
      <EdgeBrand frame={frame} width={width} height={height} vertical={vertical} />
      <BigType frame={frame} width={width} height={height} vertical={vertical} />
    </AbsoluteFill>
  );
}
