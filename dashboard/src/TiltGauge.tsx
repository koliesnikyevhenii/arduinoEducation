interface TiltGaugeProps {
  label: string;
  angle: number | null;
  color: string;
}

/**
 * A bubble-level style dial: the pointer rotates by the tilt angle (clamped to
 * ±90°). Reads like a spirit level — 0° is level, positive tilts one way.
 */
export function TiltGauge({ label, angle, color }: TiltGaugeProps) {
  const has = angle !== null && Number.isFinite(angle);
  const a = has ? Math.max(-90, Math.min(90, angle!)) : 0;

  return (
    <div className="gauge">
      <div className="gauge__label">{label}</div>
      <svg viewBox="-110 -110 220 220" className="gauge__dial" role="img" aria-label={`${label} ${a}°`}>
        {/* face */}
        <circle cx="0" cy="0" r="100" className="gauge__face" />
        {/* tick marks every 30° across the ±90° range */}
        {[-90, -60, -30, 0, 30, 60, 90].map((deg) => {
          const rad = ((deg - 90) * Math.PI) / 180;
          const inner = deg % 90 === 0 ? 78 : 86;
          return (
            <line
              key={deg}
              x1={Math.cos(rad) * inner}
              y1={Math.sin(rad) * inner}
              x2={Math.cos(rad) * 98}
              y2={Math.sin(rad) * 98}
              className="gauge__tick"
            />
          );
        })}
        {/* level reference line */}
        <line x1="-100" y1="0" x2="100" y2="0" className="gauge__level" />
        {/* rotating pointer */}
        <g transform={`rotate(${a})`} style={{ transition: "transform 120ms linear" }}>
          <line x1="-90" y1="0" x2="90" y2="0" stroke={color} strokeWidth="4" strokeLinecap="round" />
          <circle cx="0" cy="0" r="7" fill={color} />
        </g>
      </svg>
      <div className="gauge__value" style={{ color }}>
        {has ? `${a.toFixed(1)}°` : "—"}
      </div>
    </div>
  );
}
