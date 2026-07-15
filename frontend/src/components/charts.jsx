// Lightweight dependency-free SVG charts

export function Donut({ segments, size = 160, thickness = 24, centerLabel, centerSub }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  let offset = 0;
  const arcs = total > 0 ? segments.filter(s => s.value > 0).map((s) => {
    const frac = s.value / total;
    const dash = frac * circ;
    const el = (
      <circle
        key={s.label}
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={s.color}
        strokeWidth={thickness}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    );
    offset += dash;
    return el;
  }) : [];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#EEEDE8" strokeWidth={thickness} />
      {arcs}
      {centerLabel != null && (
        <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: 22, fontWeight: 500, fill: '#1A1A1A' }}>{centerLabel}</text>
      )}
      {centerSub && (
        <text x={cx} y={cy + 18} textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: 10, fill: '#888780', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{centerSub}</text>
      )}
    </svg>
  );
}

export function Legend({ segments }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className="flex flex-col gap-1.5">
      {segments.map(s => (
        <div key={s.label} className="flex items-center gap-2 text-xs">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
          <span className="text-ink-secondary flex-1">{s.label}</span>
          <span className="font-medium tabular-nums">{s.value}</span>
          <span className="text-ink-secondary tabular-nums w-9 text-right">
            {total > 0 ? Math.round((s.value / total) * 100) : 0}%
          </span>
        </div>
      ))}
    </div>
  );
}

// Horizontal funnel with conversion deltas
export function FunnelBars({ steps }) {
  const max = Math.max(...steps.map(s => s.n), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].n : null;
        const conv = prev && prev > 0 ? Math.round((s.n / prev) * 100) : null;
        return (
          <div key={s.key}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-ink-secondary">{s.label}</span>
              <div className="flex items-center gap-2">
                {conv != null && (
                  <span className="text-[10px] text-ink-secondary">{conv}% ↘</span>
                )}
                <span className="text-sm font-medium tabular-nums" style={{ color: s.color }}>{s.n}</span>
              </div>
            </div>
            <div className="h-2.5 bg-line rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${(s.n / max) * 100}%`, background: s.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Vertical bar chart
export function VBars({ data, color = '#1D9E75', height = 120 }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.length === 0 && <div className="text-xs text-ink-secondary self-center w-full text-center">No data yet</div>}
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
          <span className="text-[10px] font-medium tabular-nums text-ink-primary">{d.value || ''}</span>
          <div
            className="w-full rounded-t transition-all"
            style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 4 : 0, background: color }}
          />
          <span className="text-[10px] text-ink-secondary">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
