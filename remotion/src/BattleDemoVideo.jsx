import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const BATTLE_DEMO_FPS = 30;
export const BATTLE_DEMO_DURATION_FRAMES = 720;

const colors = {
  void: '#03040a',
  panel: '#08111f',
  panel2: '#101827',
  line: 'rgba(255, 255, 255, 0.14)',
  gold: '#f6c95b',
  goldSoft: '#fff0b9',
  cyan: '#55e7ff',
  cyanSoft: '#9ff5ff',
  magenta: '#ff2d88',
  red: '#e83b5f',
  green: '#77f0a1',
  cream: '#fff8e6',
  muted: '#a8afbf',
};

const players = [
  { rank: 1, initials: 'NX', name: 'NovaX', accent: colors.gold, command: '!laser', stat: '8 KOs' },
  { rank: 2, initials: 'IR', name: 'IronMira', accent: colors.cyan, command: '!shield', stat: '14 saves' },
  { rank: 3, initials: 'BZ', name: 'Blaze', accent: colors.magenta, command: '!emoji', stat: '3 streak' },
];

const effects = [
  { label: 'Laser', command: '!laser', accent: colors.cyan, copy: 'fast beam hit' },
  { label: 'Comet', command: '!comet', accent: colors.gold, copy: 'horde pressure' },
  { label: 'Sphere', command: '!sphere', accent: colors.magenta, copy: 'heavy impact' },
  { label: 'Emoji', command: '!emoji', accent: colors.green, copy: 'avatar changes' },
];

function eased(frame, input, output) {
  return interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
}

function linear(frame, input, output) {
  return interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

function segmentOpacity(frame, start, end, fadeIn = 12, fadeOut = 12) {
  const incoming = linear(frame, [start, start + fadeIn], [0, 1]);
  const outgoing = linear(frame, [end - fadeOut, end], [1, 0]);
  return Math.min(incoming, outgoing);
}

function pct(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function layoutFor(width, height, variant) {
  const vertical = variant === 'vertical';
  if (vertical) {
    const stage = { x: 54, y: 80, w: width - 108, h: height - 160 };
    const cardW = 428;
    const cardH = 270;
    return {
      vertical,
      stage,
      header: { x: stage.x + 34, y: stage.y + 46, w: stage.w - 68, h: 150 },
      cards: [
        { x: 84, y: 330, w: cardW, h: cardH },
        { x: 568, y: 330, w: cardW, h: cardH },
        { x: 326, y: 628, w: cardW, h: cardH },
      ],
      chat: { x: 92, y: 940, w: width - 184, h: 128 },
      command: { x: 158, y: 1096, w: width - 316, h: 126 },
      horde: { x: 88, y: 1338, w: width - 176, h: 188 },
      videoBreak: { x: 98, y: 352, w: width - 196, h: 760 },
      stats: { x: 90, y: 330, w: width - 180, h: 880 },
      cta: { x: 94, y: 390, w: width - 188, h: 870 },
      effectRail: { x: 100, y: 1120, w: width - 200, h: 320 },
    };
  }

  const stage = { x: 58, y: 52, w: width - 116, h: height - 104 };
  return {
    vertical,
    stage,
    header: { x: stage.x + 52, y: stage.y + 42, w: stage.w - 104, h: 134 },
    cards: [
      { x: 174, y: 245, w: 500, h: 255 },
      { x: 710, y: 245, w: 500, h: 255 },
      { x: 1246, y: 245, w: 500, h: 255 },
    ],
    chat: { x: 260, y: 534, w: 1400, h: 108 },
    command: { x: 572, y: 672, w: 776, h: 104 },
    horde: { x: 224, y: 828, w: 1472, h: 136 },
    videoBreak: { x: 326, y: 250, w: 1268, h: 486 },
    stats: { x: 310, y: 245, w: 1300, h: 548 },
    cta: { x: 330, y: 252, w: 1260, h: 560 },
    effectRail: { x: 354, y: 738, w: 1212, h: 180 },
  };
}

function Text({ style, children }) {
  return (
    <div style={{ letterSpacing: 0, ...style }}>
      {children}
    </div>
  );
}

function SceneLayer({ frame, start, end, children, style }) {
  const opacity = segmentOpacity(frame, start, end);
  if (opacity <= 0) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity, ...style }}>
      {children}
    </div>
  );
}

function Background({ frame }) {
  const scan = linear(frame % 180, [0, 180], [0, 96]);
  return (
    <AbsoluteFill
      style={{
        background:
          `linear-gradient(180deg, rgba(3,4,10,0.92), rgba(5,8,17,0.98)), ` +
          `repeating-linear-gradient(0deg, rgba(85,231,255,0.07) 0, rgba(85,231,255,0.07) 1px, transparent 1px, transparent 48px), ` +
          `repeating-linear-gradient(90deg, rgba(246,201,91,0.06) 0, rgba(246,201,91,0.06) 1px, transparent 1px, transparent 64px)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            `linear-gradient(${scan}deg, rgba(85,231,255,0.09), transparent 28%, rgba(232,59,95,0.08) 66%, transparent)`,
          opacity: 0.84,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(90deg, rgba(246,201,91,0.12), transparent 14%, transparent 86%, rgba(85,231,255,0.12))',
        }}
      />
    </AbsoluteFill>
  );
}

function StageFrame({ l }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: l.stage.x,
        top: l.stage.y,
        width: l.stage.w,
        height: l.stage.h,
        border: `3px solid rgba(246, 201, 91, 0.58)`,
        borderRadius: l.vertical ? 26 : 22,
        boxShadow: 'inset 0 0 0 2px rgba(85,231,255,0.2), 0 30px 100px rgba(0,0,0,0.5)',
        background: 'linear-gradient(180deg, rgba(6,12,24,0.92), rgba(5,7,14,0.84))',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: l.vertical ? 22 : 18,
          border: '1px solid rgba(85,231,255,0.24)',
          borderRadius: l.vertical ? 22 : 18,
        }}
      />
      {['tl', 'tr', 'bl', 'br'].map((corner) => {
        const horizontal = corner.includes('r') ? { right: 20 } : { left: 20 };
        const vertical = corner.includes('b') ? { bottom: 20 } : { top: 20 };
        return (
          <div
            key={corner}
            style={{
              position: 'absolute',
              ...horizontal,
              ...vertical,
              width: l.vertical ? 70 : 92,
              height: l.vertical ? 70 : 92,
              borderTop: corner.includes('t') ? `8px solid ${colors.gold}` : 0,
              borderBottom: corner.includes('b') ? `8px solid ${colors.gold}` : 0,
              borderLeft: corner.includes('l') ? `8px solid ${colors.gold}` : 0,
              borderRight: corner.includes('r') ? `8px solid ${colors.gold}` : 0,
              opacity: 0.8,
            }}
          />
        );
      })}
    </div>
  );
}

function Header({ l, frame }) {
  const h = l.header;
  const livePulse = 0.72 + Math.sin(frame / 9) * 0.18;
  return (
    <div
      style={{
        position: 'absolute',
        left: h.x,
        top: h.y,
        width: h.w,
        height: h.h,
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'linear-gradient(180deg, rgba(8,15,29,0.96), rgba(4,7,14,0.94))',
        boxShadow: '0 18px 44px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(85,231,255,0.18)',
        display: 'flex',
        alignItems: 'center',
        padding: l.vertical ? '0 34px' : '0 44px',
        gap: l.vertical ? 20 : 28,
      }}
    >
      <div
        style={{
          width: l.vertical ? 88 : 96,
          height: l.vertical ? 88 : 96,
          borderRadius: '50%',
          border: `4px solid ${colors.gold}`,
          background: `conic-gradient(from ${frame * 2}deg, ${colors.red}, ${colors.gold}, ${colors.cyan}, ${colors.red})`,
          boxShadow: '0 0 34px rgba(246,201,91,0.34)',
          display: 'grid',
          placeItems: 'center',
          color: colors.cream,
          fontSize: l.vertical ? 30 : 34,
          fontWeight: 950,
          fontFamily: 'Arial Black, Impact, sans-serif',
        }}
      >
        IB
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: colors.cream,
            fontFamily: 'Arial Black, Impact, sans-serif',
            fontSize: l.vertical ? 50 : 58,
            lineHeight: 1,
            textTransform: 'uppercase',
          }}
        >
          IntoTheBattle
        </Text>
        <Text
          style={{
            color: colors.cyanSoft,
            fontSize: l.vertical ? 24 : 22,
            fontWeight: 850,
            marginTop: 10,
          }}
        >
          TikTok LIVE chat becomes the arena
        </Text>
      </div>
      <div
        style={{
          width: l.vertical ? 120 : 134,
          height: 48,
          borderRadius: 8,
          border: '1px solid rgba(119,240,161,0.42)',
          color: colors.green,
          background: 'rgba(119,240,161,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          fontSize: 18,
          fontWeight: 950,
          textTransform: 'uppercase',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: colors.green,
            boxShadow: `0 0 ${14 + livePulse * 12}px ${colors.green}`,
            opacity: livePulse,
          }}
        />
        Live
      </div>
    </div>
  );
}

function PlayerCard({ player, box, frame, active, target, eliminated, emoji }) {
  const lift = active ? -10 : 0;
  const glow = active ? 0.52 : target ? 0.48 : 0.2;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y + lift,
        width: box.w,
        height: box.h,
        borderRadius: 8,
        border: `2px solid ${target ? 'rgba(232,59,95,0.74)' : 'rgba(255,255,255,0.16)'}`,
        background: eliminated
          ? 'linear-gradient(180deg, rgba(28,13,20,0.94), rgba(11,7,12,0.94))'
          : 'linear-gradient(180deg, rgba(10,19,35,0.94), rgba(6,9,18,0.94))',
        boxShadow: `0 22px 56px rgba(0,0,0,0.34), 0 0 42px rgba(${player.accent === colors.gold ? '246,201,91' : player.accent === colors.cyan ? '85,231,255' : '255,45,136'},${glow})`,
        overflow: 'hidden',
        transform: `scale(${active ? 1.015 : 1})`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 18,
          top: 16,
          color: player.accent,
          fontSize: 28,
          fontWeight: 950,
          fontFamily: 'Arial Black, Impact, sans-serif',
        }}
      >
        #{player.rank}
      </div>
      <div
        style={{
          position: 'absolute',
          right: 18,
          top: 18,
          color: colors.muted,
          fontSize: 18,
          fontWeight: 850,
        }}
      >
        {player.stat}
      </div>
      <div
        style={{
          position: 'absolute',
          left: box.w / 2 - 56,
          top: box.h * 0.2,
          width: 112,
          height: 112,
          borderRadius: '50%',
          border: `6px solid ${player.accent}`,
          background: 'rgba(255,255,255,0.04)',
          boxShadow: `0 0 34px ${player.accent}`,
          display: 'grid',
          placeItems: 'center',
          color: colors.cream,
          fontSize: emoji ? 54 : 40,
          fontWeight: 950,
          fontFamily: emoji ? 'Segoe UI Emoji, Arial, sans-serif' : 'Arial Black, Impact, sans-serif',
        }}
      >
        {emoji || player.initials}
      </div>
      <Text
        style={{
          position: 'absolute',
          left: 18,
          right: 18,
          bottom: 46,
          textAlign: 'center',
          color: colors.cream,
          fontSize: 34,
          fontWeight: 950,
        }}
      >
        {player.name}
      </Text>
      <div
        style={{
          position: 'absolute',
          left: 28,
          right: 28,
          bottom: 20,
          height: 12,
          borderRadius: 8,
          background: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: pct(eliminated ? 0.12 : player.rank === 1 ? 0.92 : player.rank === 2 ? 0.72 : 0.44),
            height: '100%',
            borderRadius: 8,
            background: eliminated
              ? `linear-gradient(90deg, ${colors.red}, rgba(232,59,95,0.35))`
              : `linear-gradient(90deg, ${player.accent}, ${colors.cream})`,
          }}
        />
      </div>
      {eliminated ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(3,4,10,0.48)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Text
            style={{
              color: colors.cream,
              fontFamily: 'Arial Black, Impact, sans-serif',
              fontSize: 60,
              textTransform: 'uppercase',
              textShadow: `0 0 24px ${colors.red}`,
            }}
          >
            KO
          </Text>
        </div>
      ) : null}
    </div>
  );
}

function PlayerCards({ l, frame, phase }) {
  const laserActive = phase === 'laser';
  const emojiActive = phase === 'effects';
  const eliminated = phase === 'horde' || phase === 'stats' || phase === 'cta';
  return (
    <>
      {players.map((player, index) => (
        <PlayerCard
          key={player.name}
          player={player}
          box={l.cards[index]}
          frame={frame}
          active={(laserActive && index === 0) || (emojiActive && index === 2)}
          target={laserActive && index === 2}
          eliminated={eliminated && index === 2}
          emoji={emojiActive && index === 2 ? (frame % 36 < 18 ? ':)' : '🔥') : ''}
        />
      ))}
    </>
  );
}

function ChatBar({ l, frame, scene }) {
  const lines = {
    setup: { user: '@MIRA_LIVE', command: '!join', detail: 'entered the arena' },
    laser: { user: '@MIRA_LIVE', command: '!laser', detail: 'sent a real attack' },
    effects: { user: '@BLAZE_FAN', command: '!emoji 🔥', detail: 'changed the fighter icon' },
    horde: { user: '@NOVAX', command: '!comet', detail: 'hit the horde bar' },
    cta: { user: '@CREATOR', command: '!start', detail: 'battle room ready' },
  };
  const line = lines[scene] || lines.setup;
  const pulse = 0.74 + Math.sin(frame / 7) * 0.12;
  return (
    <div
      style={{
        position: 'absolute',
        left: l.chat.x,
        top: l.chat.y,
        width: l.chat.w,
        height: l.chat.h,
        borderRadius: 8,
        border: '2px solid rgba(85,231,255,0.36)',
        background: 'linear-gradient(180deg, rgba(7,14,28,0.96), rgba(5,8,16,0.96))',
        boxShadow: '0 18px 46px rgba(0,0,0,0.36)',
        display: 'flex',
        alignItems: 'center',
        padding: l.vertical ? '0 28px' : '0 38px',
        gap: l.vertical ? 18 : 24,
      }}
    >
      <div
        style={{
          width: l.vertical ? 62 : 70,
          height: l.vertical ? 62 : 70,
          borderRadius: '50%',
          border: `3px solid ${colors.cyan}`,
          color: colors.cyanSoft,
          display: 'grid',
          placeItems: 'center',
          fontWeight: 950,
          fontSize: l.vertical ? 22 : 24,
          background: 'rgba(85,231,255,0.08)',
        }}
      >
        CHAT
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: colors.cyanSoft,
            fontSize: l.vertical ? 25 : 25,
            fontWeight: 950,
            lineHeight: 1.05,
          }}
        >
          {line.user} typed <span style={{ color: colors.cream }}>{line.command}</span>
        </Text>
        <Text
          style={{
            color: colors.muted,
            fontSize: l.vertical ? 21 : 21,
            fontWeight: 800,
            marginTop: 8,
          }}
        >
          {line.detail}
        </Text>
      </div>
      <div
        style={{
          width: l.vertical ? 12 : 14,
          height: l.vertical ? 76 : 72,
          borderRadius: 8,
          background: `linear-gradient(180deg, ${colors.gold}, ${colors.cyan})`,
          opacity: pulse,
          boxShadow: `0 0 ${20 + pulse * 14}px rgba(85,231,255,0.72)`,
        }}
      />
    </div>
  );
}

function CommandPopup({ l, frame, scene }) {
  const copy = scene === 'effects'
    ? ['Emoji changed', 'chat controls the fighter look']
    : scene === 'horde'
      ? ['Horde pressure', 'attack pushed the battle state']
      : ['Attack confirmed', 'comment became a visible hit'];
  const y = l.command.y + eased(frame % 120, [0, 16], [18, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        left: l.command.x,
        top: y,
        width: l.command.w,
        height: l.command.h,
        borderRadius: 8,
        border: `2px solid ${scene === 'effects' ? colors.green : colors.gold}`,
        background: 'linear-gradient(180deg, rgba(13,20,32,0.98), rgba(7,9,17,0.98))',
        boxShadow: '0 22px 60px rgba(0,0,0,0.42)',
        display: 'grid',
        gridTemplateColumns: l.vertical ? '124px 1fr' : '128px 1fr',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          borderRight: `2px solid ${scene === 'effects' ? 'rgba(119,240,161,0.42)' : 'rgba(246,201,91,0.42)'}`,
          display: 'grid',
          placeItems: 'center',
          color: scene === 'effects' ? colors.green : colors.gold,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 35 : 38,
        }}
      >
        {scene === 'effects' ? 'FX' : 'KO'}
      </div>
      <div style={{ padding: l.vertical ? '0 24px' : '0 30px', minWidth: 0 }}>
        <Text
          style={{
            color: scene === 'effects' ? colors.green : colors.goldSoft,
            fontSize: l.vertical ? 29 : 28,
            fontWeight: 950,
            textTransform: 'uppercase',
          }}
        >
          {copy[0]}
        </Text>
        <Text
          style={{
            color: colors.cream,
            fontSize: l.vertical ? 31 : 34,
            fontWeight: 950,
            marginTop: 6,
            lineHeight: 1.08,
          }}
        >
          {copy[1]}
        </Text>
      </div>
    </div>
  );
}

function Projectile({ from, to, frame, start, end, color, label, thickness = 12, comet = false }) {
  const progress = eased(frame, [start, end], [0, 1]);
  if (progress <= 0 || progress >= 1.08) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const headX = from.x + dx * progress;
  const headY = from.y + dy * progress;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: from.x,
          top: from.y - thickness / 2,
          width: length * progress,
          height: thickness,
          borderRadius: 8,
          background: `linear-gradient(90deg, transparent, ${color}, ${colors.cream})`,
          boxShadow: `0 0 26px ${color}`,
          transformOrigin: '0 50%',
          transform: `rotate(${angle}rad)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: headX - (comet ? 36 : 26),
          top: headY - (comet ? 36 : 26),
          width: comet ? 72 : 52,
          height: comet ? 72 : 52,
          borderRadius: '50%',
          background: comet
            ? `radial-gradient(circle, ${colors.cream}, ${color} 46%, transparent 72%)`
            : color,
          boxShadow: `0 0 48px ${color}`,
          display: 'grid',
          placeItems: 'center',
          color: colors.void,
          fontSize: comet ? 20 : 16,
          fontWeight: 950,
        }}
      >
        {label}
      </div>
    </>
  );
}

function AttackEffects({ l, frame, phase }) {
  const first = l.cards[0];
  const third = l.cards[2];
  const horde = l.horde;
  const laserFrom = { x: first.x + first.w * 0.74, y: first.y + first.h * 0.52 };
  const laserTo = { x: third.x + third.w * 0.28, y: third.y + third.h * 0.5 };
  const cometFrom = { x: l.vertical ? l.cards[1].x + 70 : l.cards[1].x + l.cards[1].w * 0.52, y: l.cards[1].y + l.cards[1].h * 0.56 };
  const cometTo = { x: horde.x + horde.w * 0.76, y: horde.y + horde.h * 0.52 };
  return (
    <>
      {phase === 'laser' ? (
        <Projectile
          from={laserFrom}
          to={laserTo}
          frame={frame}
          start={96}
          end={160}
          color={colors.cyan}
          label="!"
          thickness={l.vertical ? 14 : 12}
        />
      ) : null}
      {phase === 'horde' ? (
        <Projectile
          from={cometFrom}
          to={cometTo}
          frame={frame}
          start={330}
          end={396}
          color={colors.gold}
          label="!"
          thickness={l.vertical ? 16 : 14}
          comet
        />
      ) : null}
    </>
  );
}

function Hordebar({ l, frame, phase }) {
  const pressure = phase === 'horde'
    ? linear(frame, [330, 430], [0.58, 0.34])
    : phase === 'stats' || phase === 'cta'
      ? 0.34
      : 0.62;
  const impact = phase === 'horde' ? Math.max(0, Math.sin((frame - 392) / 5) * segmentOpacity(frame, 390, 430, 4, 18)) : 0;
  const h = l.horde;
  return (
    <div
      style={{
        position: 'absolute',
        left: h.x,
        top: h.y - impact * 8,
        width: h.w,
        height: h.h,
        borderRadius: 8,
        border: '2px solid rgba(232,59,95,0.58)',
        background: 'linear-gradient(180deg, rgba(28,10,20,0.96), rgba(8,8,14,0.96))',
        boxShadow: `0 0 ${34 + impact * 24}px rgba(232,59,95,0.46)`,
        display: 'grid',
        gridTemplateColumns: l.vertical ? '1fr' : '260px 1fr 210px',
        alignItems: 'center',
        padding: l.vertical ? '20px 26px' : '0 34px',
        gap: l.vertical ? 14 : 28,
      }}
    >
      <Text
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 52 : 48,
          textTransform: 'uppercase',
          textAlign: l.vertical ? 'center' : 'left',
        }}
      >
        Horde
      </Text>
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
            color: colors.goldSoft,
            fontSize: l.vertical ? 28 : 26,
            fontWeight: 950,
            textTransform: 'uppercase',
          }}
        >
          <span>Pressure</span>
          <span>{Math.round(pressure * 260)} / 260 HP</span>
        </div>
        <div
          style={{
            height: l.vertical ? 30 : 26,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: pct(pressure),
              height: '100%',
              borderRadius: 8,
              background: `linear-gradient(90deg, ${colors.red}, ${colors.gold}, ${colors.green})`,
              boxShadow: '0 0 24px rgba(246,201,91,0.42)',
            }}
          />
        </div>
      </div>
      {l.vertical ? null : (
        <Text
          style={{
            color: colors.cyanSoft,
            fontSize: 25,
            fontWeight: 950,
            textAlign: 'right',
          }}
        >
          +14 active chat
        </Text>
      )}
    </div>
  );
}

function OpeningCopy({ l, frame }) {
  const opacity = segmentOpacity(frame, 0, 86, 10, 14);
  const y = l.vertical ? 1546 : 675;
  return (
    <div
      style={{
        position: 'absolute',
        left: l.vertical ? 100 : 330,
        top: y + eased(frame, [0, 18], [18, 0]),
        width: l.vertical ? 880 : 1260,
        opacity,
        textAlign: 'center',
      }}
    >
      <Text
        style={{
          color: colors.goldSoft,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 56 : 58,
          lineHeight: 1.05,
          textTransform: 'uppercase',
          textShadow: '0 0 26px rgba(246,201,91,0.28)',
        }}
      >
        Launch a battle room before your next LIVE
      </Text>
      <Text
        style={{
          color: colors.cyanSoft,
          fontSize: l.vertical ? 29 : 28,
          lineHeight: 1.25,
          fontWeight: 850,
          marginTop: 16,
        }}
      >
        Viewers type commands. The overlay makes the stream react.
      </Text>
    </div>
  );
}

function EffectRail({ l, frame }) {
  const rail = l.effectRail;
  return (
    <div
      style={{
        position: 'absolute',
        left: rail.x,
        top: rail.y,
        width: rail.w,
        height: rail.h,
        display: 'grid',
        gridTemplateColumns: l.vertical ? '1fr 1fr' : 'repeat(4, 1fr)',
        gap: l.vertical ? 18 : 16,
      }}
    >
      {effects.map((effect, index) => {
        const local = frame - (220 + index * 12);
        const pop = eased(local, [0, 18], [0.9, 1]);
        return (
          <div
            key={effect.command}
            style={{
              borderRadius: 8,
              border: `2px solid ${effect.accent}`,
              background: 'linear-gradient(180deg, rgba(10,18,34,0.96), rgba(5,8,16,0.96))',
              boxShadow: `0 0 32px ${effect.accent}44`,
              padding: l.vertical ? 22 : 20,
              transform: `scale(${pop})`,
              minWidth: 0,
            }}
          >
            <Text
              style={{
                color: effect.accent,
                fontFamily: 'Arial Black, Impact, sans-serif',
                fontSize: l.vertical ? 34 : 30,
                textTransform: 'uppercase',
              }}
            >
              {effect.command}
            </Text>
            <Text
              style={{
                color: colors.cream,
                fontSize: l.vertical ? 28 : 25,
                fontWeight: 950,
                marginTop: 8,
              }}
            >
              {effect.label}
            </Text>
            <Text
              style={{
                color: colors.muted,
                fontSize: l.vertical ? 22 : 18,
                fontWeight: 800,
                marginTop: 6,
              }}
            >
              {effect.copy}
            </Text>
          </div>
        );
      })}
    </div>
  );
}

function EffectsCopy({ l, frame }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: l.vertical ? 104 : 312,
        top: l.vertical ? 936 : 530,
        width: l.vertical ? 872 : 1296,
        textAlign: 'center',
      }}
    >
      <Text
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 48 : 58,
          lineHeight: 1.05,
          textTransform: 'uppercase',
        }}
      >
        Multiple attack styles ready for chat
      </Text>
      <Text
        style={{
          color: colors.cyanSoft,
          fontSize: l.vertical ? 25 : 28,
          fontWeight: 850,
          marginTop: l.vertical ? 10 : 14,
        }}
      >
        Same arena, cleaner moments, commands that read instantly.
      </Text>
    </div>
  );
}

function CreatorVideoBreak({ l, frame }) {
  const b = l.videoBreak;
  const progress = linear(frame, [404, 516], [0.08, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        borderRadius: 8,
        border: `2px solid ${colors.gold}`,
        background: 'linear-gradient(135deg, rgba(35,28,30,0.99), rgba(8,15,28,0.99) 36%, rgba(32,8,24,0.99))',
        boxShadow: '0 28px 86px rgba(0,0,0,0.48)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: l.vertical ? '34px' : '30px',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 8,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: l.vertical ? 70 : 82,
          top: l.vertical ? 82 : 68,
          right: l.vertical ? 70 : 82,
        }}
      >
        <Text
          style={{
            color: colors.goldSoft,
            fontSize: l.vertical ? 30 : 28,
            fontWeight: 950,
            textTransform: 'uppercase',
          }}
        >
          Creator video moment
        </Text>
        <Text
          style={{
            color: colors.cream,
            fontFamily: 'Arial Black, Impact, sans-serif',
            fontSize: l.vertical ? 64 : 68,
            lineHeight: 1.02,
            textTransform: 'uppercase',
            marginTop: 12,
            maxWidth: l.vertical ? 720 : 850,
          }}
        >
          Creator videos play inside the show
        </Text>
        <Text
          style={{
            color: colors.cyanSoft,
            fontSize: l.vertical ? 30 : 28,
            lineHeight: 1.28,
            fontWeight: 850,
            marginTop: 20,
            maxWidth: l.vertical ? 760 : 820,
          }}
        >
          Trigger a clip, then return to battle stats.
        </Text>
      </div>
      <div
        style={{
          position: 'absolute',
          left: l.vertical ? 70 : 82,
          right: l.vertical ? 70 : 82,
          bottom: l.vertical ? 76 : 54,
          height: l.vertical ? 26 : 22,
          borderRadius: 8,
          background: 'rgba(255,255,255,0.12)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: pct(progress),
            height: '100%',
            borderRadius: 8,
            background: `linear-gradient(90deg, ${colors.gold}, ${colors.cyan}, ${colors.magenta})`,
          }}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          right: l.vertical ? 86 : 96,
          bottom: l.vertical ? 126 : 92,
          width: l.vertical ? 178 : 198,
          height: l.vertical ? 178 : 198,
          borderRadius: '50%',
          border: `4px solid ${colors.cyan}`,
          display: 'grid',
          placeItems: 'center',
          color: colors.cream,
          fontSize: l.vertical ? 66 : 72,
          fontFamily: 'Arial Black, Impact, sans-serif',
          background: 'rgba(85,231,255,0.08)',
          boxShadow: '0 0 54px rgba(85,231,255,0.34)',
        }}
      >
        AD
      </div>
    </div>
  );
}

function StatsRecap({ l }) {
  const s = l.stats;
  const stats = [
    ['Fighters joined', '47'],
    ['Chat KOs', '18'],
    ['Commands fired', '126'],
    ['Best streak', 'NovaX'],
  ];
  return (
    <div
      style={{
        position: 'absolute',
        left: s.x,
        top: s.y,
        width: s.w,
        height: s.h,
        borderRadius: 8,
        border: `2px solid ${colors.cyan}`,
        background: 'linear-gradient(180deg, rgba(8,15,29,0.98), rgba(5,8,16,0.98))',
        boxShadow: '0 30px 86px rgba(0,0,0,0.5)',
        padding: l.vertical ? 44 : 42,
      }}
    >
      <Text
        style={{
          color: colors.goldSoft,
          fontSize: l.vertical ? 30 : 28,
          fontWeight: 950,
          textTransform: 'uppercase',
        }}
      >
        Shareable stats page
      </Text>
      <Text
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 72 : 68,
          lineHeight: 1.02,
          textTransform: 'uppercase',
          marginTop: 10,
        }}
      >
        The battle creates proof after the LIVE
      </Text>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: l.vertical ? '1fr' : 'repeat(4, 1fr)',
          gap: 16,
          marginTop: l.vertical ? 44 : 38,
        }}
      >
        {stats.map(([label, value]) => (
          <div
            key={label}
            style={{
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              padding: l.vertical ? 26 : 22,
              minHeight: l.vertical ? 128 : 152,
            }}
          >
            <Text
              style={{
                color: colors.cyanSoft,
                fontSize: l.vertical ? 25 : 22,
                fontWeight: 900,
                textTransform: 'uppercase',
              }}
            >
              {label}
            </Text>
            <Text
              style={{
                color: colors.cream,
                fontFamily: 'Arial Black, Impact, sans-serif',
                fontSize: l.vertical ? 54 : 48,
                marginTop: 16,
              }}
            >
              {value}
            </Text>
          </div>
        ))}
      </div>
      <Text
        style={{
          color: colors.muted,
          fontSize: l.vertical ? 28 : 25,
          lineHeight: 1.32,
          fontWeight: 800,
          marginTop: l.vertical ? 42 : 30,
        }}
      >
        Creators get clear battle results, not just another overlay sitting on screen.
      </Text>
    </div>
  );
}

function FinalCta({ l, frame }) {
  const c = l.cta;
  const shimmer = linear(frame % 120, [0, 120], [-30, 130]);
  return (
    <div
      style={{
        position: 'absolute',
        left: c.x,
        top: c.y,
        width: c.w,
        height: c.h,
        borderRadius: 8,
        border: `2px solid ${colors.gold}`,
        background: 'linear-gradient(180deg, rgba(12,18,32,0.98), rgba(6,8,16,0.98))',
        overflow: 'hidden',
        boxShadow: '0 30px 90px rgba(0,0,0,0.52)',
        padding: l.vertical ? 54 : 56,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: `${shimmer}%`,
          top: 0,
          width: '24%',
          height: '100%',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.16), transparent)',
          transform: 'skewX(-16deg)',
        }}
      />
      <Text
        style={{
          color: colors.cyanSoft,
          fontSize: l.vertical ? 34 : 30,
          fontWeight: 950,
          textTransform: 'uppercase',
          position: 'relative',
        }}
      >
        TikTok LIVE battle overlay
      </Text>
      <Text
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 88 : 88,
          lineHeight: 1.01,
          textTransform: 'uppercase',
          marginTop: 14,
          position: 'relative',
        }}
      >
        Launch your first battle room
      </Text>
      <Text
        style={{
          color: colors.goldSoft,
          fontSize: l.vertical ? 34 : 32,
          lineHeight: 1.25,
          fontWeight: 900,
          marginTop: 24,
          maxWidth: l.vertical ? '100%' : 860,
          position: 'relative',
        }}
      >
        Commands, attacks, creator video moments, and battle stats are ready before your next stream.
      </Text>
      <div
        style={{
          marginTop: 34,
          width: l.vertical ? 520 : 500,
          minHeight: l.vertical ? 82 : 76,
          borderRadius: 8,
          background: `linear-gradient(135deg, ${colors.gold}, ${colors.cream}, ${colors.red})`,
          display: 'grid',
          placeItems: 'center',
          color: colors.void,
          fontSize: l.vertical ? 30 : 28,
          fontWeight: 950,
          position: 'relative',
        }}
      >
        Create free account
      </div>
    </div>
  );
}

function SceneCaption({ l, frame, start, end, kicker, headline, subcopy }) {
  const opacity = segmentOpacity(frame, start, end, 10, 12);
  return (
    <div
      style={{
        position: 'absolute',
        left: l.vertical ? 88 : 118,
        top: l.vertical ? 1540 : 664,
        width: l.vertical ? 904 : 420,
        opacity,
        textAlign: l.vertical ? 'center' : 'left',
      }}
    >
      <Text
        style={{
          color: colors.goldSoft,
          fontSize: l.vertical ? 24 : 18,
          fontWeight: 950,
          textTransform: 'uppercase',
        }}
      >
        {kicker}
      </Text>
      <Text
        style={{
          color: colors.cream,
          fontFamily: 'Arial Black, Impact, sans-serif',
          fontSize: l.vertical ? 54 : 33,
          lineHeight: 1.04,
          textTransform: 'uppercase',
          marginTop: 8,
        }}
      >
        {headline}
      </Text>
      <Text
        style={{
          color: colors.cyanSoft,
          fontSize: l.vertical ? 26 : 20,
          fontWeight: 850,
          marginTop: 10,
        }}
      >
        {subcopy}
      </Text>
    </div>
  );
}

export function BattleDemoVideo({ variant = 'landscape' }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutFor(width, height, variant);
  const phase = frame < 90
    ? 'setup'
    : frame < 220
      ? 'laser'
      : frame < 330
        ? 'effects'
        : frame < 404
          ? 'horde'
          : frame < 520
            ? 'video'
            : frame < 620
            ? 'stats'
            : 'cta';

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, Arial, sans-serif', color: colors.cream, background: colors.void }}>
      <Background frame={frame} />
      <StageFrame l={l} />

      <SceneLayer frame={frame} start={0} end={404}>
        <Header l={l} frame={frame} />
        <PlayerCards l={l} frame={frame} phase={phase} />
        {phase === 'effects' ? null : <ChatBar l={l} frame={frame} scene={phase} />}
        {phase === 'laser' || phase === 'horde' ? (
          <CommandPopup l={l} frame={frame} scene={phase} />
        ) : null}
        {phase === 'effects' ? null : <Hordebar l={l} frame={frame} phase={phase} />}
        <AttackEffects l={l} frame={frame} phase={phase} />
      </SceneLayer>

      <SceneLayer frame={frame} start={0} end={92}>
        <OpeningCopy l={l} frame={frame} />
      </SceneLayer>

      <SceneLayer frame={frame} start={92} end={220}>
        <SceneCaption
          l={l}
          frame={frame}
          start={98}
          end={214}
          kicker="Comment attack"
          headline="Every comment fires a real attack"
          subcopy="@MIRA_LIVE types !laser and the hit lands on the board."
        />
      </SceneLayer>

      <SceneLayer frame={frame} start={218} end={334}>
        <EffectsCopy l={l} frame={frame} />
        <EffectRail l={l} frame={frame} />
      </SceneLayer>

      <SceneLayer frame={frame} start={330} end={450}>
        <SceneCaption
          l={l}
          frame={frame}
          start={334}
          end={398}
          kicker="Battle state"
          headline="Horde pressure moves with chat"
          subcopy="Attacks, likes, gifts, and commands become readable stream moments."
        />
      </SceneLayer>

      <SceneLayer frame={frame} start={520} end={620}>
        <Header l={l} frame={frame} />
        <StatsRecap l={l} />
      </SceneLayer>

      <SceneLayer frame={frame} start={404} end={520}>
        <CreatorVideoBreak l={l} frame={frame} />
      </SceneLayer>

      <SceneLayer frame={frame} start={620} end={720}>
        <Header l={l} frame={frame} />
        <FinalCta l={l} frame={frame} />
      </SceneLayer>
    </AbsoluteFill>
  );
}
