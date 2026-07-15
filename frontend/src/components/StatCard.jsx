export default function StatCard({ label, value, sub, accent }) {
  return (
    <div className="af-card flex flex-col gap-1">
      <div className="af-label">{label}</div>
      <div className={`text-2xl font-medium ${accent ? 'text-score-red' : ''}`}>{value ?? '—'}</div>
      {sub && <div className="text-xs text-ink-secondary">{sub}</div>}
    </div>
  );
}
