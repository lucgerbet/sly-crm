import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TIMING, POTENTIAL, fmtMoney, fmtDate } from '../labels.js';
import { Donut, Legend, FunnelBars, VBars } from './charts.jsx';

const STAGE_META = {
  new:         { label: 'New leads',  color: '#C4C2B8' },
  contacted:   { label: 'Contacted',  color: '#1D9E75' },
  replied:     { label: 'Replied',    color: '#639922' },
  appointment: { label: 'Meeting',    color: '#EF9F27' },
  won:         { label: 'Client',     color: '#E24B4A' },
  lost:        { label: 'Lost',       color: '#9CA3AF' },
};

const FUNNEL_COLORS = {
  new: '#888780', contacted: '#1D9E75', replied: '#639922', appointment: '#EF9F27', won: '#E24B4A',
};

function Card({ title, children, className = '' }) {
  return (
    <div className={`report-card bg-surface border border-line rounded-xl p-5 ${className}`}>
      <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-4">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="report-card bg-surface border border-line rounded-xl p-4">
      <div className="text-[11px] text-ink-secondary mb-1">{label}</div>
      <div className="text-xl font-medium text-ink-primary">{value}</div>
      {sub && <div className="text-[11px] text-ink-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Reports() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.reports(), api.stats()])
      .then(([r, s]) => { setData(r); setStats(s); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Loading…</div>;
  if (!data || !stats) return null;

  const { funnel = [], stageSplit = {}, byTiming = [], byPotential = [], contactsByWeek = [] } = data;
  const { pipeline, metrics, settings = {} } = stats;
  const cur = settings.currency || '€';
  const revenueTarget = settings.revenue_target || 0;
  const revenue = metrics.revenue || 0;
  const revenuePct = revenueTarget > 0 ? Math.round((revenue / revenueTarget) * 100) : 0;

  const funnelSteps = funnel.map(f => ({ ...f, color: FUNNEL_COLORS[f.key] || '#888780' }));

  const stageSegments = Object.entries(stageSplit)
    .map(([k, v]) => ({ label: STAGE_META[k]?.label || k, color: STAGE_META[k]?.color || '#ccc', value: v }))
    .filter(s => s.value > 0);
  const stageTotal = stageSegments.reduce((s, x) => s + x.value, 0);

  const timingSegments = byTiming.filter(r => r.k).map(r => ({ label: TIMING[r.k]?.label || r.k, color: TIMING[r.k]?.dot || '#ccc', value: r.n }));
  const timingTotal = timingSegments.reduce((s, x) => s + x.value, 0);

  const potSegments = byPotential.filter(r => r.k).map(r => ({ label: POTENTIAL[r.k]?.label || r.k, color: POTENTIAL[r.k]?.dot || '#ccc', value: r.n }));
  const potTotal = potSegments.reduce((s, x) => s + x.value, 0);

  const weekData = contactsByWeek.map(w => ({ label: 'W' + (w.wk.split('-')[1] || ''), value: w.n }));

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <div className="print-only text-[10px] uppercase tracking-[0.12em] text-ink-secondary">SLY</div>
          <h1 className="text-lg font-medium">Pipeline Report</h1>
          <div className="text-xs text-ink-secondary">Generated {fmtDate(new Date())}</div>
        </div>
        <button
          className="no-print text-sm text-white bg-accent rounded-md px-4 py-1.5 hover:bg-accent/90 inline-flex items-center gap-1.5"
          onClick={() => window.print()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg>
          Export PDF
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Revenue" value={fmtMoney(revenue, cur)} sub={`${revenuePct}% of ${fmtMoney(revenueTarget, cur)} goal`} />
        <Stat label="Conversion rate" value={metrics.tauxConv ? `${metrics.tauxConv}%` : '—'} sub="contacted → client" />
        <Stat label="Response rate" value={metrics.tauxRep ? `${metrics.tauxRep}%` : '—'} sub="contacted → replied" />
        <Stat label="Leads" value={pipeline.total} sub={`${pipeline.contCount} contacted · ${pipeline.wonCount} won`} />
      </div>

      <Card title="Conversion funnel">
        <FunnelBars steps={funnelSteps} />
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Stage breakdown">
          <div className="flex items-center gap-4">
            <Donut segments={stageSegments} centerLabel={stageTotal} centerSub="leads" />
            <div className="flex-1"><Legend segments={stageSegments} /></div>
          </div>
        </Card>
        <Card title="Follow-up timing">
          {timingTotal === 0 ? <div className="text-xs text-ink-secondary py-10 text-center">No timing set yet.</div> : (
            <div className="flex items-center gap-4">
              <Donut segments={timingSegments} centerLabel={timingTotal} centerSub="planned" />
              <div className="flex-1"><Legend segments={timingSegments} /></div>
            </div>
          )}
        </Card>
        <Card title="Potential">
          {potTotal === 0 ? <div className="text-xs text-ink-secondary py-10 text-center">No potential rated yet.</div> : (
            <div className="flex items-center gap-4">
              <Donut segments={potSegments} centerLabel={potTotal} centerSub="rated" />
              <div className="flex-1"><Legend segments={potSegments} /></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Contacts per week (last 8 weeks)">
        <VBars data={weekData} color="#1D9E75" height={140} />
      </Card>
    </div>
  );
}
