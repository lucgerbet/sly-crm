import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { chainFor, urgency, THRESHOLDS } from './Orders.jsx';
import { TIMING, POTENTIAL, sourceBadge, fmtMoney, fmtDate, daysUntil, initials } from '../labels.js';

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
          {[c.city, sourceBadge(c.source)?.label || c.source].filter(Boolean).join(' · ') || '—'} · {fmtMoney(c.lifetime_value ?? c.ca_lifetime)}
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

// Clients waiting on a measuring tape. Lives in My Day rather than its own
// page because it's a physical errand tied to the day, not a record to browse
// — and the alert email alone was too easy to read once and forget.
function TapeQueue({ rows, onSelect, onSent, busyId, productUrl, onSaveUrl }) {
  const [copied, setCopied] = useState(null);
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState(productUrl || '');
  useEffect(() => { setUrlDraft(productUrl || ''); }, [productUrl]);
  if (rows.length === 0) return null;

  const copyAddress = async (c) => {
    const block = `${c.first_name || ''} ${c.last_name || ''}\n${c.address || ''}`.trim();
    await navigator.clipboard.writeText(block);
    setCopied(c.id);
    setTimeout(() => setCopied(null), 1800);
  };

  // Copies the address AND opens the shop, in that order — at checkout the
  // delivery address has to be typed in anyway, so having it already on the
  // clipboard is what turns this into one click plus a paste.
  const orderFor = async (c) => {
    await copyAddress(c);
    window.open(productUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Section title="Measuring tapes to send" count={`${rows.length} waiting`} color="#EF9F27">
      {/* The link lives where it's used. Until it's set the queue still works
          — you just don't get the shortcut. */}
      {(!productUrl || editingUrl) && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg border-b border-line">
          <span className="text-[11px] text-ink-secondary whitespace-nowrap">Tape measure link</span>
          <input
            value={urlDraft}
            onChange={e => setUrlDraft(e.target.value)}
            placeholder="Paste the product page URL — used by the Order button below"
            className="flex-1 border border-line rounded-md px-2.5 py-1 text-xs bg-surface outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => { onSaveUrl(urlDraft.trim()); setEditingUrl(false); }}
            className="bg-accent text-white text-xs px-3 py-1 rounded-md hover:bg-accent/90"
          >
            Save
          </button>
        </div>
      )}
      {rows.map(c => (
        <div key={c.id} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-0">
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            className="text-left hover:opacity-70 transition-opacity min-w-[160px]"
          >
            <div className="text-sm font-medium text-ink-primary">
              {`${c.first_name || ''} ${c.last_name || ''}`.trim() || '—'}
            </div>
            <div className="text-[11px] text-ink-secondary">{c.email}</div>
          </button>
          <div className="text-xs text-ink-secondary flex-1">
            {c.address || <span className="text-red-600">No address — add one on the profile</span>}
          </div>
          <button
            type="button"
            onClick={() => copyAddress(c)}
            disabled={!c.address}
            className="text-xs border border-line px-2.5 py-1.5 rounded-md hover:bg-bg disabled:opacity-40"
          >
            {copied === c.id ? 'Copied ✓' : 'Copy address'}
          </button>
          {productUrl && (
            <button
              type="button"
              onClick={() => orderFor(c)}
              disabled={!c.address}
              title="Copies the address, then opens the product page — paste it at checkout"
              className="text-xs border border-accent text-accent px-2.5 py-1.5 rounded-md hover:bg-accent/5 disabled:opacity-40 whitespace-nowrap"
            >
              Order ↗
            </button>
          )}
          <button
            type="button"
            disabled={busyId === c.id}
            onClick={() => onSent(c)}
            className="bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40 whitespace-nowrap"
          >
            Mark as sent
          </button>
        </div>
      ))}
      {productUrl && !editingUrl && (
        <button
          type="button"
          onClick={() => setEditingUrl(true)}
          className="text-[11px] text-ink-secondary hover:text-ink-primary px-4 py-2"
        >
          Change the tape measure link
        </button>
      )}
    </Section>
  );
}

// Orders closed with the client but whose docket hasn't left for the workshop.
// This is the one delay nobody else can be blamed for, so it belongs on the
// day's to-do list rather than buried in a board Luc has to think to open.
function DocketQueue({ title, legKey, rows, onAct, actionLabel, busyId, note }) {
  if (!rows.length) return null;
  const t = THRESHOLDS[legKey];

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#B45309' }} />
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {title}
          </span>
        </div>
        <span className="text-[11px] text-ink-secondary">
          vert &lt; {t.warn} j · orange dès {t.warn} j · rouge dès {t.bad} j
        </span>
      </div>

      {rows.map(({ order, days }) => {
        const colour = urgency(legKey, days);
        // The chase only makes sense once the wait is actually a problem;
        // offering it on day zero would train Luc to chase reflexively.
        const actionable = !note || days >= t.warn;
        return (
          <div key={order.id} className="px-4 py-3 border-b border-line last:border-0 flex items-center gap-3">
            <div className="w-32 shrink-0">
              <div className="text-sm font-medium">{order.order_number}</div>
              <div className="text-[11px] text-ink-secondary">{order.product_type}</div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">
                {[order.first_name, order.last_name].filter(Boolean).join(' ')}
              </div>
              <div className="text-[11px] text-ink-secondary truncate">
                {note && order.workshop_reminder_sent_at
                  ? `Relancé le ${fmtDate(order.workshop_reminder_sent_at)}`
                  : order.email}
              </div>
            </div>
            <div className="text-sm font-medium tabular-nums w-24 text-right" style={{ color: colour }}>
              {days < 1 ? "aujourd'hui" : `${Math.floor(days)} j d'attente`}
            </div>
            {actionable ? (
              <button
                onClick={() => onAct(order)}
                disabled={busyId === order.id}
                className="text-sm bg-accent text-white px-3 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40 shrink-0"
              >
                {busyId === order.id ? 'Envoi…' : actionLabel}
              </button>
            ) : (
              <span className="text-[11px] text-ink-secondary w-[110px] text-center shrink-0">
                dans les délais
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Daily({ notify, onSelect, onChanged }) {
  const [data, setData] = useState(null);
  const [tapes, setTapes] = useState([]);
  const [tapeUrl, setTapeUrl] = useState('');
  const [dockets, setDockets] = useState([]);
  const [unopened, setUnopened] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    api.tracker().then(setData).catch(() => notify('Error loading tracker', 'error')).finally(() => setLoading(false));
    api.tapeQueue()
      .then(r => { setTapes(r.data); setTapeUrl(r.productUrl || ''); })
      .catch(() => setTapes([]));
    // Reuses the board's own chain logic rather than re-deriving "waiting to
    // be sent" here, so the day list and the board can never disagree.
    api.productionBoard(false)
      .then(r => {
        const running = (key) => r.data
          .map(order => ({ order, leg: chainFor(order).legs.find(l => l.key === key) }))
          .filter(x => x.leg?.state === 'running')
          .map(x => ({ order: x.order, days: x.leg.days }))
          .sort((a, b) => b.days - a.days);
        setDockets(running('toWorkshop'));
        setUnopened(running('docket'));
      })
      .catch(() => setDockets([]));
  }
  useEffect(() => { load(); }, []);

  async function saveTapeUrl(url) {
    try {
      await api.updateSettings({ tape_measure_product_url: url });
      setTapeUrl(url);
      notify(url ? 'Tape measure link saved' : 'Tape measure link cleared', 'success');
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async function sendDocket(order) {
    setBusyId(order.id);
    try {
      const r = await api.sendDocket(order.id);
      setDockets(ds => ds.filter(d => d.order.id !== order.id));
      notify(`Bon de commande envoyé à ${r.sentTo}`, 'success');
      onChanged?.();
    } catch (e) {
      notify(e.message || 'Envoi impossible', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function remindWorkshop(order) {
    setBusyId(order.id);
    try {
      const r = await api.remindWorkshop(order.id);
      setUnopened(us => us.map(u => (u.order.id === order.id ? { ...u, order: { ...u.order, ...r.order } } : u)));
      notify(`Relance envoyée à ${r.sentTo}`, 'success');
    } catch (e) {
      notify(e.message || 'Relance impossible', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function markTapeSent(c) {
    setBusyId(c.id);
    try {
      await api.updateClient(c.id, { tape_measure_sent_at: new Date().toISOString() });
      setTapes(ts => ts.filter(t => t.id !== c.id));
      notify(`Tape marked as sent to ${c.first_name || ''}`.trim(), 'success');
      onChanged?.();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

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

      <DocketQueue
        title="Bons de commande à envoyer à l'atelier"
        legKey="toWorkshop"
        rows={dockets}
        onAct={sendDocket}
        actionLabel="Envoyer à l'atelier"
        busyId={busyId}
      />

      <DocketQueue
        title="Bons non ouverts par l'atelier"
        legKey="docket"
        rows={unopened}
        onAct={remindWorkshop}
        actionLabel="Relancer l'atelier"
        busyId={busyId}
        note
      />

      <TapeQueue
        rows={tapes}
        onSelect={onSelect}
        onSent={markTapeSent}
        busyId={busyId}
        productUrl={tapeUrl}
        onSaveUrl={saveTapeUrl}
      />

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
