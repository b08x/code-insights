/**
 * ShareCardDonut — pure inline SVG donut chart for the shareable card export.
 *
 * Uses <circle> stroke-dasharray/stroke-dashoffset for segments.
 * Recharts is NOT used here — html-to-image has canvas compatibility issues
 * with foreign object elements that Recharts relies on.
 * All colors are hardcoded hex literals.
 */

interface DonutDataItem {
  label: string;
  value: number;
  color: string;
}

interface ShareCardDonutProps {
  data: DonutDataItem[];
  size: number;
  strokeWidth: number;
}

export function ShareCardDonut({ data, size, strokeWidth }: ShareCardDonutProps) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  // Build segments with cumulative offset
  let cumulativeOffset = 0;
  // SVG starts at 3 o'clock; rotate -90deg to start from 12 o'clock
  const segments = data.map((d) => {
    const dashLen = (d.value / total) * circumference;
    const dashGap = circumference - dashLen;
    const offset = circumference - cumulativeOffset;
    cumulativeOffset += dashLen;
    return { ...d, dashLen, dashGap, offset };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
      {/* Donut */}
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}
      >
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#ffffff12"
          strokeWidth={strokeWidth}
        />
        {/* Segments */}
        {segments.map((seg, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={seg.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${seg.dashLen} ${seg.dashGap}`}
            strokeDashoffset={seg.offset}
            strokeLinecap="butt"
          />
        ))}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {data.map((d, i) => {
          const pct = Math.round((d.value / total) * 100);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: d.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                {d.label}
              </span>
              <span style={{ fontSize: '11px', color: '#475569', marginLeft: '2px' }}>
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
