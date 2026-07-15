import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TIMING, POTENTIAL, fmtMoney, daysUntil, initials } from '../labels.js';

function ProgressRing({ value, target, size = 64 }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const done = value >= target;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#EEEDE8" strokeWidth={6} />
      <circle
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke={done ? '#1D9E75' : '#378ADD'} strokeWidth={6} strokeLinecap="round"
        strokeDasharray={`${(pct/100)*circ} ${circ}`}
        transform={`rotate(-90 ${size/2} ${size/2})`}
      />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 15, fontWeight: 500, fill: '#1A1A1A' }}>
        {value}/{target}
      </text>
    </svg>
  );
}

function ClientRow({ c, onSelect, action, onAction, busy }) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
  const timingCfg = TIMING[c.eff_timing];
  const potCfg = POTENTIAL[c.potential];
  const d = daysUntil(c.target_contact_date);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-0 hover:bg-bg transition-colors">
      <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[11px] font-medium shrink-0">
        {initials(c.first_name, c.last_name)}
      </div>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onSelect(c.id)}>
        <div className="text-sm font-medium truncate">{name}</div>
        <div className="text-[11px] text-ink-secondary truncate">
          {[c.city, c.source].filter(Boolean).join(' · ') || '—'} · {fmtMoney(c.ca_lifetime)}
        </div>
      </div>
      {potCfg && (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full hidden sm:inline" style={{ background: potCfg.dot + '22', color: potCfg.dot }}>
          {potCfg.label}
        </span>
      )}
      {timingCfg && (
        <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${timingCfg.color}`}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: timingCfg.dot }} />
          {d != null ? (d <= 0 ? 'Now' : `${d}d`) : timingCfg.label}
        </span>
      )}
      {action && (
        <button
          disabled={busy}
          onClick={() => onAction(c)}
          className="text-xs font-medium px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-40 shrink-0"
        >
          {action}
        </button>
      )}
    </div>
  );
}

function Section({ title, count, color, children }) {
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-ink-secondary ml-auto">{count}</span>
      </div>
      {children}
    </div>
  );
}

export default function Daily({ notify, onSelect, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    api.tracker().then(setData).catch(() => notify('Error loading tracker', 'error')).finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function markContacted(c) {
    setBusyId(c.id);
    try {
      await api.updateClient(c.id, { contacted: 1 });
      notify(`${c.first_name} ${c.last_name} marked contacted`, 'success');
      load();
      onChanged?.();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Loading…</div>;
  if (!data) return null;

  const { picks = [], overdue = [], upcoming = [], contactedWeek = [], progress = {} } = data;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[1fr_auto_auto] gap-4 items-center bg-surface border border-line rounded-xl p-5">
        <div>
          <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-1">My day</div>
          <div className="text-lg font-medium">Contact {progress.dailyTarget} leads today</div>
          <div className="text-sm text-ink-secondary mt-0.5">
            {progress.today >= progress.dailyTarget
              ? '🎉 Daily goal reached — nice work.'
              : `${progress.dailyTarget - progress.today} more to hit today's goal.`}
          </div>
        </div>
        <div className="text-center">
          <ProgressRing value={progress.today || 0} target={progress.dailyTarget || 3} />
          <div className="text-[10px] text-ink-secondary uppercase tracking-wide mt-1">Today</div>
        </div>
        <div className="text-center">
          <ProgressRing value={progress.week || 0} target={progress.weeklyTarget || 15} />
          <div className="text-[10px] text-ink-secondary uppercase tracking-wide mt-1">This week</div>
        </div>
      </div>

      <Section title="Today's picks" count={`${picks.length} suggested`} color="#378ADD">
        {picks.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-secondary">
            Nothing to contact — add leads or everyone's already contacted. 🎯
          </div>
        ) : picks.map(c => (
          <ClientRow key={c.id} c={c} onSelect={onSelect} action="Contacted" onAction={markContacted} busy={busyId === c.id} />
        ))}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Section title="Overdue" count={overdue.length} color="#E24B4A">
          {overdue.length === 0
            ? <div className="px-4 py-6 text-center text-xs text-ink-secondary">None overdue.</div>
            : overdue.map(c => <ClientRow key={c.id} c={c} onSelect={onSelect} action="Contacted" onAction={markContacted} busy={busyId === c.id} />)}
        </Section>
        <Section title="Upcoming (7 days)" count={upcoming.length} color="#EF9F27">
          {upcoming.length === 0
            ? <div className="px-4 py-6 text-center text-xs text-ink-secondary">Nothing upcoming.</div>
            : upcoming.map(c => <ClientRow key={c.id} c={c} onSelect={onSelect} action="Contacted" onAction={markContacted} busy={busyId === c.id} />)}
        </Section>
        <Section title="Contacted this week" count={contactedWeek.length} color="#1D9E75">
          {contactedWeek.length === 0
            ? <div className="px-4 py-6 text-center text-xs text-ink-secondary">No contacts logged this week.</div>
            : contactedWeek.map(c => <ClientRow key={c.id} c={c} onSelect={onSelect} />)}
        </Section>
      </div>
    </div>
  );
}
