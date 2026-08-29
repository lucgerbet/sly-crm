import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Donut, Legend, FunnelBars, VBars } from './charts.jsx';

const FUNNEL_COLORS = {
  visitors: '#888780', configuring: '#1D9E75', leads: '#639922', deposits: '#EF9F27', balance: '#E24B4A',
};

const REFERRER_PALETTE = ['#1D9E75', '#639922', '#EF9F27', '#E24B4A', '#7C6FE0', '#4FA3D1', '#C4C2B8', '#9CA3AF', '#D1A954', '#8AAE8A'];

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

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

export default function Analytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.analyticsSummary(days).then(setData).finally(() => setLoading(false));
  }, [days]);

  if (loading && !data) return <div className="text-ink-secondary py-16 text-center text-sm">Loading…</div>;
  if (!data) return null;

  const { totalViews, visits, busiestDay, viewsByDay = [], topPages = [], topReferrers = [], funnel = [] } = data;

  const funnelSteps = funnel.map(f => ({ ...f, color: FUNNEL_COLORS[f.key] || '#888780' }));
  const viewsData = viewsByDay.map(d => ({ label: d.day.slice(5), value: d.n }));
  const referrerSegments = topReferrers.map((r, i) => ({ label: r.source, value: r.n, color: REFERRER_PALETTE[i % REFERRER_PALETTE.length] }));
  const referrerTotal = referrerSegments.reduce((s, x) => s + x.value, 0);
  const maxPageViews = Math.max(...topPages.map(p => p.n), 1);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-medium">Analytics — sly-atelier.com</h1>
          <div className="text-xs text-ink-secondary">Trafic et conversion, sans cookies</div>
        </div>
        <div className="flex items-center gap-1 bg-line/40 rounded-md p-0.5">
          {RANGES.map(r => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                days === r.days ? 'bg-surface text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Pages vues" value={totalViews} sub={`${days} derniers jours`} />
        {/* Deliberately "visites", not "visiteurs uniques": the visitor hash
            rotates daily so the site can be measured without a cookie banner,
            which means one person over three days counts three times. The
            busiest-day figure below is the honest read on how many people were
            actually there. */}
        <Stat
          label="Visites"
          value={visits}
          sub={busiestDay ? `max ${busiestDay} le même jour` : 'un visiteur = 1 par jour'}
        />
        <Stat label="Configurateur ouvert" value={funnel.find(f => f.key === 'configuring')?.n ?? 0} sub="visites, pas personnes" />
        <Stat
          label="Taux de conversion"
          value={visits > 0 ? `${Math.round(((funnel.find(f => f.key === 'deposits')?.n ?? 0) / visits) * 100)}%` : '—'}
          sub="visite → acompte payé"
        />
      </div>

      <Card title="Trafic par jour">
        <VBars data={viewsData} color="#1D9E75" height={140} />
      </Card>

      <Card title="Entonnoir de conversion">
        <FunnelBars steps={funnelSteps} />
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Pages les plus vues">
          {topPages.length === 0 ? (
            <div className="text-xs text-ink-secondary py-10 text-center">Pas encore de données.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {topPages.map(p => (
                <div key={p.path}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs text-ink-secondary truncate">{p.path}</span>
                    <span className="text-sm font-medium tabular-nums">{p.n}</span>
                  </div>
                  <div className="h-2 bg-line rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(p.n / maxPageViews) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Sources de trafic">
          {referrerTotal === 0 ? (
            <div className="text-xs text-ink-secondary py-10 text-center">Pas encore de données.</div>
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={referrerSegments} centerLabel={referrerTotal} centerSub="vues" />
              <div className="flex-1"><Legend segments={referrerSegments} /></div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
