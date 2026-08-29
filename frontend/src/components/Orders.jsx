// Production board — the cross-client "where is every piece right now" view.
// Until this existed, orders were only reachable one client at a time, so
// there was no way to answer "what's late" or "what's waiting to ship"
// without opening every profile in turn.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, fmtMoney } from '../labels.js';

// Mirrors backend/lib/production.js — same order, same keys.
// From `shipped` on it's the leg to the client: shipped (tracking number in
// hand) → received (client has it) → delivered (verdict pending). `delivered`
// is NOT the end — only `finished` is, and only after the client says so.
const STAGES = [
  { id: 'not_started',      label: 'To send',      color: 'bg-gray-100 text-gray-600' },
  { id: 'sent_to_workshop', label: 'At workshop',  color: 'bg-blue-100 text-blue-700' },
  { id: 'in_production',    label: 'In production', color: 'bg-violet-100 text-violet-700' },
  { id: 'ready',            label: 'Ready',        color: 'bg-amber-100 text-amber-700' },
  { id: 'shipped',          label: 'Shipped',      color: 'bg-teal-100 text-teal-700' },
  { id: 'received',         label: 'Received',     color: 'bg-lime-100 text-lime-700' },
  { id: 'delivered',        label: 'Awaiting verdict', color: 'bg-orange-100 text-orange-700' },
  { id: 'in_alteration',    label: 'In alteration', color: 'bg-rose-100 text-rose-700' },
  { id: 'finished',         label: 'Finished',     color: 'bg-green-100 text-green-800' },
];

// The alteration sub-cycle (order_alterations.status).
const ALT_STAGES = [
  { id: 'needed',        label: 'Find a seamstress' },
  { id: 'booked',        label: 'Seamstress found' },
  { id: 'at_seamstress', label: 'At the seamstress' },
  { id: 'shipped_back',  label: 'Shipped back to client' },
];
const ALT_LABEL = Object.fromEntries(ALT_STAGES.map(s => [s.id, s.label]));

// Past `delivered` the next move is a decision, not a step — so the board
// asks instead of assuming.
const AWAITING_VERDICT = 'delivered';
const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));

// Stages that email the client — surfaced in the UI so Luc knows a click
// here reaches the client, rather than finding out from a reply.
const EMAILS_CLIENT = new Set(['in_production', 'shipped']);

// The order's whole life as a chain of hand-offs. Same six legs as the
// dashboard averages, in order, so a single order can be read against them.
// `own` marks the steps that are Luc's own doing rather than the workshop's or
// the carrier's — greyed for the same reason as on the dashboard.
const CHAIN = [
  { key: 'meeting',    label: 'Prise de commande', from: 'appointment_at',      to: 'finalized_at',        own: true },
  { key: 'toWorkshop', label: 'Envoi à l\'atelier', from: 'finalized_at',        to: 'sent_to_workshop_at', own: true },
  { key: 'docket',     label: 'Bon traité',        from: 'sent_to_workshop_at', to: 'workshop_ack_at' },
  { key: 'production', label: 'Production',        from: 'workshop_ack_at',     to: 'ready_at' },
  { key: 'handover',   label: 'Prise en charge',   from: 'ready_at',            to: 'shipped_at' },
  { key: 'transit',    label: 'Transport',         from: 'shipped_at',          to: 'received_at' },
];

const DAY = 86400000;
const daysBetween = (from, to) => (new Date(to) - new Date(from)) / DAY;
const round1 = (n) => Math.round(n * 10) / 10;

// Walks the chain and returns one entry per leg, plus which one is currently
// running. "Running" is the first leg that has started and not finished — that
// is the step an order is blocked on, and the only one worth alerting about.
function chainFor(order) {
  const legs = CHAIN.map((leg) => {
    const from = order[leg.from];
    const to = order[leg.to];
    if (from && to) {
      const d = daysBetween(from, to);
      // Stamps entered out of order would otherwise render as a negative
      // duration; better to show nothing than a number that can't be true.
      return { ...leg, state: d < 0 ? 'invalid' : 'done', days: d < 0 ? null : round1(d) };
    }
    if (from) return { ...leg, state: 'running', days: round1((Date.now() - new Date(from)) / DAY) };
    return { ...leg, state: 'pending', days: null };
  });
  return { legs, running: legs.find(l => l.state === 'running') || null };
}

// Per-step thresholds, because the steps are not comparable: a docket sitting
// unsent for three days is a problem, three days in production is nothing.
// `warn`/`bad` are in days; below `warn` the step reads as fine.
export const THRESHOLDS = {
  meeting:    { warn: 1,  bad: 3 },
  // Luc's rule: green under a day, orange from one day, red past two. This is
  // his own turnaround and the one he wants held tightest.
  toWorkshop: { warn: 1,  bad: 2 },
  // Same rule as toWorkshop, Luc's call: green under a day, orange from one
  // day, red from two. `bad` is inclusive — two days IS red, not almost red.
  docket:     { warn: 1,  bad: 2 },
  production: { warn: 21, bad: 35 },
  handover:   { warn: 3,  bad: 7 },
  transit:    { warn: 10, bad: 20 },
};

const OK = '#1D9E75', WARN = '#B45309', BAD = '#DC2626', NEUTRAL = '#6b5b4e';

export function urgency(key, days) {
  const t = THRESHOLDS[key];
  if (!t) return NEUTRAL;
  if (days >= t.bad) return BAD;
  if (days >= t.warn) return WARN;
  return OK;
}

function LeadTime({ leg }) {
  // A finished step is coloured too: knowing a docket went out in four days
  // matters after the fact, not only while the clock is running.
  const tone = (leg.state === 'running' || leg.state === 'done')
    ? urgency(leg.key, leg.days)
    : NEUTRAL;
  let text;
  if (leg.state === 'done') text = `${leg.days} j`;
  else if (leg.state === 'running') text = `${Math.round(leg.days)} j en cours`;
  else if (leg.state === 'invalid') text = 'dates incohérentes';
  else text = '—';

  return (
    <span
      className="text-[11px] border border-line px-2.5 py-1 rounded-md"
      style={leg.own ? { background: '#f4f2ef' } : undefined}
    >
      <span className="text-ink-secondary">{leg.label} </span>
      <span style={{ color: tone, fontWeight: leg.state === 'running' ? 500 : 400 }}>{text}</span>
    </span>
  );
}

function StageBadge({ stage }) {
  const s = STAGE_BY_ID[stage] || STAGES[0];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full ${s.color}`}>{s.label}</span>;
}

export { chainFor };

export default function Orders({ notify, onSelectClient }) {
  const [rows, setRows] = useState([]);
  const [seamstresses, setSeamstresses] = useState([]);
  const [costDefaults, setCostDefaults] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [includeFinished, setIncludeFinished] = useState(false);
  // 'production' = real orders, specified and closed at the fitting call.
  // 'pre_meeting' = deposits paid / calls booked, nothing specified yet.
  const [scope, setScope] = useState('production');
  const [preMeetingCount, setPreMeetingCount] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = () => {
    setLoading(true);
    api.productionBoard(includeFinished, scope)
      .then(r => {
        setRows(r.data);
        setSeamstresses(r.seamstresses || []);
        setCostDefaults(r.costDefaults || {});
        setPreMeetingCount(r.counts?.preMeeting || 0);
      })
      .catch(() => notify('Error loading orders', 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [includeFinished, scope]);

  const replaceRow = (updated) =>
    setRows(rs => rs.map(x => (x.id === updated.id ? { ...x, ...updated } : x)));

  async function run(orderId, fn, successMsg) {
    setSaving(orderId);
    try {
      const r = await fn();
      if (r.order) replaceRow(r.order);
      notify(successMsg);
      return r;
    } catch (e) {
      notify(e.message || 'Action failed', 'error');
    } finally {
      setSaving(null);
    }
  }

  const counts = useMemo(() => {
    const c = { late: rows.filter(r => r.is_late).length };
    for (const s of STAGES) c[s.id] = rows.filter(r => r.production_status === s.id).length;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === 'active') return rows;
    if (filter === 'late') return rows.filter(r => r.is_late);
    return rows.filter(r => r.production_status === filter);
  }, [rows, filter]);

  async function patch(order, body, successMsg) {
    setSaving(order.id);
    try {
      const r = await api.updateProduction(order.id, body);
      setRows(rs => rs.map(x => (x.id === order.id ? { ...x, ...r.order } : x)));
      notify(r.emailed ? `${successMsg} — client emailed` : successMsg);
    } catch (e) {
      notify(e.message || 'Update failed', 'error');
    } finally {
      setSaving(null);
    }
  }

  // Shipping needs a tracking number in the client's email, so moving to
  // "shipped" without one is blocked here rather than sending a half-empty
  // notification the client can't act on.
  function advance(order, nextStage) {
    if (nextStage === 'shipped' && !order.tracking_number) {
      notify('Add a carrier + tracking number before marking as shipped', 'error');
      setExpanded(order.id);
      return;
    }
    // Moving to "At workshop" used to only flip a status, which meant the
    // board could claim the workshop had the order while nothing had been
    // sent. The send IS the move: it emails the docket and advances the stage
    // in one go.
    if (nextStage === 'sent_to_workshop') {
      run(order.id, () => api.sendDocket(order.id), 'Bon de commande envoyé à l\'atelier');
      return;
    }
    patch(order, { productionStatus: nextStage }, `Moved to ${STAGE_BY_ID[nextStage].label}`);
  }

  return (
    <div className="space-y-4">
      <RevenueBar notify={notify} />

      {/* Two populations, never mixed: a deposit is not an order. Switching
          scope rather than filtering, because the pre-meeting rows have no
          production stage to filter by. */}
      <div className="flex items-center gap-2">
        <FilterChip active={scope === 'production'} onClick={() => { setScope('production'); setFilter('active'); }}>
          Commandes
        </FilterChip>
        <FilterChip active={scope === 'pre_meeting'} onClick={() => { setScope('pre_meeting'); setFilter('active'); }}>
          Avant RDV <Count n={preMeetingCount} />
        </FilterChip>
        <span className="text-[11px] text-ink-secondary ml-1">
          {scope === 'production'
            ? 'commandes actées en rendez-vous'
            : 'acompte payé ou RDV pris — la commande n’existe pas encore'}
        </span>
      </div>

      <div className={`flex flex-wrap items-center gap-2 ${scope === 'pre_meeting' ? 'hidden' : ''}`}>
        <FilterChip active={filter === 'active'} onClick={() => setFilter('active')}>
          All open <Count n={rows.length} />
        </FilterChip>
        {counts.late > 0 && (
          <FilterChip active={filter === 'late'} onClick={() => setFilter('late')} danger>
            Late <Count n={counts.late} />
          </FilterChip>
        )}
        {STAGES.filter(s => includeFinished || s.id !== 'finished').map(s => (
          <FilterChip key={s.id} active={filter === s.id} onClick={() => setFilter(s.id)}>
            {s.label} <Count n={counts[s.id] || 0} />
          </FilterChip>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
          <input type="checkbox" checked={includeFinished} onChange={e => setIncludeFinished(e.target.checked)} />
          Show finished
        </label>
      </div>

      {loading && <div className="text-center text-sm text-ink-secondary py-10">Loading…</div>}
      {!loading && visible.length === 0 && (
        <div className="text-center text-sm text-ink-secondary py-10 bg-surface border border-line rounded-xl">
          Nothing here.
        </div>
      )}

      <div className="space-y-2">
        {visible.map(o => {
          const idx = STAGES.findIndex(s => s.id === o.production_status);
          const next = STAGES[idx + 1];
          const isOpen = expanded === o.id;
          return (
            <div
              key={o.id}
              className={`bg-surface border rounded-xl ${o.is_late ? 'border-red-300' : 'border-line'}`}
            >
              <div className="grid grid-cols-[150px_1fr_130px_140px_auto] gap-3 items-center px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-ink-primary">
                    {o.order_number || '—'}
                    {o.revision > 1 && (
                      <span
                        className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700"
                        title="This piece has been remade — same order, not a new sale"
                      >
                        v{o.revision}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-secondary">{o.product_type || '—'}</div>
                </div>

                <button
                  type="button"
                  className="text-left hover:opacity-70 transition-opacity"
                  onClick={() => onSelectClient?.(o.client_id)}
                >
                  <div className="text-sm text-ink-primary">
                    {`${o.first_name || ''} ${o.last_name || ''}`.trim() || '—'}
                  </div>
                  <div className="text-[11px] text-ink-secondary">{o.email}</div>
                </button>

                <div>
                  <StageBadge stage={o.production_status} />
                  {o.is_late && (
                    <div className="text-[10px] text-red-600 mt-1">
                      Late · due {fmtDate(o.workshop_deadline)}
                    </div>
                  )}
                  {!o.is_late && o.workshop_deadline && (
                    <div className="text-[10px] text-ink-secondary mt-1">
                      Due {fmtDate(o.workshop_deadline)}
                    </div>
                  )}
                  {/* The step the order is currently sitting on, and for how
                      long — visible without expanding, because spotting where
                      things jam is a scan down the list, not four clicks. */}
                  {(() => {
                    const run = chainFor(o).running;
                    if (!run) return null;
                    return (
                      <div className="text-[10px] mt-1" style={{ color: urgency(run.key, run.days) }}>
                        {run.label} · {Math.round(run.days)} j
                      </div>
                    );
                  })()}
                </div>

                {/* What's still owed is the number that needs chasing, so it
                    leads — the order total is the context underneath it. */}
                <div className="text-[11px]">
                  {o.balance_status === 'paid' ? (
                    <>
                      <div className="text-sm font-medium text-green-700">Paid in full</div>
                      <div className="text-ink-secondary">
                        {fmtMoney((o.deposit_amount_cents || 0) / 100 + (o.balance_amount_cents || 0) / 100)}
                      </div>
                    </>
                  ) : o.balance_status === 'link_created' ? (
                    <>
                      <div className="text-sm font-medium text-amber-700">
                        {fmtMoney((o.balance_amount_cents || 0) / 100)} due
                      </div>
                      <div className="text-ink-secondary">
                        of {fmtMoney((o.deposit_amount_cents || 0) / 100 + (o.balance_amount_cents || 0) / 100)}
                      </div>
                    </>
                  ) : o.quoted_total_cents ? (
                    // No fitting call yet, so nothing is agreed — but the site
                    // did quote a price, so show the balance that quote implies
                    // rather than a blank "total TBC". Labelled as a quote.
                    <>
                      <div className="text-sm font-medium text-ink-secondary">
                        {fmtMoney(((o.quoted_total_cents || 0) - (o.deposit_amount_cents || 0)) / 100)} to bill
                      </div>
                      <div className="text-ink-secondary">
                        of {fmtMoney((o.quoted_total_cents || 0) / 100)} · after the call
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm font-medium text-ink-secondary">Deposit only</div>
                      <div className="text-ink-secondary">
                        {fmtMoney((o.deposit_amount_cents || 0) / 100)} · total TBC
                      </div>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Past delivery the next move is the client's verdict, so
                      the board offers the three real outcomes instead of a
                      generic "next" that would close orders nobody confirmed. */}
                  {o.production_status === AWAITING_VERDICT && (
                    <>
                      <button
                        type="button"
                        disabled={saving === o.id}
                        onClick={() => run(o.id, () => api.updateProduction(o.id, { productionStatus: 'finished' }), 'Order closed')}
                        className="bg-green-700 text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-green-800 disabled:opacity-40 whitespace-nowrap"
                      >
                        ✓ Happy
                      </button>
                      <button
                        type="button"
                        disabled={saving === o.id}
                        onClick={() => {
                          const reason = window.prompt('What needs adjusting?');
                          if (reason === null) return;
                          run(o.id, () => api.createAlteration(o.id, reason), 'Alteration opened')
                            .then(() => setExpanded(o.id));
                        }}
                        className="border border-line text-xs px-3 py-1.5 rounded-md hover:bg-bg disabled:opacity-40 whitespace-nowrap"
                      >
                        Alteration
                      </button>
                      <button
                        type="button"
                        disabled={saving === o.id}
                        onClick={() => {
                          const reason = window.prompt('Why is it being remade? (kept on the same order)');
                          if (reason === null) return;
                          run(o.id, () => api.redoOrder(o.id, reason), 'Remake started — back to the workshop');
                        }}
                        className="border border-line text-xs px-3 py-1.5 rounded-md hover:bg-bg disabled:opacity-40 whitespace-nowrap"
                      >
                        Remake
                      </button>
                    </>
                  )}
                  {next && o.production_status !== AWAITING_VERDICT && o.production_status !== 'in_alteration' && (
                    <button
                      type="button"
                      // An order whose fitting call was never closed has no
                      // agreed spec, so there is nothing to send anyone. Guarded
                      // on the order itself, not on the current view, so no
                      // future filter can reopen this hole.
                      disabled={saving === o.id || !o.finalized_at}
                      onClick={() => advance(o, next.id)}
                      className="bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40 whitespace-nowrap"
                      title={
                        !o.finalized_at ? 'Commande non finalisée en rendez-vous'
                          : next.id === 'sent_to_workshop' ? 'Envoie le bon de commande à l\'atelier'
                          : EMAILS_CLIENT.has(next.id) ? 'This emails the client' : undefined
                      }
                    >
                      → {next.label}
                      {(EMAILS_CLIENT.has(next.id) || next.id === 'sent_to_workshop') && ' ✉'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : o.id)}
                    className="text-xs text-ink-secondary px-2 py-1.5 hover:text-ink-primary"
                  >
                    {isOpen ? 'Close' : 'Details'}
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-line px-4 py-4 space-y-3 bg-bg rounded-b-xl">
                  <div className="grid grid-cols-4 gap-3">
                    <LabeledInput
                      label="Workshop deadline" type="date"
                      value={o.workshop_deadline ? String(o.workshop_deadline).slice(0, 10) : ''}
                      onCommit={v => patch(o, { workshopDeadline: v }, 'Deadline updated')}
                    />
                    <LabeledInput
                      label="Carrier" value={o.carrier || ''} placeholder="Colissimo, DHL…"
                      onCommit={v => patch(o, { carrier: v }, 'Carrier updated')}
                    />
                    <LabeledInput
                      label="Tracking number" value={o.tracking_number || ''}
                      onCommit={v => patch(o, { trackingNumber: v }, 'Tracking updated')}
                    />
                    {/* Feeds the margin figures. Blank falls back to the
                        standard cost for this piece; with no standard either,
                        the order is excluded from margin rather than counted
                        as free. */}
                    <LabeledInput
                      label="Your cost (€)" type="number"
                      placeholder={costDefaults[o.product_type]
                        ? `${costDefaults[o.product_type] / 100} (standard)`
                        : 'workshop + fabric'}
                      value={o.cost_cents == null ? '' : String(o.cost_cents / 100)}
                      onCommit={v => patch(
                        o,
                        { costCents: v === '' ? '' : Math.round(Number(v) * 100) },
                        v === '' ? 'Cost cleared' : 'Cost updated',
                      )}
                    />
                    <div>
                      <div className="text-[11px] text-ink-secondary mb-1">Set stage</div>
                      <select
                        value={o.production_status}
                        onChange={e => advance(o, e.target.value)}
                        className="w-full border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent"
                      >
                        {STAGES.map(s => (
                          <option key={s.id} value={s.id}>{s.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {(o.alterations || []).map(alt => (
                    <AlterationPanel
                      key={alt.id}
                      alt={alt}
                      order={o}
                      seamstresses={seamstresses}
                      saving={saving === o.id}
                      onPatch={(body, msg) => run(o.id, () => api.updateAlteration(alt.id, body), msg)}
                      onSendDetails={() =>
                        run(o.id, async () => {
                          const r = await api.sendAlterationDetails(alt.id);
                          return { ...r, order: null };
                        }, 'Seamstress details emailed to the client')
                      }
                    />
                  ))}

                  {/* See exactly what the client gets, including the chases
                      that haven't fired yet. Opens a preview — sends nothing. */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] text-ink-secondary">Client emails</span>
                    {[
                      ['recap', 'Recap'],
                      ['reminder1', 'Reminder · 2 days'],
                      ['reminder2', 'Reminder · 5 working days'],
                    ].map(([stage, label]) => (
                      <a
                        key={stage}
                        href={`/api/orders/${o.id}/email-preview?stage=${stage}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] border border-line px-2.5 py-1 rounded-md hover:bg-surface text-ink-secondary hover:text-ink-primary"
                      >
                        {label} ↗
                      </a>
                    ))}
                    {o.recap_email_sent_at && (
                      <span className="text-[11px] text-ink-secondary">
                        Recap sent {fmtDate(o.recap_email_sent_at)}
                        {o.balance_reminder_1_sent_at && ` · 1st reminder ${fmtDate(o.balance_reminder_1_sent_at)}`}
                        {o.balance_reminder_2_sent_at && ` · 2nd reminder ${fmtDate(o.balance_reminder_2_sent_at)}`}
                      </span>
                    )}
                  </div>

                  {/* The two documents that leave the CRM. Both are rebuilt from
                      the order on demand, so this is the same PDF the workshop
                      and the client received — not a stored copy that could
                      drift from it. */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] text-ink-secondary">Documents</span>
                    <a
                      href={`/api/orders/${o.id}/production-order.pdf`}
                      target="_blank" rel="noreferrer"
                      className="text-[11px] border border-line px-2.5 py-1 rounded-md hover:bg-surface text-ink-secondary hover:text-ink-primary"
                    >
                      Workshop order (PDF) ↗
                    </a>
                    <a
                      href={`/api/orders/${o.id}/production-order.xlsx`}
                      className="text-[11px] border border-line px-2.5 py-1 rounded-md hover:bg-surface text-ink-secondary hover:text-ink-primary"
                    >
                      Workshop order (Excel) ↓
                    </a>
                    <a
                      href={`/api/orders/${o.id}/invoice.pdf`}
                      target="_blank" rel="noreferrer"
                      className="text-[11px] border border-line px-2.5 py-1 rounded-md hover:bg-surface text-ink-secondary hover:text-ink-primary"
                    >
                      Invoice (PDF) ↗
                    </a>
                    {o.sent_to_workshop_at && (
                      <span className="text-[11px] text-ink-secondary">
                        Sent to the workshop {fmtDate(o.sent_to_workshop_at)}
                      </span>
                    )}
                  </div>

                  {/* The full chain. Reading it left to right shows where an
                      order actually sits, and which step it has been sitting
                      on — which is the only way to tell a slow workshop from a
                      slow week of one's own. */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-ink-secondary">Étapes</span>
                    {chainFor(o).legs.map(leg => <LeadTime key={leg.key} leg={leg} />)}
                  </div>

                  {/* Derived from the Size chart tab, never stored on the order:
                      edit a range there and this follows. "≈" means the closest
                      row rather than a row the client falls entirely inside. */}
                  {o.standard_size && (
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[11px] text-ink-secondary">Taille standard</span>
                      <span className="text-[11px] border border-line px-2.5 py-1 rounded-md">
                        <span className="font-medium">{o.standard_size.exact ? '' : '≈ '}{o.standard_size.label}</span>
                        <span className="text-ink-secondary">
                          {o.standard_size.exact ? ' · dans les bornes' : ' · la plus proche'}
                        </span>
                      </span>
                    </div>
                  )}

                  {o.production_notes && (
                    <div>
                      <div className="text-[11px] text-ink-secondary mb-1">Production notes (from the meeting)</div>
                      <p className="text-sm text-ink-primary whitespace-pre-wrap">{o.production_notes}</p>
                    </div>
                  )}

                  {(() => {
                    let past = [];
                    try { past = JSON.parse(o.production_history || '[]'); } catch { past = []; }
                    if (!past.length) return null;
                    return (
                      <div>
                        <div className="text-[11px] text-ink-secondary mb-1">Previous rounds</div>
                        {past.map(h => (
                          <div key={h.revision} className="text-[11px] text-ink-secondary">
                            v{h.revision} — remade {fmtDate(h.closed_at)}
                            {h.reason ? ` · ${h.reason}` : ''}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-ink-secondary pt-1">
                    {[
                      ['Sent to workshop', o.sent_to_workshop_at],
                      ['In production', o.in_production_at],
                      ['Ready', o.ready_at],
                      ['Shipped', o.shipped_at],
                      ['Received', o.received_at],
                      ['Delivered', o.delivered_at],
                    ].filter(([, v]) => v).map(([label, v]) => (
                      <span key={label}>{label}: {fmtDate(v)}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One alteration round. The seamstress fields are what make the round
// actionable, so the sub-cycle can't advance past "found" without them.
function AlterationPanel({ alt, seamstresses, saving, onPatch, onSendDetails }) {
  const idx = ALT_STAGES.findIndex(s => s.id === alt.status);
  const next = ALT_STAGES[idx + 1];
  const hasSeamstress = !!(alt.seamstress_name && alt.seamstress_address);

  const advance = () => {
    if (!next) return;
    if (next.id !== 'needed' && !hasSeamstress) return;
    onPatch({ status: next.id }, `Alteration → ${next.label}`);
  };

  return (
    <div className="border border-rose-200 bg-rose-50/40 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium text-rose-700">
          Alteration · round {alt.round} · {ALT_LABEL[alt.status]}
        </div>
        {next && (
          <button
            type="button"
            disabled={saving || (!hasSeamstress && next.id !== 'needed')}
            onClick={advance}
            title={!hasSeamstress ? 'Add the seamstress name and address first' : undefined}
            className="bg-rose-700 text-white text-xs px-3 py-1 rounded-md hover:bg-rose-800 disabled:opacity-40"
          >
            → {next.label}
          </button>
        )}
      </div>

      {alt.reason && <p className="text-sm text-ink-primary whitespace-pre-wrap">{alt.reason}</p>}

      <div className="grid grid-cols-3 gap-3">
        <LabeledInput
          label="Seamstress" value={alt.seamstress_name || ''}
          list={seamstresses.length ? 'seamstress-names' : undefined}
          onCommit={v => {
            // Picking a known seamstress fills her address and phone too —
            // the whole point of remembering them.
            const known = seamstresses.find(s => s.name === v);
            onPatch(
              known
                ? { seamstressName: v, seamstressAddress: known.address, seamstressPhone: known.phone }
                : { seamstressName: v },
              'Seamstress updated',
            );
          }}
        />
        <LabeledInput
          label="Address" value={alt.seamstress_address || ''}
          onCommit={v => onPatch({ seamstressAddress: v }, 'Address updated')}
        />
        <LabeledInput
          label="Phone" value={alt.seamstress_phone || ''}
          onCommit={v => onPatch({ seamstressPhone: v }, 'Phone updated')}
        />
      </div>

      {seamstresses.length > 0 && (
        <datalist id="seamstress-names">
          {seamstresses.map(s => <option key={s.name} value={s.name} />)}
        </datalist>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving || !hasSeamstress}
          onClick={onSendDetails}
          title={!hasSeamstress ? 'Add the seamstress name and address first' : undefined}
          className="border border-rose-300 text-rose-700 text-xs px-3 py-1.5 rounded-md hover:bg-rose-100 disabled:opacity-40"
        >
          ✉ Email the drop-off details to the client
        </button>
        <div className="flex flex-wrap gap-x-4 text-[11px] text-ink-secondary">
          {[
            ['Opened', alt.needed_at],
            ['Booked', alt.booked_at],
            ['Dropped off', alt.dropped_off_at],
            ['Shipped back', alt.shipped_back_at],
          ].filter(([, v]) => v).map(([l, v]) => <span key={l}>{l}: {fmtDate(v)}</span>)}
        </div>
      </div>
    </div>
  );
}

// The money, above the board it describes. Cleared and outstanding are kept
// visually apart on purpose — one is revenue, the other is a hope.
function RevenueBar({ notify }) {
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState(null);

  useEffect(() => {
    api.revenue(period)
      .then(setData)
      .catch(() => notify?.('Error loading revenue', 'error'));
  }, [period]);

  const eur = (cents) => `€ ${((cents || 0) / 100).toLocaleString('fr-FR', { maximumFractionDigits: 0 })}`;
  const peak = Math.max(1, ...(data?.byMonth || []).map(m => m.cents));

  return (
    <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Revenue</span>
        <div className="ml-auto flex gap-1">
          {[['month', 'This month'], ['year', 'This year'], ['all', 'All time']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPeriod(id)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                period === id ? 'bg-accent text-white' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="text-sm text-ink-secondary py-4">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-5">
            <div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em]">Collected</div>
              <div className="text-2xl font-medium text-ink-primary">{eur(data.collected.totalCents)}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                {eur(data.collected.deposits.cents)} deposits · {eur(data.collected.balances.cents)} balances
              </div>
            </div>
            <div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em]">Outstanding</div>
              <div className={`text-2xl font-medium ${data.outstanding.cents > 0 ? 'text-amber-700' : 'text-ink-secondary'}`}>
                {eur(data.outstanding.cents)}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                {data.outstanding.count} balance{data.outstanding.count === 1 ? '' : 's'} unpaid
              </div>
            </div>
            <div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em]">Settled orders</div>
              <div className="text-2xl font-medium text-ink-primary">{data.orders.fullyPaid}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                {data.orders.awaitingBalance} awaiting balance · {data.orders.awaitingMeeting} awaiting meeting
              </div>
            </div>
            <div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em]">Average basket</div>
              <div className="text-2xl font-medium text-ink-primary">{eur(data.avgBasketCents)}</div>
              <div className="text-[11px] text-ink-secondary mt-0.5">on fully paid orders</div>
            </div>
            {/* Unit economics: what one finished piece actually leaves. The
                dashboard's margins are business-wide totals — this is the
                per-piece figure, which is the one that decides whether the
                price is right. */}
            <div>
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em]">Margin per order</div>
              <div className={`text-2xl font-medium ${data.margin?.perOrder?.netCents == null ? 'text-ink-secondary' : 'text-green-700'}`}>
                {data.margin?.perOrder?.netCents == null ? '—' : eur(data.margin.perOrder.netCents)}
              </div>
              <div className="text-[11px] text-ink-secondary mt-0.5">
                {data.margin?.perOrder?.netCents == null
                  ? 'no produced order yet'
                  : `net · ${eur(data.margin.perOrder.grossCents)} before Stripe`}
              </div>
            </div>
          </div>

          {data.byMonth.length > 1 && (
            <div className="pt-1">
              <div className="text-[10px] text-ink-secondary uppercase tracking-[0.06em] mb-2">
                Cleared, last {data.byMonth.length} months
              </div>
              {/* Bars and labels are separate rows: a percentage height only
                  resolves against a parent with a definite height, so nesting
                  the label in the same column collapsed every bar to nothing. */}
              <div className="flex items-end gap-1.5 h-16">
                {data.byMonth.map(m => (
                  <div key={m.month} className="flex-1 h-full flex flex-col justify-end" title={`${m.month} — ${eur(m.cents)}`}>
                    <div
                      className="w-full bg-accent/80 rounded-sm min-h-[2px]"
                      style={{ height: `${Math.max(2, Math.round((m.cents / peak) * 100))}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5 mt-1">
                {data.byMonth.map(m => (
                  <span key={m.month} className="flex-1 text-center text-[9px] text-ink-secondary">
                    {m.month.slice(5)}
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

function FilterChip({ active, onClick, danger, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? danger ? 'bg-red-600 text-white border-red-600' : 'bg-accent text-white border-accent'
          : danger ? 'border-red-300 text-red-600 hover:bg-red-50' : 'border-line text-ink-secondary hover:text-ink-primary'
      }`}
    >
      {children}
    </button>
  );
}

function Count({ n }) {
  return <span className="opacity-60">{n}</span>;
}

// Commits on blur/Enter rather than per keystroke — every commit is a PATCH,
// and firing one per character would hammer the API mid-typing.
function LabeledInput({ label, value, onCommit, type = 'text', placeholder, list }) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const commit = () => { if (local !== value) onCommit(local); };
  return (
    <div>
      <div className="text-[11px] text-ink-secondary mb-1">{label}</div>
      <input
        type={type}
        value={local}
        placeholder={placeholder}
        list={list}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-full border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent"
      />
    </div>
  );
}
