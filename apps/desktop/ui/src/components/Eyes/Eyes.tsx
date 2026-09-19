import { useEffect, useState } from 'react';
import { theme } from '@/theme';

export type EyeState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'focusing'
  | 'confirming'
  | 'alarm'
  | 'error';

interface EyesProps {
  width?: number;
  height?: number;
  state?: EyeState;
}

const IRIS_COLORS: Record<EyeState, string> = {
  idle: theme.color.primary,
  listening: theme.color.primarySoft,
  thinking: '#B49FFF',
  speaking: theme.color.primary,
  focusing: '#FFFFFF',
  confirming: '#C4AEFF',
  alarm: theme.color.primarySoft,
  error: '#FFFFFF',
};

const OUTLINE_COLORS: Record<EyeState, string> = {
  idle: 'rgba(169,139,255,0.45)',
  listening: 'rgba(196,174,255,0.95)',
  thinking: 'rgba(180,159,255,0.85)',
  speaking: 'rgba(169,139,255,0.75)',
  focusing: 'rgba(255,255,255,0.95)',
  confirming: 'rgba(196,174,255,0.85)',
  alarm: 'rgba(196,174,255,0.95)',
  error: 'rgba(255,255,255,0.95)',
};

const GLOW_COLORS: Record<EyeState, string> = {
  idle: 'rgba(169,139,255,0.22)',
  listening: 'rgba(196,174,255,0.55)',
  thinking: 'rgba(180,159,255,0.45)',
  speaking: 'rgba(169,139,255,0.42)',
  focusing: 'rgba(255,255,255,0.55)',
  confirming: 'rgba(196,174,255,0.45)',
  alarm: 'rgba(196,174,255,0.65)',
  error: 'rgba(255,255,255,0.6)',
};

export function Eyes({ width = 340, height = 220, state = 'idle' }: EyesProps) {
  const [blink, setBlink] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [micro, setMicro] = useState(0);

  // Blink loop
  useEffect(() => {
    let active = true;
    const loop = () => {
      if (!active) return;
      const delay =
        state === 'idle'
          ? 2800 + Math.random() * 3200
          : state === 'speaking'
            ? 1800 + Math.random() * 1600
            : 4200 + Math.random() * 3800;
      setTimeout(() => {
        if (!active) return;
        setBlink(true);
        setTimeout(() => setBlink(false), 130);
        loop();
      }, delay);
    };
    loop();
    return () => {
      active = false;
    };
  }, [state]);

  // Idle gaze wander
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      const speed =
        state === 'thinking'
          ? 260
          : state === 'listening'
            ? 1200
            : state === 'speaking'
              ? 900
              : 1600 + Math.random() * 900;
      setTimeout(() => {
        if (!active) return;
        const range =
          state === 'idle'
            ? 1.8
            : state === 'thinking'
              ? 8
              : state === 'listening'
                ? 0.6
                : state === 'speaking'
                  ? 1.2
                  : 0.4;
        setGaze({
          x: (Math.random() - 0.5) * range * 2,
          y: (Math.random() - 0.5) * range,
        });
        tick();
      }, speed);
    };
    tick();
    return () => {
      active = false;
    };
  }, [state]);

  // micro tremor / speaking pulse
  useEffect(() => {
    let raf = 0;
    let t = 0;
    const step = () => {
      t += 1;
      if (state === 'speaking') {
        setMicro(Math.sin(t * 0.22) * 0.7 + Math.sin(t * 0.11) * 0.5);
      } else if (state === 'listening') {
        setMicro(Math.sin(t * 0.05) * 0.35);
      } else if (state === 'thinking') {
        setMicro(Math.sin(t * 0.08) * 0.5 + Math.cos(t * 0.13) * 0.4);
      } else {
        setMicro(Math.sin(t * 0.025) * 0.18);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const irisColor = IRIS_COLORS[state] ?? IRIS_COLORS.idle;
  const outlineColor = OUTLINE_COLORS[state] ?? OUTLINE_COLORS.idle;
  const glowColor = GLOW_COLORS[state] ?? GLOW_COLORS.idle;

  // pupil size: listening dilated, thinking narrow scan, speaking medium, idle normal
  const pupilBase =
    state === 'listening'
      ? 26
      : state === 'speaking'
        ? 22
        : state === 'thinking'
          ? 18
          : state === 'focusing'
            ? 14
            : state === 'alarm'
              ? 28
              : state === 'error'
                ? 24
                : 22;

  const irisRadius = 36;
  const pupilRadius = pupilBase;
  const eyeScale = blink ? '1 0.06' : `1 ${1 + micro * 0.012}`;
  const outlineWidth =
    state === 'listening' || state === 'alarm'
      ? 3.4
      : state === 'speaking'
        ? 2.8
        : state === 'thinking'
          ? 2.6
          : 2.2;

  // Left / right eye centers
  const cx1 = width / 2 - 90;
  const cx2 = width / 2 + 90;
  const cy = height / 2 + 4;

  const gx = gaze.x;
  const gy = gaze.y;

  // Thinking: swirl iris rotation
  const thinkingRot = state === 'thinking' ? `rotate(${micro * 60} ${cx1} ${cy})` : '';

  const eyeClipR = 56; // horizontal half-width for almond shape
  const eyeClipV = 38; // vertical half

  const outlineGlowBlur =
    state === 'listening' || state === 'alarm'
      ? 18
      : state === 'speaking'
        ? 12
        : state === 'thinking'
          ? 14
          : 8;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <filter id={`eyeGlow-${state}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={outlineGlowBlur} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id={`softGlow-${state}`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation={outlineGlowBlur * 1.8} result="b" />
          <feColorMatrix
            in="b"
            type="matrix"
            values="1 0 0 0 0.67
                    0 1 0 0 0.54
                    0 0 1 0 1
                    0 0 0 0.55 0"
          />
        </filter>

        <radialGradient id={`irisGrad-${state}`} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="22%" stopColor={irisColor} stopOpacity="0.95" />
          <stop offset="65%" stopColor={irisColor} stopOpacity="1" />
          <stop offset="100%" stopColor="#0E0818" stopOpacity="0.98" />
        </radialGradient>

        <radialGradient id={`scleraGrad-${state}`} cx="50%" cy="50%" r="58%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="78%" stopColor="#E9E4F5" stopOpacity="0.98" />
          <stop offset="100%" stopColor="#B7AEE0" stopOpacity="0.65" />
        </radialGradient>
      </defs>

      {/* ambient halo behind both eyes */}
      <g opacity={state === 'idle' ? 0.6 : 1}>
        <ellipse
          cx={width / 2}
          cy={cy}
          rx={230 + micro * 3}
          ry={96 + micro * 2}
          fill={glowColor}
          filter={`url(#softGlow-${state})`}
        />
      </g>

      {[
        { cx: cx1, side: -1 },
        { cx: cx2, side: 1 },
      ].map(({ cx, side }) => {
        // slight stereo parallax on gaze
        const irisOffsetX = gx + side * 0.25;
        const irisOffsetY = gy - 0.1;

        // Clamp iris to stay inside sclera
        const maxR = eyeClipR - irisRadius - 4;
        const clampedX = Math.max(-maxR, Math.min(maxR, irisOffsetX * irisRadius * 0.22));
        const clampedY = Math.max(
          -(eyeClipV - irisRadius - 2),
          Math.min(eyeClipV - irisRadius - 2, irisOffsetY * irisRadius * 0.22),
        );

        const pupilX = cx + clampedX * 1.15;
        const pupilY = cy + clampedY * 1.15;
        const irisX = cx + clampedX;
        const irisY = cy + clampedY;

        return (
          <g
            key={cx}
            transform={`translate(${cx} ${cy}) scale(${eyeScale}) translate(${-cx} ${-cy})`}
            style={{
              transformOrigin: `${cx}px ${cy}px`,
              transition: 'transform 110ms ease-out',
            }}
          >
            {/* outline / almond path */}
            <path
              d={`
                M ${cx - eyeClipR} ${cy}
                C ${cx - eyeClipR * 0.55} ${cy - eyeClipV - 6},
                  ${cx - eyeClipR * 0.2} ${cy - eyeClipV - 14},
                  ${cx}              ${cy - eyeClipV}
                C ${cx + eyeClipR * 0.2} ${cy - eyeClipV - 14},
                  ${cx + eyeClipR * 0.55} ${cy - eyeClipV - 6},
                  ${cx + eyeClipR} ${cy}
                C ${cx + eyeClipR * 0.55} ${cy + eyeClipV + 6},
                  ${cx + eyeClipR * 0.2} ${cy + eyeClipV + 12},
                  ${cx}              ${cy + eyeClipV}
                C ${cx - eyeClipR * 0.2} ${cy + eyeClipV + 12},
                  ${cx - eyeClipR * 0.55} ${cy + eyeClipV + 6},
                  ${cx - eyeClipR} ${cy}
                Z
              `}
              fill={theme.color.panel}
              stroke={outlineColor}
              strokeWidth={outlineWidth}
              filter={`url(#eyeGlow-${state})`}
              style={{
                transition: 'stroke 180ms ease, stroke-width 180ms ease',
              }}
            />

            {/* inner shadow of sclera */}
            <path
              d={`
                M ${cx - eyeClipR + 8} ${cy}
                C ${cx - eyeClipR * 0.45} ${cy - eyeClipV + 2},
                  ${cx - eyeClipR * 0.1} ${cy - eyeClipV - 4},
                  ${cx}              ${cy - eyeClipV + 4}
                C ${cx + eyeClipR * 0.1} ${cy - eyeClipV - 4},
                  ${cx + eyeClipR * 0.45} ${cy - eyeClipV + 2},
                  ${cx + eyeClipR - 8} ${cy}
                C ${cx + eyeClipR * 0.45} ${cy + eyeClipV - 2},
                  ${cx + eyeClipR * 0.1} ${cy + eyeClipV + 4},
                  ${cx}              ${cy + eyeClipV - 4}
                C ${cx - eyeClipR * 0.1} ${cy + eyeClipV + 4},
                  ${cx - eyeClipR * 0.45} ${cy + eyeClipV - 2},
                  ${cx - eyeClipR + 8} ${cy}
                Z
              `}
              fill={`url(#scleraGrad-${state})`}
              opacity="0.98"
            />

            {/* tiny blood vessels detail (idle/speaking only) */}
            {(state === 'idle' || state === 'speaking') && (
              <g
                opacity="0.18"
                stroke={theme.color.primaryDeep}
                strokeWidth="0.6"
                fill="none"
              >
                <path d={`M ${cx - 34} ${cy - 6} q 10 8 18 2`} />
                <path d={`M ${cx + 30} ${cy + 6} q -12 -4 -18 2`} />
              </g>
            )}

            {/* IRIS */}
            <g
              transform={side < 0 ? thinkingRot : ''}
              style={{ transformOrigin: `${irisX}px ${irisY}px` }}
            >
              <circle
                cx={irisX}
                cy={irisY}
                r={irisRadius + micro * 0.5}
                fill={`url(#irisGrad-${state})`}
                style={{ transition: 'r 120ms ease' }}
              />

              {/* iris striations */}
              <g opacity="0.45" stroke="#080610" strokeWidth="0.6" fill="none">
                {Array.from({ length: 18 }).map((_, i) => {
                  const a = (i / 18) * Math.PI * 2;
                  const r1 = irisRadius * 0.45;
                  const r2 = irisRadius - 3;
                  const x1 = irisX + Math.cos(a) * r1;
                  const y1 = irisY + Math.sin(a) * r1;
                  const x2 = irisX + Math.cos(a) * r2;
                  const y2 = irisY + Math.sin(a) * r2;
                  return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
                })}
              </g>

              {/* PUPIL */}
              <circle
                cx={pupilX}
                cy={pupilY}
                r={
                  state === 'error'
                    ? pupilRadius * 1.05
                    : pupilRadius + (state === 'listening' ? micro * 1.6 : 0)
                }
                fill="#030108"
                style={{ transition: 'r 140ms ease' }}
              />

              {/* pupil tiny catch-light */}
              <circle
                cx={pupilX - 4}
                cy={pupilY - 3}
                r={2.2}
                fill={irisColor}
                opacity="0.85"
              />
            </g>

            {/* Main catch-light (sclera reflection) */}
            <g opacity="0.95">
              <ellipse cx={cx + 18 * side} cy={cy - 14} rx={12} ry={7} fill="#FFFFFF" />
              <ellipse
                cx={cx + 22 * side}
                cy={cy + 16}
                rx={5}
                ry={2.6}
                fill="#FFFFFF"
                opacity="0.65"
              />
            </g>

            {/* bottom eyelid shadow */}
            <path
              d={`M ${cx - eyeClipR + 10} ${cy + 14}
                  Q ${cx} ${cy + eyeClipV - 2}, ${cx + eyeClipR - 10} ${cy + 14}`}
              stroke="rgba(10,6,20,0.5)"
              strokeWidth="1"
              fill="none"
            />
          </g>
        );
      })}

      {/* Top eyelash subtle line when listening/speaking */}
      {(state === 'listening' || state === 'speaking' || state === 'alarm') && (
        <g stroke={outlineColor} strokeWidth="1.6" strokeLinecap="round" opacity="0.9">
          <path d={`M ${cx1 - 44} ${cy - eyeClipV - 4} q 44 -14 88 0`} />
          <path d={`M ${cx2 - 44} ${cy - eyeClipV - 4} q 44 -14 88 0`} />
        </g>
      )}

      {/* Error state: X over eyes */}
      {state === 'error' && (
        <g
          stroke={theme.color.primarySoft}
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.9"
        >
          <line x1={cx1 - 30} y1={cy - 26} x2={cx1 + 30} y2={cy + 26} />
          <line x1={cx1 + 30} y1={cy - 26} x2={cx1 - 30} y2={cy + 26} />
          <line x1={cx2 - 30} y1={cy - 26} x2={cx2 + 30} y2={cy + 26} />
          <line x1={cx2 + 30} y1={cy - 26} x2={cx2 - 30} y2={cy + 26} />
        </g>
      )}

      {/* Confirming: checkmark eyes */}
      {state === 'confirming' && (
        <g
          stroke={theme.color.primarySoft}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.95"
        >
          <polyline
            points={`${cx1 - 18},${cy + 2} ${cx1 - 4},${cy + 14} ${cx1 + 22},${cy - 12}`}
          />
          <polyline
            points={`${cx2 - 18},${cy + 2} ${cx2 - 4},${cy + 14} ${cx2 + 22},${cy - 12}`}
          />
        </g>
      )}
    </svg>
  );
}
