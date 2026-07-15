import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TIMING, POTENTIAL, fmtMoney, fmtMoneyShort } from '../labels.js';

function PipelineRow({ label, count, total, color, onClick }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="cursor-pointer group" onClick={onClick}>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-ink-secondary group-hover:text-ink-primary transition-colors">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-ink-secondary">{pct}%</span>
          <span className="text-sm font-medium tabular-nums" style={{ color }}>{count}</span>
        </div>
      </div>
      <div className="h-1.5 bg-line rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default function Dashboard({ goTo }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.stats().then(setStats).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Loading…</div>;
  if (!stats) return null;

  const { pipeline, metrics, byTiming = [], byPotential = [], settings = {} } = stats;
  const total = pipeline.total || 0;
  const cur = settings.currency || '€';

  const revenueTarget = settings.revenue_target || 0;
  const revenue = metrics.revenue || 0;
  const revenuePct = revenueTarget > 0 ? Math.min(100, Math.round((revenue / revenueTarget) * 100)) : 0;

  const basketTarget = settings.avg_basket_target || 0;
  const basketActual = metrics.panierMoy || 0;
  const basketPct = basketTarget > 0 ? Math.min(100, Math.round((basketActual / basketTarget) * 100)) : 0;

  const timingMap = Object.fromEntries(byTiming.map(r => [r.timing, r.n]));
  const potMap = Object.fromEntries(byPotential.map(r => [r.potential, r.n]));

  if (total === 0) {
    return (
      <div className="bg-surface border border-line rounded-xl p-10 text-center space-y-3">
        <div className="text-base font-medium">Empty CRM, ready to go</div>
        <div className="text-sm text-ink-secondary max-w-md mx-auto">
          No leads yet. Add your first client or prospect to start tracking your pipeline.
        </div>
        <button className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 transition-colors" onClick={() => goTo('clients', { openId: null })}>
          + Add a client
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[280px_1fr] gap-5">

        <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
          <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Pipeline</div>

          <div
            className="flex items-baseline justify-between pb-3 border-b border-line cursor-pointer hover:opacity-80"
            onClick={() => goTo('clients', {})}
          >
            <span className="text-xs text-ink-secondary">Total leads</span>
            <span className="text-3xl font-medium tabular-nums">{total}</span>
          </div>

          <div className="space-y-3.5">
            <PipelineRow label="Contacted"  count={pipeline.contCount} total={total} color="#1D9E75" onClick={() => goTo('clients', { stage: 'contacted' })} />
            <PipelineRow label="Replied"    count={pipeline.repCount}  total={total} color="#639922" onClick={() => goTo('clients', { stage: 'answered' })} />
            <PipelineRow label="Meeting"    count={pipeline.rdvCount}  total={total} color="#EF9F27" onClick={() => goTo('clients', { stage: 'appointment' })} />
            <PipelineRow label="Client"     count={pipeline.wonCount}  total={total} color="#E24B4A" onClick={() => goTo('clients', { stage: 'won' })} />
            <PipelineRow label="Lost"       count={pipeline.lostCount} total={total} color="#9CA3AF" onClick={() => goTo('clients', { stage: 'lost' })} />
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-surface border border-line rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Revenue goal</div>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-2xl font-medium tabular-nums">{fmtMoney(revenue, cur)}</span>
              <span className="text-sm text-ink-secondary">/ {fmtMoney(revenueTarget, cur)} target</span>
              <span className="ml-auto text-lg font-medium tabular-nums" style={{ color: revenuePct >= 100 ? '#1D9E75' : '#1A1A1A' }}>{revenuePct}%</span>
            </div>
            <div className="h-3 bg-line rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${revenuePct}%`, background: revenuePct >= 100 ? '#1D9E75' : 'linear-gradient(90deg,#378ADD,#1D9E75)' }} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-[11px] text-ink-secondary mb-1">Average basket</div>
              <div className="text-xl font-medium whitespace-nowrap">{basketActual ? fmtMoneyShort(basketActual, cur) : '—'}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">target {fmtMoneyShort(basketTarget, cur)}</div>
              <div className="h-1.5 bg-line rounded-full overflow-hidden mt-2">
                <div className="h-full rounded-full" style={{ width: `${basketPct}%`, background: basketPct >= 100 ? '#1D9E75' : '#EF9F27' }} />
              </div>
            </div>
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-[11px] text-ink-secondary mb-1">Conversion rate</div>
              <div className="text-xl font-medium">{metrics.tauxConv ? `${metrics.tauxConv}%` : '—'}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5">contacted → client</div>
            </div>
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-[11px] text-ink-secondary mb-1">Response rate</div>
              <div className="text-xl font-medium">{metrics.tauxRep ? `${metrics.tauxRep}%` : '—'}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5">contacted → replied</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-3">Contact timing</div>
              <div className="space-y-2.5">
                {['now','1month','3months','6months'].map(k => {
                  const cfg = TIMING[k];
                  const n = timingMap[k] || 0;
                  const maxN = Math.max(...Object.values(timingMap), 1);
                  return (
                    <div key={k} className="flex items-center gap-2 cursor-pointer group" onClick={() => goTo('clients', { timing: k })}>
                      <span className="text-xs text-ink-secondary w-20 group-hover:text-ink-primary transition-colors">{cfg.label}</span>
                      <div className="flex-1 h-1.5 bg-line rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(n / maxN) * 100}%`, background: cfg.dot }} />
                      </div>
                      <span className="text-xs font-medium tabular-nums w-6 text-right">{n}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-3">Potential</div>
              <div className="space-y-2.5">
                {['high','medium','low'].map(k => {
                  const cfg = POTENTIAL[k];
                  const n = potMap[k] || 0;
                  const maxN = Math.max(...Object.values(potMap), 1);
                  return (
                    <div key={k} className="flex items-center gap-2">
                      <span className="text-xs text-ink-secondary w-14">{cfg.label}</span>
                      <div className="flex-1 h-1.5 bg-line rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(n / maxN) * 100}%`, background: cfg.dot }} />
                      </div>
                      <span className="text-xs font-medium tabular-nums w-6 text-right">{n}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
