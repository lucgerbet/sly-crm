import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  TIMING, VALUE_TIERS, STAGE_PREREQ, STAGE_META, CONTACT_TYPE_OPTS, CONTACT_TYPE_BADGE,
  valueTier, monthsSince, fmtDate, fmtMoney,
} from '../labels.js';
import { downloadCsv } from '../exportCsv.js';

const STAGE_OPTS = [
  ['', 'All stages'],
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['answered', 'Replied'],
  ['appointment', 'Meeting'],
  ['won', 'Client'],
  ['lost', 'Lost'],
];

const TIER_OPTS = [
  ['', 'All tiers'],
  ['platinum', 'Platinum'],
  ['gold', 'Gold'],
  ['silver', 'Silver'],
  ['bronze', 'Bronze'],
];

function Badge({ on, label, onClick }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={onClick ? `Click to toggle "${label}"` : undefined}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full transition-colors ${
        on ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-400'
      } ${onClick ? 'cursor-pointer hover:opacity-70' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-green-500' : 'bg-gray-300'}`} />
      {label}
    </Tag>
  );
}

const selectCls = 'border border-line rounded-md px-2 py-1.5 text-sm bg-surface outline-none focus:border-accent';

// `mode` splits the book in two, because a prospect and a client are not the
// same object with a different flag: one is someone whose details were
// collected, the other is someone who paid. Showing them together forces the
// reader to filter mentally on every glance.
export default function ClientList({ onSelect, onNew, notify, initialFilters = {}, mode = 'clients' }) {
  const isProspects = mode === 'prospects';
  const [clients, setClients] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState(initialFilters.stage || '');
  const [timing, setTiming] = useState(initialFilters.timing || '');
  const [tier, setTier] = useState(initialFilters.valueTier || '');
  const [contactType, setContactType] = useState(initialFilters.contactType || '');
  const [assignedTo, setAssignedTo] = useState(initialFilters.assignedTo || '');
  const [assignees, setAssignees] = useState([]);

  const debounceRef = useRef(null);

  useEffect(() => {
    api.listAssignees().then(r => setAssignees(r.data)).catch(() => {});
  }, []);

  function load(params) {
    setLoading(true);
    api.listClients(params)
      .then(r => { setClients(r.data); setTotal(r.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function toggleOff(client, field) {
    const prev = client[field];
    setClients(cs => cs.map(c => (c.id === client.id ? { ...c, [field]: 0 } : c)));
    try {
      const updated = await api.updateClient(client.id, { [field]: 0 });
      setClients(cs => cs.map(c => (c.id === client.id ? { ...c, ...updated } : c)));
    } catch {
      setClients(cs => cs.map(c => (c.id === client.id ? { ...c, [field]: prev } : c)));
    }
  }

  async function toggleOn(client, field) {
    setClients(cs => cs.map(c => (c.id === client.id ? { ...c, [field]: 1 } : c)));
    try {
      const updated = await api.updateClient(client.id, { [field]: 1 });
      setClients(cs => cs.map(c => (c.id === client.id ? { ...c, ...updated } : c)));
    } catch (e) {
      setClients(cs => cs.map(c => (c.id === client.id ? { ...c, [field]: 0 } : c)));
      notify?.(e.message, 'error');
    }
  }

  function attemptToggle(e, client, field) {
    e.stopPropagation();
    if (client[field]) { toggleOff(client, field); return; }
    const prereq = STAGE_PREREQ[field];
    if (prereq && !client[prereq]) {
      notify?.(`Complete "${STAGE_META[prereq]?.label || prereq}" first`, 'error');
      return;
    }
    toggleOn(client, field);
  }

  useEffect(() => {
    if (initialFilters.stage) setStage(initialFilters.stage);
    if (initialFilters.timing) setTiming(initialFilters.timing);
  }, [initialFilters.stage, initialFilters.timing]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load({
        q: search || undefined, stage: stage || undefined, timing: timing || undefined,
        valueTier: isProspects ? undefined : (tier || undefined),
        // The mode decides the population; the dropdown only narrows within it.
        contactType: isProspects ? (contactType || 'prospect') : 'client',
        assignedTo: assignedTo || undefined,
      });
    }, 200);
  }, [search, stage, timing, tier, contactType, assignedTo, isProspects]);

  const hasFilters = search || stage || timing || tier || contactType || assignedTo;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <input
          className="border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent w-48"
          placeholder="Search name / email / phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {!isProspects && (
          <select className={selectCls} value={tier} onChange={e => setTier(e.target.value)}>
            {TIER_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        <select className={selectCls} value={stage} onChange={e => setStage(e.target.value)}>
          {STAGE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className={selectCls} value={contactType} onChange={e => setContactType(e.target.value)}>
          {CONTACT_TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className={selectCls} value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
          <option value="">All assignees</option>
          <option value="__unassigned__">Unassigned</option>
          {assignees.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        {hasFilters && (
          <button className="text-xs text-ink-secondary hover:text-ink-primary border border-line rounded-md px-3 py-1.5"
            onClick={() => { setSearch(''); setStage(''); setTiming(''); setTier(''); setContactType(''); setAssignedTo(''); }}>
            Clear
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-ink-secondary">{total} client{total !== 1 ? 's' : ''}</span>
          <button
            className="text-sm text-ink-secondary border border-line rounded-md px-3 py-1.5 hover:text-ink-primary disabled:opacity-40 inline-flex items-center gap-1.5"
            onClick={() => downloadCsv(clients)} disabled={!clients.length} title="Export the current view to CSV">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Export CSV
          </button>
          <button className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 transition-colors" onClick={onNew}>
            + Add
          </button>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="grid grid-cols-[190px_1fr_150px_150px_90px] border-b border-line px-4 py-2.5 bg-bg">
          <span className="text-[11px] font-medium text-ink-secondary">{isProspects ? 'Prospect' : 'Client'}</span>
          <span className="text-[11px] font-medium text-ink-secondary">Pipeline</span>
          <span className="text-[11px] font-medium text-ink-secondary">
            {isProspects ? 'Origine' : 'Lifetime rev. · tier'}
          </span>
          <span className="text-[11px] font-medium text-ink-secondary">
            {isProspects ? 'Ajouté le' : 'Last purchase'}
          </span>
          <span className="text-[11px] font-medium text-ink-secondary">Timing</span>
        </div>

        {loading && <div className="px-4 py-10 text-center text-sm text-ink-secondary">Loading…</div>}
        {!loading && clients.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-ink-secondary">
            {hasFilters
              ? (isProspects ? 'Aucun prospect ne correspond à ces filtres.' : 'No clients match these filters.')
              : (isProspects
                ? 'Aucun prospect — ils arrivent tout seuls dès qu\'un visiteur laisse son email sur le site.'
                : 'Aucun client encore — un contact devient client dès son premier acompte payé.')}
          </div>
        )}

        {!loading && clients.map(c => {
          const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
          const timingCfg = TIMING[c.eff_timing];
          // Derived server-side from Stripe-confirmed payments, not typed by hand.
          const tierKey = valueTier(c.lifetime_value ?? c.ca_lifetime);
          const tierCfg = VALUE_TIERS[tierKey];
          const mo = monthsSince(c.last_purchase_at || c.last_purchase_date);
          return (
            <div
              key={c.id}
              className="grid grid-cols-[190px_1fr_150px_150px_90px] border-b border-line last:border-0 px-4 py-3 items-center hover:bg-bg cursor-pointer transition-colors"
              onClick={() => onSelect(c.id)}
            >
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-ink-primary">{name}</span>
                  {CONTACT_TYPE_BADGE[c.contact_type] && (
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${CONTACT_TYPE_BADGE[c.contact_type].color}`}>
                      {CONTACT_TYPE_BADGE[c.contact_type].label}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-secondary">{[c.city, c.source].filter(Boolean).join(' · ') || '—'}</div>
                {c.assigned_to && (
                  <div className="text-[10px] text-accent font-medium mt-0.5">→ {c.assigned_to}</div>
                )}
              </div>
              <div className="flex gap-1 flex-wrap">
                <Badge on={!!c.contacted}   label="Contacted" onClick={e => attemptToggle(e, c, 'contacted')} />
                <Badge on={!!c.answered}    label="Replied"   onClick={e => attemptToggle(e, c, 'answered')} />
                <Badge on={!!c.appointment} label="Meeting"   onClick={e => attemptToggle(e, c, 'appointment')} />
                <Badge on={!!c.won}         label="Client"    onClick={e => attemptToggle(e, c, 'won')} />
                {!!c.lost && <Badge on={false} label="Lost" />}
              </div>
              {/* A tier is a lifetime-revenue badge. On someone who has never
                  bought, it always reads "Bronze" — a zero dressed up as a
                  standing. Prospects get where they came from instead, which
                  is the fact that actually exists about them. */}
              {isProspects ? (
                <>
                  <div className="text-xs text-ink-secondary">{c.source || '—'}</div>
                  <div className="text-xs text-ink-secondary">{fmtDate(c.created_at)}</div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-sm font-medium text-ink-primary">{fmtMoney(c.lifetime_value ?? c.ca_lifetime)}</div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full mt-0.5 ${tierCfg.color}`}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tierCfg.dot }} />
                      {tierCfg.label}
                    </span>
                  </div>
                  <div>
                    <div className="text-xs text-ink-primary">{fmtDate(c.last_purchase_at || c.last_purchase_date)}</div>
                    {mo != null && <div className="text-[11px] text-ink-secondary">{mo === 0 ? 'this month' : `${mo} mo ago`}</div>}
                  </div>
                </>
              )}
              {timingCfg ? (
                <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${timingCfg.color}`}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: timingCfg.dot }} />
                  {timingCfg.label}
                </span>
              ) : (
                <span className="text-ink-secondary text-xs">—</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
