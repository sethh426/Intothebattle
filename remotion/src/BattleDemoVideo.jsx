import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// ── Constants ─────────────────────────────────────────────────────────────────
export const BATTLE_DEMO_FPS = 30;
export const BATTLE_DEMO_DURATION_FRAMES = 900; // 30 seconds

const SOURCE_VIDEO = 'remotion/hero-source.mp4';
const SOURCE_TRIM_BEFORE_FRAMES = 0;

const colors = {
  black: '#02040a',
  cream: '#fff8e6',
  muted: '#b9c6da',
  gold: '#f6c95b',
  cyan: '#55e7ff',
  red: '#e83b5f',
  green: '#77f0a1',
};

// ── Shot definitions ──────────────────────────────────────────────────────────
// Each shot aligns with a burst fired at source timestamps:
//   Burst 1 @ 1.2s (36f)  → Shot 1 opens on live action
//   Burst 2 @ 5.5s (165f) → Shot 2 mid-stream shows banner events
//   Burst 3 @ 10.0s (300f)→ Shot 3 chat effects phase
//   Burst 4 @ 14.5s (435f)→ Shot 4 gift/social events
//   Burst 5 @ 19.0s (570f)→ Shot 5 energy peak
//   Burst 6 @ 24.0s (720f)→ Shot 6 residual action + brand close
const shots = [
  {
    start: 0,
    end: 150,
    kicker: 'TikTok LIVE battle overlay',
    headline: 'Chat becomes combat.',
    subcopy: 'The arena activates the moment you go live.',
    tone: colors.gold,
    side: 'left',
  },
  {
    start: 150,
    end: 300,
    kicker: 'Real browser-source overlay',
    headline: 'This is what your stream sees.',
    subcopy: 'One signed URL in OBS or TikTok Studio — done.',
    tone: colors.cyan,
    side: 'right',
  },
  {
    start: 300,
    end: 450,
    kicker: 'Viewer chat commands',
    headline: 'They type. It fires.',
    subcopy: '!attack, !laser, !heal — every command becomes a visible moment.',
    tone: colors.cyan,
    side: 'left',
  },
  {
    start: 450,
    end: 600,
    kicker: 'Gifts, follows, shares',
    headline: 'Every action lands on screen.',
    subcopy: 'Viewer engagement stops being invisible.',
    tone: colors.red,
    side: 'right',
  },
  {
    start: 600,
    end: 735,
    kicker: 'Your chat drives the show',
    headline: 'Passive viewers become the game.',
    subcopy: 'Turn every LIVE into something your chat remembers.',
    tone: colors.gold,
    side: 'left',
  },
  {
    start: 735,
    end: 900,
    kicker: 'IntoTheBattle',
    headline: 'Start the fight.',
    subcopy: '7-day free trial. No card required.',
    tone: colors.gold,
    side: 'center',
  },
];

// ── Camera keyframes ──────────────────────────────────────────────────────────
// Shot 1: Pull back from 1.12→1.0 over first 50 frames (cinematic reveal), stay wide
// Shot 2: Hold 1.0, subtle push mid-shot
// Shot 3: 1.0 at cut, push toward center
// Shot 4: 1.0 at cut, gentle pan
// Shot 5: 1.0 at cut, most dramatic push (energy peak)
// Shot 6: 1.0 steady for brand close
// MAX scale anywhere: 1.09 — no cropping of UI elements
const cameraKeys = {
  landscape: {
    frame: [0,   50, 150, 215, 300, 365, 450, 515, 600, 660, 735, 840, 900],
    scale: [1.12, 1.0, 1.0, 1.04,1.0, 1.0, 1.0, 1.06,1.0, 1.0, 1.0, 1.0, 1.0],
    x:     [0,   0,   0,  -8,   0,   0,   0,   0,   0,   0,   0,   0,   0],
    y:     [0,   0,   0,  14,   0,   0,   0, -12,  0,   0,   0,   8,   8],
  },
  vertical: {
    frame: [0,   50, 150, 215, 300, 365, 450, 515, 600, 660, 735, 840, 900],
    scale: [1.18, 1.0, 1.0, 1.05,1.0, 1.0, 1.0, 1.07,1.0, 1.0, 1.0, 1.0, 1.0],
    x:     [0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0],
    y:     [0,   0,   0,  18,   0,   0,   0, -16,  0,   0,   0,  12,  12],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  const inOp = linear(frame, [start, start + fadeIn], [0, 1]);
  const outOp = linear(frame, [end - fadeOut, end], [1, 0]);
  return Math.max(0, Math.min(inOp, outOp));
}

function currentShot(frame) {
  return shots.find(s => frame >= s.start && frame < s.end) || shots[shots.length - 1];
}

function getCamera(frame, vertical) {
  const keys = vertical ? cameraKeys.vertical : cameraKeys.landscape;
  return {
    scale: ease(frame, keys.frame, keys.scale, Easing.bezier(0.45, 0, 0.55, 1)),
    x: ease(frame, keys.frame, keys.x, Easing.bezier(0.45, 0, 0.55, 1)),
    y: ease(frame, keys.frame, keys.y, Easing.bezier(0.45, 0, 0.55, 1)),
  };
}

// ── Components ────────────────────────────────────────────────────────────────

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
          // Lighter than before: brightness +4%, less saturation/contrast
          filter: 'saturate(1.08) contrast(1.04) brightness(1.04)',
        }}
      />
    </AbsoluteFill>
  );
}

function ColorGrade({ frame, vertical }) {
  const drift = linear(frame % 200, [0, 200], [-14, 112]);
  const warm = 0.28 + Math.sin(frame / 36) * 0.04;
  const shot = currentShot(frame);
  return (
    <AbsoluteFill>
      {/* Left/right vignette: 0.28 max (was 0.66) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(90deg, rgba(2,4,10,0.28), rgba(2,4,10,0.02) 30%, rgba(2,4,10,0.02) 70%, rgba(2,4,10,0.28)), ' +
            'linear-gradient(180deg, rgba(2,4,10,0.10), transparent 42%, rgba(2,4,10,0.22))',
        }}
      />
      {/* Ambient color radials: 0.14 opacity (was 0.28) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at 16% 20%, rgba(246,201,91,${warm}), transparent 28%), radial-gradient(circle at 84% 26%, rgba(85,231,255,0.22), transparent 32%), radial-gradient(circle at 60% 84%, rgba(232,59,95,0.18), transparent 32%)`,
          mixBlendMode: 'screen',
          opacity: 0.14,
        }}
      />
      {/* Drifting light sweep */}
      <div
        style={{
          position: 'absolute',
          left: `${drift}%`,
          top: vertical ? -240 : -180,
          width: vertical ? 120 : 150,
          height: vertical ? 2500 : 1500,
          background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.09), rgba(85,231,255,0.04), transparent)',
          transform: 'skewX(-18deg)',
          mixBlendMode: 'screen',
          opacity: 0.22,
        }}
      />
      {/* Per-shot tonal tint — subtle color identity per scene */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: shot.tone,
          opacity: 0.038,
          mixBlendMode: 'screen',
        }}
      />
    </AbsoluteFill>
  );
}

function BigType({ frame, width, height, vertical }) {
  const shot = currentShot(frame);
  const opacity = shotOpacity(frame, shot.start, shot.end, 3, 8);
  const enter = ease(frame, [shot.start, shot.start + 14], [22, 0]);
  const scale = ease(frame, [shot.start, shot.start + 16], [0.985, 1]);

  const isCenter = shot.side === 'center';
  const isRight = shot.side === 'right' && !vertical;

  const left = vertical
    ? 70
    : isCenter
      ? 80
      : isRight
        ? width - 620
        : 82;
  const top = vertical
    ? height - 620
    : isCenter
      ? height / 2 - 180
      : height - 430;
  const maxW = vertical
    ? width - 140
    : isCenter
      ? width - 160
      : 560;
  const align = isRight ? 'right' : 'left';

  // Shot 6 (center/CTA) gets a special logo-above layout
  const isCTA = shot.side === 'center';

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: top + enter,
        width: maxW,
        opacity,
        textAlign: align,
        transform: `scale(${scale})`,
        transformOrigin: isRight ? '100% 50%' : '0 50%',
      }}
    >
      {/* Dark scrim behind text — lighter falloff than before */}
      <div
        style={{
          position: 'absolute',
          zIndex: 0,
          left: vertical ? -80 : isRight ? -170 : -90,
          right: vertical ? -80 : isRight ? -90 : -170,
          top: -130,
          bottom: -140,
          background: isRight
            ? 'radial-gradient(ellipse at 82% 50%, rgba(2,4,10,0.92), rgba(2,4,10,0.60) 36%, rgba(2,4,10,0) 68%)'
            : 'radial-gradient(ellipse at 18% 50%, rgba(2,4,10,0.92), rgba(2,4,10,0.60) 36%, rgba(2,4,10,0) 68%)',
        }}
      />

      {/* Kicker line */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: vertical ? 14 : 11,
          color: shot.tone,
          fontSize: vertical ? 28 : 18,
          fontWeight: 900,
          fontFamily: "'Black Ops One', 'Arial Black', sans-serif",
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          textShadow: '0 2px 14px rgba(0,0,0,0.9)',
        }}
      >
        <span
          style={{
            width: vertical ? 48 : 40,
            height: 4,
            borderRadius: 8,
            background: shot.tone,
            boxShadow: `0 0 20px ${shot.tone}`,
            flexShrink: 0,
          }}
        />
        {shot.kicker}
      </div>

      {/* Headline */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginTop: vertical ? 18 : 13,
          color: colors.cream,
          fontFamily: "'Black Ops One', 'Arial Black', sans-serif",
          fontSize: vertical ? 108 : isCTA ? 80 : 70,
          lineHeight: 0.92,
          textTransform: 'uppercase',
          textShadow: '0 4px 16px rgba(0,0,0,0.98), 0 12px 48px rgba(0,0,0,0.90)',
          letterSpacing: '-0.01em',
        }}
      >
        {shot.headline}
      </div>

      {/* Subcopy */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginTop: vertical ? 22 : 17,
          color: '#d0dcf2',
          fontSize: vertical ? 33 : 22,
          lineHeight: 1.22,
          fontWeight: 700,
          fontFamily: "'Inter', Arial, sans-serif",
          textShadow: '0 2px 12px rgba(0,0,0,0.98), 0 8px 28px rgba(0,0,0,0.90)',
          maxWidth: vertical ? width - 140 : isCTA ? 600 : 510,
          marginLeft: align === 'right' ? 'auto' : 0,
        }}
      >
        {shot.subcopy}
      </div>
    </div>
  );
}

function CutLight({ frame, width, height, vertical }) {
  const cutFrames = shots.slice(1).map(s => s.start);
  return (
    <>
      {cutFrames.map(cut => {
        const opacity = shotOpacity(frame, cut - 4, cut + 13, 2, 8) * 0.46;
        const x = linear(frame, [cut - 4, cut + 13], [-18, 118]);
        return (
          <div
            key={cut}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: vertical ? -260 : -200,
              width: vertical ? 140 : 180,
              height: vertical ? height + 520 : height + 400,
              opacity,
              background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.24), rgba(85,231,255,0.10), transparent)',
              transform: 'skewX(-18deg)',
              mixBlendMode: 'screen',
            }}
          />
        );
      })}
      {/* Shot-toned flash — reduced from 0.14 to 0.08 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: Math.max(
            ...cutFrames.map(cut => shotOpacity(frame, cut - 1, cut + 7, 1, 6))
          ) * 0.08,
          background: `linear-gradient(135deg, ${colors.gold}, ${colors.cyan}, ${colors.red})`,
          mixBlendMode: 'screen',
        }}
      />
    </>
  );
}

function EdgeBrand({ frame, width, height, vertical }) {
  const opacity = shotOpacity(frame, 0, BATTLE_DEMO_DURATION_FRAMES, 18, 18);
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
      }}
    >
      <Img
        src={staticFile('intothebattlelogo_logo_only.svg')}
        style={{
          height: vertical ? 54 : 44,
          width: 'auto',
          filter: 'drop-shadow(0 3px 16px rgba(0,0,0,0.85))',
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: colors.cyan,
          fontSize: vertical ? 19 : 15,
          fontWeight: 700,
          fontFamily: "'Inter', Arial, sans-serif",
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          textShadow: '0 2px 10px rgba(0,0,0,0.9)',
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: colors.green,
            boxShadow: `0 0 ${12 + Math.sin(frame / 8) * 5}px ${colors.green}`,
          }}
        />
        Live overlay
      </div>
    </div>
  );
}

// Thin progress strip at bottom — shows video position
function ShotProgress({ frame, width, height }) {
  const shot = currentShot(frame);
  const totalProgress = frame / BATTLE_DEMO_DURATION_FRAMES;
  const opacity = shotOpacity(frame, 0, BATTLE_DEMO_DURATION_FRAMES, 20, 20) * 0.7;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 3,
        background: 'rgba(255,255,255,0.08)',
        opacity,
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${totalProgress * 100}%`,
          background: shot.tone,
          boxShadow: `0 0 8px ${shot.tone}`,
          transition: 'background 0.3s ease',
        }}
      />
    </div>
  );
}

// ── Root composition ──────────────────────────────────────────────────────────
export function BattleDemoVideo({ variant = 'landscape' }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = variant === 'vertical' || height > width;

  return (
    <AbsoluteFill
      style={{
        fontFamily: "'Inter', Arial, sans-serif",
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
      <ShotProgress frame={frame} width={width} height={height} />
    </AbsoluteFill>
  );
}
