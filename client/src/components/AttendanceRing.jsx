import { useEffect, useState } from 'react';
import { formatPct, styleFor } from '../lib/format';

/**
 * Donut showing the attendance percentage.
 * The arc is driven by `percentage` (present ÷ conducted) — the planned class
 * count never touches this visual.
 */
export default function AttendanceRing({
  percentage,
  status = 'good',
  size = 168,
  stroke = 12,
  caption,
  minAttendance,
}) {
  const s = styleFor(status);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const target = percentage === null || percentage === undefined ? 0 : percentage;

  // Animate from 0 on mount so the number and the arc land together.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(id);
  }, [target]);

  const offset = circumference - (Math.min(shown, 100) / 100) * circumference;
  const markerAngle = minAttendance != null ? (minAttendance / 100) * 360 - 90 : null;

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-slate-100"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`${s.ring} transition-[stroke-dashoffset] duration-700 ease-out`}
        />
        {/* Tick marking the minimum requirement. */}
        {markerAngle !== null && (
          <line
            x1={size / 2 + (radius - stroke / 2 - 1) * Math.cos((markerAngle * Math.PI) / 180)}
            y1={size / 2 + (radius - stroke / 2 - 1) * Math.sin((markerAngle * Math.PI) / 180)}
            x2={size / 2 + (radius + stroke / 2 + 1) * Math.cos((markerAngle * Math.PI) / 180)}
            y2={size / 2 + (radius + stroke / 2 + 1) * Math.sin((markerAngle * Math.PI) / 180)}
            className="stroke-slate-400"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-start">
          <span className={`nums text-4xl font-semibold tracking-tight ${s.text}`}>
            {formatPct(percentage)}
          </span>
          {percentage !== null && percentage !== undefined && (
            <span className={`mt-1.5 ml-0.5 text-lg font-semibold ${s.text}`}>%</span>
          )}
        </div>
        {caption && <p className="mt-0.5 text-xs font-medium text-slate-500">{caption}</p>}
      </div>
    </div>
  );
}
