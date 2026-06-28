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
  void: '#02040a',
  ink: '#061018',
  cream: '#fff8e6',
  muted: '#b9c3d8',
  dim: '#748099',
  gold: '#f6c95b',
  goldSoft: '#fff0b9',
  cyan: '#55e7ff',
  cyanSoft: '#9ff5ff',
  ember: '#ff6a3d',
  red: '#e83b5f',
  green: '#77f0a1',
};

const moments = [
  {
    start: 12,
    end: 126,
    kicker: 'Real overlay capture',
    title: 'Chat becomes combat on stream',
    detail: 'The footage is recorded from the live overlay renderer.',
    tone: colors.gold,
  },
  {
    start: 126,
    end: 252,
    kicker: 'Event queue',
    title: 'Likes, follows, shares, gifts',
    detail: 'Viewer actions enter the same visual lanes creators use live.',
    tone: colors.cyan,
  },
  {
    start: 252,
    end: 384,
    kicker: 'Attack effects',
    title: 'Lasers, impacts, shields, banners',
    detail: 'The battle board resolves real overlay effects in motion.',
    tone: colors.ember,
  },
  {
    start: 384,
    end: 504,
    kicker: 'Battle state',
    title: 'Prompts and pressure stay readable',
    detail: 'The stream sees what changed without leaving TikTok chat.',
    tone: colors.green,
  },
  {
    start: 504,
    end: 600,
    kicker: 'OBS ready',
    title: 'Copy the browser source. Start the battle.',
    detail: 'A creator can test the show before going live.',
    tone: colors.gold,
  },
];

const eventSteps = [
  { label: 'Like', frame: 40, tone: colors.gold },
  { label: 'Follow', frame: 84, tone: colors.cyan },
  { label: 'Share', frame: 126, tone: colors.green },
  { label: 'Attack', frame: 186, tone: colors.ember },
  { label: 'Gift', frame: 258, tone: colors.goldSoft },
  { label: 'Round', frame: 330, tone: colors.red },
];

function clamp(frame, input, output, easing = Easing.bezier(0.16, 1, 0.3, 1)) {
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

function segmentOpacity(frame, start, end, fadeIn = 10, fadeOut = 12) {
  const enter = linear(frame, [start, start + fadeIn], [0, 1]);
  const exit = linear(frame, [end - fadeOut, end], [1, 0]);
  return Math.max(0, Math.min(enter, exit));
}

function activeMoment(frame) {
  return moments.find((moment) => frame >= moment.start && frame < moment.end) || moments[0];
}

function layout(width, height, variant) {
  const vertical = variant === 'vertical' || height > width;
  const pad = vertical ? 58 : 72;
  return {
    vertical,
    pad,
    width,
    height,
    brand: vertical
      ? { x: pad, y: 54, w: width - pad * 2, h: 82 }
      : { x: pad, y: 48, w: 520, h: 76 },
    label: vertical
      ? { x: pad, y: height - 548, w: width - pad * 2 }
      : { x: pad, y: height - 312, w: 610 },
    strip: vertical
      ? { x: pad, y: height - 228, w: width - pad * 2, h: 156 }
      : { x: width - 790, y: height - 152, w: 714, h: 86 },
  };
}

function BrandBug({ l, frame }) {
  const pulse = 0.74 + Math.sin(frame / 10) * 0.14;
  const logoSize = l.vertical ? 62 : 58;
  return (
    <div
      style={{
        position: 'absolute',
        left: l.brand.x,
        top: l.brand.y,
        width: l.brand.w,
        height: l.brand.h,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: l.vertical ? '0 6px' : 0,
      }}
    >
      <div
        style={{
          width: logoSize,
          height: logoSize,
          borderRadius: 8,
          border: `2px solid rgba(246, 201, 91, ${0.72 + pulse * 0.18})`,
          background: 'linear-gradient(135deg, rgba(255,248,230,0.14), rgba(85,231,255,0.08))',
          boxShadow: '0 0 34px rgba(246,201,91,0.26)',
          overflow: 'hidden',
          display: 'grid',
          placeItems: 'center',
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 28 : 26,
          fontWeight: 950,
        }}
      >
        IB
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: colors.cream,
            fontFamily: 'Arial Black, Impact, sans-serif',
            fontSize: l.vertical ? 34 : 31,
            lineHeight: 1,
            textTransform: 'uppercase',
            textShadow: '0 2px 24px rgba(0,0,0,0.6)',
          }}
        >
          IntoTheBattle
        </div>
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: colors.cyanSoft,
            fontSize: l.vertical ? 17 : 15,
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: colors.green,
              boxShadow: `0 0 ${12 + pulse * 16}px ${colors.green}`,
              opacity: pulse,
            }}
          />
          Live overlay capture
        </div>
      </div>
    </div>
  );
}

function camera(frame, vertical) {
  const frames = [0, 96, 196, 314, 444, 600];
  if (vertical) {
    return {
      scale: clamp(frame, frames, [1.02, 1.06, 1.1, 1.07, 1.03, 1.05]),
      x: clamp(frame, frames, [-60, -18, 54, -42, 26, -28]),
      y: clamp(frame, frames, [0, -22, 20, -18, 8, 0]),
    };
  }
  return {
    scale: clamp(frame, frames, [1.015, 1.055, 1.13, 1.095, 1.045, 1.025]),
    x: clamp(frame, frames, [0, -28, -118, 86, 18, 0]),
    y: clamp(frame, frames, [0, -10, 28, -26, 0, 0]),
  };
}

function RealOverlayFootage({ l, frame }) {
  const c = camera(frame, l.vertical);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: colors.void }}>
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
          transform: `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.scale})`,
          filter: 'saturate(1.18) contrast(1.08) brightness(0.86)',
        }}
      />
    </AbsoluteFill>
  );
}

function Grade({ l, frame }) {
  const shimmer = linear(frame % 150, [0, 150], [-28, 128]);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(2,4,10,0.24), transparent 28%, rgba(2,4,10,0.56)), ' +
            'linear-gradient(90deg, rgba(2,4,10,0.78), transparent 22%, transparent 74%, rgba(2,4,10,0.62))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.045) 0, rgba(255,255,255,0.045) 1px, transparent 1px, transparent 5px)',
          opacity: 0.18,
          mixBlendMode: 'screen',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${shimmer}%`,
          top: -l.height * 0.2,
          width: l.vertical ? 190 : 260,
          height: l.height * 1.45,
          background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.12), rgba(85,231,255,0.08), transparent)',
          transform: 'skewX(-18deg)',
          mixBlendMode: 'screen',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: l.vertical ? 34 : 42,
          border: '1px solid rgba(255,255,255,0.11)',
          boxShadow: 'inset 0 0 0 1px rgba(246,201,91,0.12), inset 0 0 80px rgba(2,4,10,0.46)',
          borderRadius: 8,
        }}
      />
    </AbsoluteFill>
  );
}

function MomentLabel({ l, frame }) {
  const moment = activeMoment(frame);
  const opacity = segmentOpacity(frame, moment.start, moment.end, 12, 14);
  const lift = clamp(frame, [moment.start, moment.start + 20], [26, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        left: l.label.x,
        top: l.label.y + lift,
        width: l.label.w,
        opacity,
        padding: l.vertical ? '28px 30px 30px' : '26px 28px 28px',
        borderRadius: 8,
        border: `1px solid ${moment.tone}88`,
        background: 'linear-gradient(135deg, rgba(3,6,13,0.88), rgba(7,13,26,0.74))',
        boxShadow: `0 22px 70px rgba(0,0,0,0.45), 0 0 34px ${moment.tone}26`,
        backdropFilter: 'blur(10px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          color: moment.tone,
          fontSize: l.vertical ? 21 : 17,
          fontWeight: 950,
          textTransform: 'uppercase',
        }}
      >
        <span
          style={{
            width: 34,
            height: 4,
            borderRadius: 8,
            background: moment.tone,
            boxShadow: `0 0 18px ${moment.tone}`,
          }}
        />
        {moment.kicker}
      </div>
      <div
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 56 : 48,
          lineHeight: 1.02,
          textTransform: 'uppercase',
          marginTop: 13,
          textShadow: '0 4px 28px rgba(0,0,0,0.62)',
        }}
      >
        {moment.title}
      </div>
      <div
        style={{
          color: colors.muted,
          fontSize: l.vertical ? 27 : 21,
          lineHeight: 1.34,
          fontWeight: 800,
          marginTop: 14,
        }}
      >
        {moment.detail}
      </div>
    </div>
  );
}

function EventStrip({ l, frame }) {
  const progress = linear(frame, [0, BATTLE_DEMO_DURATION_FRAMES], [0, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        left: l.strip.x,
        top: l.strip.y,
        width: l.strip.w,
        height: l.strip.h,
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(3,6,13,0.72)',
        boxShadow: '0 22px 64px rgba(0,0,0,0.4)',
        padding: l.vertical ? 18 : 16,
        backdropFilter: 'blur(9px)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: l.vertical ? 18 : 16,
          right: l.vertical ? 18 : 16,
          top: l.vertical ? 24 : 18,
          height: 4,
          borderRadius: 8,
          background: 'rgba(255,255,255,0.12)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            borderRadius: 8,
            background: `linear-gradient(90deg, ${colors.gold}, ${colors.cyan}, ${colors.red})`,
            boxShadow: '0 0 20px rgba(85,231,255,0.46)',
          }}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: l.vertical ? 18 : 16,
          right: l.vertical ? 18 : 16,
          bottom: l.vertical ? 18 : 15,
          display: 'grid',
          gridTemplateColumns: l.vertical ? 'repeat(3, 1fr)' : 'repeat(6, 1fr)',
          gap: l.vertical ? 10 : 8,
        }}
      >
        {eventSteps.map((step) => {
          const active = frame >= step.frame;
          const pop = clamp(frame, [step.frame, step.frame + 14], [0.92, 1], Easing.bezier(0.34, 1.36, 0.64, 1));
          return (
            <div
              key={step.label}
              style={{
                minHeight: l.vertical ? 50 : 42,
                borderRadius: 8,
                border: `1px solid ${active ? step.tone : 'rgba(255,255,255,0.12)'}`,
                background: active
                  ? `linear-gradient(135deg, ${step.tone}2e, rgba(255,255,255,0.075))`
                  : 'rgba(255,255,255,0.045)',
                color: active ? colors.cream : colors.dim,
                display: 'grid',
                placeItems: 'center',
                fontSize: l.vertical ? 16 : 13,
                fontWeight: 950,
                textTransform: 'uppercase',
                transform: `scale(${pop})`,
                boxShadow: active ? `0 0 18px ${step.tone}24` : 'none',
              }}
            >
              {step.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CutFlash({ l, frame }) {
  const cuts = [126, 252, 384, 504];
  return (
    <>
      {cuts.map((cut) => {
        const opacity = segmentOpacity(frame, cut - 6, cut + 18, 4, 14);
        const travel = linear(frame, [cut - 6, cut + 18], [-34, 134]);
        return (
          <div
            key={cut}
            style={{
              position: 'absolute',
              left: `${travel}%`,
              top: -l.height * 0.2,
              width: l.vertical ? 260 : 320,
              height: l.height * 1.45,
              opacity,
              background: 'linear-gradient(90deg, transparent, rgba(255,248,230,0.4), rgba(85,231,255,0.2), transparent)',
              transform: 'skewX(-20deg)',
              mixBlendMode: 'screen',
            }}
          />
        );
      })}
    </>
  );
}

function FocusReticle({ l, frame }) {
  const windows = [
    { start: 170, end: 258, x: l.vertical ? 0.5 : 0.58, y: l.vertical ? 0.44 : 0.46, size: l.vertical ? 330 : 260, tone: colors.cyan },
    { start: 286, end: 392, x: l.vertical ? 0.5 : 0.47, y: l.vertical ? 0.4 : 0.42, size: l.vertical ? 380 : 300, tone: colors.ember },
    { start: 414, end: 504, x: l.vertical ? 0.5 : 0.64, y: l.vertical ? 0.5 : 0.48, size: l.vertical ? 430 : 330, tone: colors.green },
  ];

  return (
    <>
      {windows.map((window) => {
        const opacity = segmentOpacity(frame, window.start, window.end, 12, 16);
        const size = window.size + Math.sin(frame / 9) * 10;
        return (
          <div
            key={`${window.start}-${window.end}`}
            style={{
              position: 'absolute',
              left: l.width * window.x - size / 2,
              top: l.height * window.y - size / 2,
              width: size,
              height: size,
              opacity: opacity * 0.74,
              borderRadius: '50%',
              border: `2px solid ${window.tone}`,
              boxShadow: `0 0 30px ${window.tone}55, inset 0 0 30px ${window.tone}22`,
              mixBlendMode: 'screen',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 18,
                bottom: 18,
                width: 1,
                background: `linear-gradient(180deg, transparent, ${window.tone}, transparent)`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: 18,
                right: 18,
                height: 1,
                background: `linear-gradient(90deg, transparent, ${window.tone}, transparent)`,
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function FinalEmphasis({ l, frame }) {
  const opacity = segmentOpacity(frame, 520, 600, 16, 10);
  const y = clamp(frame, [520, 548], [24, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        right: l.vertical ? l.pad : 74,
        top: l.vertical ? 192 + y : 86 + y,
        width: l.vertical ? l.width - l.pad * 2 : 650,
        opacity,
        textAlign: l.vertical ? 'left' : 'right',
      }}
    >
      <div
        style={{
          color: colors.goldSoft,
          fontSize: l.vertical ? 24 : 20,
          fontWeight: 950,
          textTransform: 'uppercase',
        }}
      >
        Stream-ready battle overlay
      </div>
      <div
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 64 : 58,
          lineHeight: 1,
          textTransform: 'uppercase',
          marginTop: 12,
          textShadow: '0 6px 34px rgba(0,0,0,0.7)',
        }}
      >
        Real effects. Real overlay.
      </div>
    </div>
  );
}

export function BattleDemoVideo({ variant = 'landscape' }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layout(width, height, variant);

  return (
    <AbsoluteFill
      style={{
        fontFamily: 'Inter, Arial, sans-serif',
        color: colors.cream,
        background: colors.void,
        overflow: 'hidden',
      }}
    >
      <RealOverlayFootage l={l} frame={frame} />
      <Grade l={l} frame={frame} />
      <CutFlash l={l} frame={frame} />
      <FocusReticle l={l} frame={frame} />
      <BrandBug l={l} frame={frame} />
      <MomentLabel l={l} frame={frame} />
      <EventStrip l={l} frame={frame} />
      <FinalEmphasis l={l} frame={frame} />
    </AbsoluteFill>
  );
}
