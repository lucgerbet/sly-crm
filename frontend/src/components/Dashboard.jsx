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

// The window every performance figure on this page answers for.
//
// The month-slice chips (1–10, 10–20, 20–fin) are computed against the current
// month rather than being fixed dates, so "10–20" always means this month's
// second third — which is how the question is actually asked.
const pad = (n) => String(n).padStart(2, '0');

function monthSlice(startDay, endDay) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return {
    from: `${y}-${pad(m + 1)}-${pad(startDay)}`,
    to: `${y}-${pad(m + 1)}-${pad(Math.min(endDay, last))}`,
  };
}

const NAMED_PERIODS = [
  ['today', "Aujourd'hui"],
  ['week', 'Cette semaine'],
  ['month', 'Mois en cours'],
  ['quarter', '3 mois'],
  ['half', '6 mois'],
  ['year12', '1 an'],
  ['all', 'Tout'],
];

function PeriodBar({ range, onChange }) {
  const slices = [
    ['1–10', () => monthSlice(1, 10)],
    ['10–20', () => monthSlice(10, 20)],
    ['20–fin', () => monthSlice(20, 31)],
  ];
  const isNamed = (p) => !range.from && !range.to && (range.period || 'all') === p;
  const isSlice = (s) => range.from === s.from && range.to === s.to;

  const chip = (active) =>
    `text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
      active ? 'bg-ink-primary text-white border-ink-primary' : 'border-line text-ink-secondary hover:text-ink-primary'
    }`;

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {NAMED_PERIODS.map(([p, label]) => (
          <button key={p} className={chip(isNamed(p))} onClick={() => onChange({ period: p })}>
            {label}
          </button>
        ))}
        <span className="w-px h-5 bg-line mx-1" />
        {slices.map(([label, make]) => {
          const s = make();
          return (
            <button key={label} className={chip(isSlice(s))} onClick={() => onChange(s)}>
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">Du</span>
          <input
            type="date" value={range.from || ''}
            onChange={e => onChange({ from: e.target.value, to: range.to || '' })}
            className="border border-line rounded-md px-2 py-1 text-sm bg-surface outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">Au</span>
          <input
            type="date" value={range.to || ''}
            onChange={e => onChange({ from: range.from || '', to: e.target.value })}
            className="border border-line rounded-md px-2 py-1 text-sm bg-surface outline-none focus:border-accent"
          />
        </label>
        {(range.from || range.to) && (
          <button
            className="text-[11px] text-ink-secondary hover:text-ink-primary underline decoration-dotted pb-1.5"
            onClick={() => onChange({ period: 'all' })}
          >
            effacer les dates
          </button>
        )}
      </div>
    </div>
  );
}

// What actually sells over the window. Share is of revenue, not of units: two
// shirts and one suit are not an even split of anything that matters.
const MIX_COLOURS = ['#3a2a23', '#5a1f24', '#B45309', '#1D9E75', '#64748B', '#9CA3AF'];

function ProductMix({ range, cur }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.productMix(range).then(setD).catch(() => {}); }, [JSON.stringify(range)]);
  if (!d) return null;

  const eur = (cents) => fmtMoneyShort((cents || 0) / 100, cur);

  // A donut drawn with stroke-dasharray on one circle per slice — no chart
  // library for six numbers.
  const R = 54, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = d.products.map((p, i) => {
    const frac = d.totalCents ? p.revenueCents / d.totalCents : 0;
    const arc = { ...p, colour: MIX_COLOURS[i % MIX_COLOURS.length], dash: frac * C, offset };
    offset += frac * C;
    return arc;
  });

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">
          Ventes par produit
        </div>
        <div className="text-[11px] text-ink-secondary">
          {d.totalUnits} pièce{d.totalUnits > 1 ? 's' : ''} · {eur(d.totalCents)}
        </div>
      </div>

      {d.totalUnits === 0 && (
        <div className="text-sm text-ink-secondary mb-3">Aucune vente sur cette période.</div>
      )}
      {d.products.length === 0 ? null : (
        <div className="flex items-center gap-6">
          <svg viewBox="0 0 140 140" className="w-[140px] h-[140px] shrink-0">
            <g transform="rotate(-90 70 70)">
              {arcs.map(a => (
                <circle
                  key={a.type} cx="70" cy="70" r={R} fill="none"
                  stroke={a.colour} strokeWidth="18"
                  strokeDasharray={`${a.dash} ${C - a.dash}`}
                  strokeDashoffset={-a.offset}
                />
              ))}
            </g>
            {/* Products that actually moved, not catalogue size — the ring
                draws sales, so its centre should count sales. */}
            <text x="70" y="66" textAnchor="middle" className="fill-ink-primary" style={{ fontSize: 20, fontWeight: 500 }}>
              {d.products.filter(p => p.units > 0 || p.revenueCents > 0).length}
            </text>
            <text x="70" y="82" textAnchor="middle" className="fill-ink-secondary" style={{ fontSize: 8, letterSpacing: '0.12em' }}>
              {d.products.filter(p => p.units > 0 || p.revenueCents > 0).length > 1 ? 'PRODUITS VENDUS' : 'PRODUIT VENDU'}
            </text>
          </svg>

          <div className="flex-1 space-y-2">
            {arcs.map(a => {
              const sold = a.units > 0 || a.revenueCents > 0;
              return (
                <div key={a.type} className={`flex items-center gap-3 text-sm ${sold ? '' : 'opacity-45'}`}>
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: sold ? a.colour : 'transparent', border: sold ? 'none' : '1px solid #d8d0c7' }}
                  />
                  <span className="flex-1 truncate">{a.label}</span>
                  <span className="text-ink-secondary tabular-nums w-16 text-right">{a.units} pc</span>
                  <span className="font-medium tabular-nums w-20 text-right">{eur(a.revenueCents)}</span>
                  <span className="text-ink-secondary tabular-nums w-10 text-right">{a.pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// The money windows: what each sale leaves before and after Stripe takes its
// cut, what the book is worth once everything in flight settles, and what is
// still owed. All read the same /orders/revenue aggregation the Orders board
// uses, so the figures can never drift apart between the two pages.
function MoneyPanels({ cur, range }) {
  const [rev, setRev] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setRev(null);
    api.revenue(range).then(setRev).catch(() => setErr(true));
  }, [JSON.stringify(range)]);

  if (err) return null;
  if (!rev) {
    return (
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="bg-surface border border-line rounded-xl p-4 h-[92px] animate-pulse" />
        ))}
      </div>
    );
  }

  const eur = (cents) => fmtMoneyShort((cents || 0) / 100, cur);
  const real = rev.margin?.realised || {};
  const proj = rev.margin?.projected || {};
  const sign = (cents) => (cents >= 0 ? '#1D9E75' : '#E24B4A');
  // A margin that quietly skips orders it can't cost must say so, or it reads
  // as covering the whole book.
  const gaps = (real.ordersMissingCost || 0) + (proj.ordersMissingCost || 0);

  return (
    <div className="grid grid-cols-4 gap-3">
      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[11px] text-ink-secondary mb-1">Gross margin</div>
        <div
          className="text-xl font-medium whitespace-nowrap"
          style={{ color: sign(real.grossCents || 0) }}
        >
          {eur(real.grossCents)}
        </div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          {real.grossPct != null
            ? `${real.grossPct}% of ${eur(real.revenueCents)} collected`
            : 'nothing collected yet'}
        </div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          after {eur(real.costCents)} production cost
        </div>
        {real.afterSalesCents > 0 && (
          <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: '#DC2626' }}>
            − {eur(real.afterSalesCents)} retouches / refabrications
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[11px] text-ink-secondary mb-1">Net margin</div>
        <div
          className="text-xl font-medium whitespace-nowrap"
          style={{ color: sign(real.netCents || 0) }}
        >
          {eur(real.netCents)}
        </div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          {real.netPct != null ? `${real.netPct}% of collected revenue` : 'nothing collected yet'}
        </div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          after {eur(real.feesCents)} Stripe fees
        </div>
        {gaps > 0 && (
          <div className="text-[11px] mt-1 whitespace-nowrap" style={{ color: '#EF9F27' }}>
            {gaps} order{gaps > 1 ? 's' : ''} with no cost set
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[11px] text-ink-secondary mb-1">Projected revenue</div>
        <div className="text-xl font-medium whitespace-nowrap">{eur(rev.projected?.cents)}</div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          {rev.projected?.count || 0} order{(rev.projected?.count || 0) > 1 ? 's' : ''} in flight, once all paid
        </div>
        {(rev.projected?.quotedCount || 0) > 0 && (
          <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
            incl. {rev.projected.quotedCount} at site quote, call not held
          </div>
        )}
        {proj.netCents != null && proj.orders > 0 && (
          <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: sign(proj.netCents) }}>
            → {eur(proj.netCents)} net margin ({proj.netPct}%)
          </div>
        )}
        {(rev.projected?.unknownCount || 0) > 0 && (
          <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: '#EF9F27' }}>
            {rev.projected.unknownCount} order{rev.projected.unknownCount > 1 ? 's' : ''} with no price yet
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[11px] text-ink-secondary mb-1">Awaiting payment</div>
        <div
          className="text-xl font-medium whitespace-nowrap"
          style={{ color: (rev.outstanding?.cents || 0) > 0 ? '#EF9F27' : undefined }}
        >
          {eur(rev.outstanding?.cents)}
        </div>
        <div className="text-[11px] text-ink-secondary mt-0.5 whitespace-nowrap">
          {rev.outstanding?.count || 0} balance{(rev.outstanding?.count || 0) > 1 ? 's' : ''} unpaid
        </div>
      </div>
    </div>
  );
}

// Lead times across the four hand-offs an order goes through after leaving
// for the workshop. Only the first is measured automatically (the docket link
// records when it was opened); the other three end on stages Luc sets on the
// board, so they are only as accurate as the day he moves them. Hidden
// entirely until a docket has been sent — a row of dashes teaches nothing.
function LeadTimePanels() {
  const [w, setW] = useState(null);
  useEffect(() => { api.workshopStats().then(setW).catch(() => {}); }, []);
  // Shown as soon as any leg has something to say — an order can have a timed
  // meeting long before it ever reaches the workshop.
  const hasAny = w && Object.values(w.legs || {}).some(l => l.n > 0 || l.pending > 0);
  if (!w || !hasAny) return null;

  // `own` = the step is Luc's own doing, not the workshop's or the carrier's.
  // Greyed for that reason: a slow week on his side and a slow week on theirs
  // call for completely different action, so the two must not read alike.
  const CELLS = [
    ['meeting', 'Prise de commande', 'RDV → commande clôturée', 'aucune clôturée', true],
    ['toWorkshop', 'Envoi à l\'atelier', 'clôture → bon envoyé', 'aucun envoyé', true],
    ['docket', 'Traitement du bon', 'envoi → atelier l\'ouvre', 'pas encore ouvert'],
    ['production', 'Production', 'ouverture → pièce prête', 'aucune finie'],
    ['handover', 'Prise en charge transport', 'prête → expédiée', 'aucune expédiée'],
    ['transit', 'Transport', 'expédiée → reçue par le client', 'aucune reçue'],
  ];

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">
          Délais moyens
        </div>
        {w.total.avgDays != null && (
          <div className="text-[11px] text-ink-secondary">
            atelier → client : <span className="text-ink-primary font-medium">{w.total.avgDays} j</span>
            {' '}sur {w.total.n} commande{w.total.n > 1 ? 's' : ''}
          </div>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {CELLS.map(([key, label, sub, empty, own]) => {
          const stat = w.legs[key] || {};
          return (
            <div
              key={key}
              className="border border-line rounded-xl p-4"
              style={own ? { background: '#f4f2ef' } : { background: 'var(--surface, #fff)' }}
            >
              <div className="text-[11px] text-ink-secondary mb-1">
                {label}
                {own && <span className="ml-1 opacity-60">· nous</span>}
              </div>
              <div
                className="text-xl font-medium whitespace-nowrap"
                style={own ? { color: '#6b5b4e' } : undefined}
              >
                {stat.avgDays == null ? '—' : `${stat.avgDays} j`}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5 truncate" title={sub}>
                {stat.n ? `${sub} · ${stat.n} cmd` : empty}
              </div>
              {stat.pending > 0 && (
                <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: '#EF9F27' }}>
                  {stat.pending} en cours, non compté{stat.pending > 1 ? 'es' : 'e'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Share of sales by standard size — the answer to "what shape of man actually
// buys from me", in a vocabulary a supplier or a future ready-to-wear run would
// understand. Sizes come from the Size chart tab; until that chart has ranges,
// this says so plainly instead of drawing an empty graph, and it stays visible
// precisely so the work doesn't get forgotten.
function SizeMix({ goTo }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.sizeDistribution().then(setD).catch(() => {}); }, []);
  if (!d) return null;

  const max = Math.max(1, ...d.sizes.map(s => s.n));

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">
          Ventes par taille standard
        </div>
        <button
          onClick={() => goTo('sizes', {})}
          className="text-[11px] text-ink-secondary hover:text-ink-primary underline decoration-dotted"
        >
          Size chart
        </button>
      </div>

      {!d.chartReady ? (
        <div className="text-sm text-ink-secondary leading-relaxed">
          Le référentiel de tailles n'est pas encore rempli, donc aucune commande
          n'est associée — ce cadre restera vide plutôt que d'inventer une
          répartition.
          <div className="text-[13px] mt-2">
            {d.ordersConsidered} commande{d.ordersConsidered > 1 ? 's' : ''} payée{d.ordersConsidered > 1 ? 's' : ''} en attente d'être classée{d.ordersConsidered > 1 ? 's' : ''}.
            {' '}Renseigne les bornes dans <span className="text-ink-primary">Size chart</span> et tout se calcule.
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {d.sizes.map(s => (
              <div key={s.label} className="flex items-center gap-3">
                <span className="text-xs font-medium w-12 shrink-0 tabular-nums">{s.label}</span>
                <div className="flex-1 h-2 bg-line rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(s.n / max) * 100}%`, background: '#3a2a23' }} />
                </div>
                <span className="text-xs text-ink-secondary w-10 text-right tabular-nums">{s.pct}%</span>
                <span className="text-xs font-medium w-6 text-right tabular-nums">{s.n}</span>
              </div>
            ))}
          </div>
          {/* Orders the chart could not place are stated, not dropped: a
              distribution that quietly ignores half the book is misleading. */}
          {(d.unmatched > 0 || d.noMeasurements > 0) && (
            <div className="text-[11px] text-ink-secondary mt-3 pt-3 border-t border-line">
              {d.matched} commande{d.matched > 1 ? 's' : ''} classée{d.matched > 1 ? 's' : ''}
              {d.noMeasurements > 0 && ` · ${d.noMeasurements} sans mensurations`}
              {d.unmatched > 0 && ` · ${d.unmatched} hors chart`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A prospect with no address is normal — nobody asked them for one. A buyer
// with no address is a hole in the record, and only that half is worth acting
// on, so the two are counted apart.
function UnknownNote({ t, what }) {
  if (!t.unknown) return null;
  const leads = t.unknown - t.unknownBuyers;
  return (
    <div className="text-[11px] mt-3 pt-3 border-t border-line space-y-0.5">
      {leads > 0 && (
        <div className="text-ink-secondary">
          {leads} prospect{leads > 1 ? 's' : ''} sans {what} — normal, ils n'ont jamais commandé
        </div>
      )}
      {t.unknownBuyers > 0 && (
        <div style={{ color: '#B45309' }}>
          {t.unknownBuyers} acheteur{t.unknownBuyers > 1 ? 's' : ''} sans {what} — à compléter
        </div>
      )}
    </div>
  );
}

// Where the clients actually are. Countries and cities side by side, because
// "90% France" and "half of them in Nîmes" are two different business facts.
// Clients whose location is unknown are stated rather than hidden, so a thin
// dataset never reads as a confident map.
function Regions() {
  const [r, setR] = useState(null);
  useEffect(() => { api.regions().then(setR).catch(() => {}); }, []);
  if (!r || !r.total) return null;

  const list = (t, emptyLabel) => {
    const max = Math.max(1, ...t.rows.map(x => x.n));
    if (!t.rows.length) {
      return <div className="text-[13px] text-ink-secondary">{emptyLabel}</div>;
    }
    return (
      <div className="space-y-2.5">
        {t.rows.slice(0, 8).map(x => (
          <div key={x.label} className="flex items-center gap-2">
            <span className="text-xs w-28 shrink-0 truncate" title={x.label}>{x.label}</span>
            <div className="flex-1 h-1.5 bg-line rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${(x.n / max) * 100}%`, background: '#3a2a23' }} />
            </div>
            <span className="text-[11px] text-ink-secondary w-8 text-right tabular-nums">{x.pct}%</span>
            <span
              className="text-xs font-medium w-10 text-right tabular-nums"
              title={`${x.buyers} client${x.buyers > 1 ? 's' : ''} ayant commandé`}
            >
              {x.n}<span className="text-ink-secondary font-normal">/{x.buyers}</span>
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-3">
          Pays
        </div>
        {list(r.countries, 'Aucun pays renseigné.')}
        <UnknownNote t={r.countries} what="pays renseigné" />
      </div>
      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">
            Villes
          </div>
          <div className="text-[10px] text-ink-secondary">contacts / acheteurs</div>
        </div>
        {list(r.cities, 'Aucune ville renseignée.')}
        <UnknownNote t={r.cities} what="ville renseignée" />
      </div>
    </div>
  );
}

// How often a finished piece was not right first time. The rate that matters
// most in bespoke: it is the one number a client feels directly, and the one
// that quietly eats a margin — a seamstress and a return shipment come out of
// the same 359 € the dashboard is so pleased about.
//
// Measured only over pieces the client has actually received. A suit still at
// the workshop cannot yet have needed a retouch, and padding the denominator
// with it would flatter the rate.
function AlterationRate() {
  const [a, setA] = useState(null);
  useEffect(() => { api.afterSalesStats().then(setA).catch(() => {}); }, []);
  if (!a) return null;

  // Below ~3 delivered pieces a percentage is noise dressed as a metric, so
  // the raw counts lead and the rate is held back until it means something.
  const meaningful = a.delivered >= 3;
  const tone = a.alterationRate == null ? '#6b5b4e'
    : a.alterationRate >= 30 ? '#DC2626'
    : a.alterationRate >= 15 ? '#B45309'
    : '#1D9E75';

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">
          Retouches après réception
        </div>
        <div className="text-[11px] text-ink-secondary">
          {a.delivered} pièce{a.delivered > 1 ? 's' : ''} reçue{a.delivered > 1 ? 's' : ''} par un client
          {a.notYetReceived > 0 && ` · ${a.notYetReceived} encore en cours`}
        </div>
      </div>

      {a.delivered === 0 ? (
        <div className="text-sm text-ink-secondary">
          Aucune pièce encore arrivée chez un client — le taux se calculera tout
          seul dès la première réception.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3">
            <div>
              <div className="text-[11px] text-ink-secondary mb-1">Perte due aux retouches</div>
              <div className="text-2xl font-medium" style={{ color: a.lossCents ? '#DC2626' : '#1a1410' }}>
                {a.lossCents ? `− ${Math.round(a.lossCents / 100)} €` : '0 €'}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                déjà déduit de la marge
              </div>
              {a.lossUnpriced > 0 && (
                <div className="text-[11px] mt-0.5" style={{ color: '#EF9F27' }}>
                  {a.lossUnpriced} incident{a.lossUnpriced > 1 ? 's' : ''} sans coût connu
                </div>
              )}
            </div>
            <div>
              <div className="text-[11px] text-ink-secondary mb-1">Taux de retouche</div>
              <div className="text-2xl font-medium" style={{ color: tone }}>
                {meaningful ? `${a.alterationRate}%` : `${a.withAlteration}/${a.delivered}`}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                {meaningful
                  ? `${a.withAlteration} sur ${a.delivered}`
                  : 'trop peu de pièces pour un %'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-ink-secondary mb-1">Refabrications</div>
              <div className="text-2xl font-medium" style={{ color: a.withRedo ? '#DC2626' : '#1a1410' }}>
                {a.withRedo}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">pièce entièrement refaite</div>
            </div>
            <div>
              <div className="text-[11px] text-ink-secondary mb-1">Bon du premier coup</div>
              <div className="text-2xl font-medium" style={{ color: '#1D9E75' }}>
                {meaningful ? `${a.firstTimeRightRate}%` : `${a.firstTimeRight}/${a.delivered}`}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">ni retouche ni refabrication</div>
            </div>
          </div>

          {a.reasons.length > 0 && (
            <div className="mt-4 pt-3 border-t border-line">
              <div className="text-[11px] text-ink-secondary mb-2">Motifs les plus fréquents</div>
              <div className="flex flex-wrap gap-2">
                {a.reasons.map(r => (
                  <span key={r.reason} className="text-[11px] border border-line px-2.5 py-1 rounded-md">
                    {r.reason}<span className="text-ink-secondary"> · {r.n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Inline editor for the two targets the dashboard measures against. They live
// in the same settings table as everything else, but they're the numbers Luc
// revises most often — sending him to another tab to change a goal he is
// looking at right now is how a goal ends up stale forever.
function TargetEditor({ revenueTarget, basketTarget, cur, onSaved, onCancel }) {
  const [revenue, setRevenue] = useState(String(revenueTarget || ''));
  const [basket, setBasket] = useState(String(basketTarget || ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    const r = Number(revenue), b = Number(basket);
    // A target of 0 or NaN would silently turn the progress bars into
    // nonsense, so it's refused here rather than stored.
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(b) || b <= 0) {
      setError('Both targets must be a number above 0.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Only these two keys are sent — the settings route writes just what it
      // receives, so nothing else in the table is touched.
      await api.updateSettings({ revenue_target: Math.round(r), avg_basket_target: Math.round(b) });
      onSaved();
    } catch (e) {
      setError(e.message || 'Could not save');
      setSaving(false);
    }
  }

  const input = 'w-32 border border-line rounded-md px-2 py-1 text-sm outline-none focus:border-accent bg-surface tabular-nums';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">
            Revenue target ({cur})
          </span>
          <input
            className={input} type="number" min="1" value={revenue} autoFocus
            onChange={e => setRevenue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">
            Average basket target ({cur})
          </span>
          <input
            className={input} type="number" min="1" value={basket}
            onChange={e => setBasket(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
          />
        </label>
        <button
          onClick={save}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="text-sm text-ink-secondary border border-line rounded-md px-3 py-1.5 hover:text-ink-primary disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && <div className="text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

export default function Dashboard({ goTo }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingTargets, setEditingTargets] = useState(false);
  // Defaults to everything: with a book this young, a month window would hide
  // most of what there is to see.
  const [range, setRange] = useState({ period: 'all' });

  const loadStats = () => api.stats().then(setStats);
  useEffect(() => {
    loadStats().finally(() => setLoading(false));
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
              {!editingTargets && (
                <button
                  onClick={() => setEditingTargets(true)}
                  className="text-[11px] text-ink-secondary border border-line rounded-md px-2 py-1 hover:text-ink-primary hover:border-ink-secondary transition-colors"
                >
                  Edit targets
                </button>
              )}
            </div>
            {editingTargets ? (
              <TargetEditor
                revenueTarget={revenueTarget}
                basketTarget={basketTarget}
                cur={cur}
                onCancel={() => setEditingTargets(false)}
                onSaved={() => { setEditingTargets(false); loadStats(); }}
              />
            ) : (
            <>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-2xl font-medium tabular-nums">{fmtMoney(revenue, cur)}</span>
              <span className="text-sm text-ink-secondary">/ {fmtMoney(revenueTarget, cur)} target</span>
              <span className="ml-auto text-lg font-medium tabular-nums" style={{ color: revenuePct >= 100 ? '#1D9E75' : '#1A1A1A' }}>{revenuePct}%</span>
            </div>
            <div className="h-3 bg-line rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${revenuePct}%`, background: revenuePct >= 100 ? '#1D9E75' : 'linear-gradient(90deg,#378ADD,#1D9E75)' }} />
            </div>
            </>
            )}
          </div>

          <PeriodBar range={range} onChange={setRange} />

          <MoneyPanels cur={cur} range={range} />

          <LeadTimePanels />

          <ProductMix range={range} cur={cur} />

          <AlterationRate />

          <SizeMix goTo={goTo} />

          <Regions />

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
