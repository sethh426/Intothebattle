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
const SOURCE_TRIM_BEFORE_FRAMES = 40;

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
    kicker: 'Real browser-source overlay',
    headline: 'Chat becomes combat',
    subcopy: 'Viewer actions trigger effects on the live arena.',
    tone: colors.gold,
    side: 'left',
  },
  {
    start: 112,
    end: 232,
    kicker: 'Live event triggers',
    headline: 'Every action lands',
    subcopy: 'Follows, shares, gifts, and attacks become visible.',
    tone: colors.cyan,
    side: 'right',
  },
  {
    start: 232,
    end: 352,
    kicker: 'Readable battle state',
    headline: 'Pressure stays clear',
    subcopy: 'Health, horde pressure, and impacts stay on-screen.',
    tone: colors.green,
    side: 'left',
  },
  {
    start: 352,
    end: 472,
    kicker: 'OBS and TikTok Studio ready',
    headline: 'Drop it in live',
    subcopy: 'Use one browser source and test the fight before stream.',
    tone: colors.red,
    side: 'right',
  },
  {
    start: 472,
    end: 600,
    kicker: 'IntoTheBattle',
    headline: 'Start the fight',
    subcopy: 'One overlay turns passive chat into a game.',
    tone: colors.gold,
    side: 'left',
  },
];

const cameraKeys = {
  landscape: {
    frame: [0, 82, 112, 194, 232, 314, 352, 432, 472, 600],
    scale: [1.12, 1.16, 1.18, 1.22, 1.18, 1.2, 1.15, 1.18, 1.1, 1.13],
    x: [0, -18, -22, -34, 14, 4, -16, -24, 0, -8],
    y: [-12, -18, -16, -22, -10, -18, -12, -18, -8, -12],
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

function shotOpacity(frame, start, end, fadeIn = 6, fadeOut = 10) {
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
        trimBefore={SOURCE_TRIM_BEFORE_FRAMES}
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
          filter: 'saturate(1.22) contrast(1.12) brightness(0.98)',
        }}
      />
    </AbsoluteFill>
  );
}

function ColorGrade({ frame, vertical }) {
  const drift = linear(frame % 180, [0, 180], [-18, 118]);
  const warm = 0.32 + Math.sin(frame / 32) * 0.05;
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(90deg, rgba(2,4,10,0.66), rgba(2,4,10,0.04) 34%, rgba(2,4,10,0.05) 68%, rgba(2,4,10,0.62)), ' +
            'linear-gradient(180deg, rgba(2,4,10,0.18), transparent 46%, rgba(2,4,10,0.58))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at 18% 22%, rgba(246,201,91,${warm}), transparent 30%), radial-gradient(circle at 82% 28%, rgba(85,231,255,0.28), transparent 34%), radial-gradient(circle at 62% 82%, rgba(232,59,95,0.22), transparent 34%)`,
          mixBlendMode: 'screen',
          opacity: 0.28,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${drift}%`,
          top: vertical ? -240 : -180,
          width: vertical ? 140 : 170,
          height: vertical ? 2500 : 1500,
          background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.12), rgba(85,231,255,0.06), transparent)',
          transform: 'skewX(-18deg)',
          mixBlendMode: 'screen',
          opacity: 0.3,
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
  const opacity = shotOpacity(frame, shot.start, shot.end, 2, 6);
  const enter = ease(frame, [shot.start, shot.start + 12], [18, 0]);
  const scale = ease(frame, [shot.start, shot.start + 14], [0.988, 1]);
  const left = vertical
    ? 70
    : shot.side === 'right'
      ? width - 640
      : shot.side === 'center'
        ? 150
        : 78;
  const top = vertical
    ? height - 650
    : shot.side === 'center'
      ? height - 330
      : height - 438;
  const maxWidth = vertical
    ? width - 140
    : shot.side === 'center'
      ? width - 252
      : 560;
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
        transform: `scale(${scale})`,
        transformOrigin: align === 'right' ? '100% 50%' : '0 50%',
      }}
    >
      <div
        style={{
          position: 'absolute',
          zIndex: 0,
          left: vertical ? -90 : align === 'right' ? -190 : -96,
          right: vertical ? -90 : align === 'right' ? -96 : -190,
          top: -148,
          bottom: -156,
          background: align === 'right'
            ? 'radial-gradient(ellipse at 82% 50%, rgba(2,4,10,0.94), rgba(2,4,10,0.66) 38%, rgba(2,4,10,0) 72%)'
            : 'radial-gradient(ellipse at 18% 50%, rgba(2,4,10,0.94), rgba(2,4,10,0.66) 38%, rgba(2,4,10,0) 72%)',
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: vertical ? 14 : 12,
          color: shot.tone,
          fontSize: vertical ? 28 : 19,
          fontWeight: 950,
          textTransform: 'uppercase',
          textShadow: '0 3px 18px rgba(0,0,0,0.9)',
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
          position: 'relative',
          zIndex: 1,
          marginTop: vertical ? 18 : 14,
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: vertical ? 112 : 68,
          lineHeight: 0.94,
          textTransform: 'uppercase',
          textShadow: '0 5px 18px rgba(0,0,0,0.96), 0 14px 58px rgba(0,0,0,0.88)',
          letterSpacing: 0,
        }}
      >
        {shot.headline}
      </div>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginTop: vertical ? 22 : 18,
          color: '#d6e0f3',
          fontSize: vertical ? 34 : 23,
          lineHeight: 1.18,
          fontWeight: 850,
          textShadow: '0 3px 14px rgba(0,0,0,0.96), 0 9px 34px rgba(0,0,0,0.88)',
          maxWidth: vertical ? width - 140 : 520,
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
        const opacity = shotOpacity(frame, cut - 4, cut + 13, 2, 8) * 0.52;
        const x = linear(frame, [cut - 4, cut + 13], [-22, 120]);
        return (
          <div
            key={cut}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: vertical ? -260 : -200,
              width: vertical ? 150 : 190,
              height: vertical ? height + 520 : height + 400,
              opacity,
              background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.28), rgba(85,231,255,0.12), transparent)',
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
            ...cutFrames.map((cut) => shotOpacity(frame, cut - 1, cut + 7, 1, 6))
          ) * 0.14,
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
