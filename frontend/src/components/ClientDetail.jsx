import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  TIMING, POTENTIAL, MESSAGE_TYPES, STAGE_PREREQ, STAGE_META,
  fmtDate, initials, effectiveTiming, todayISO, todayPlusMonths, daysUntil,
} from '../labels.js';

const EMPTY = {
  first_name:'', last_name:'', phone:'', email:'', city:'', country:'', source:'', tags:'', notes:'',
  birth_date:'', email_opt_out:0,
  next_step:'', last_contacted_date:'',
  ca_lifetime:'', purchase_count:'', last_purchase_date:'', last_purchase_item:'',
  assigned_to:'', potential:'',
  target_contact_date:'', contacted:0, answered:0, appointment:0,
  appointment_date:'', appointment_time:'', appointment_location:'', won:0,
  lost:0, lost_reason:'',
};

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = 'text' }) {
  return (
    <input
      type={type}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent bg-surface"
    />
  );
}

function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent resize-none bg-surface"
    />
  );
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent bg-surface"
    >
      {children}
    </select>
  );
}

function Segmented({ options, value, onChange, activeClass = 'bg-accent text-white border-accent', sticky = false }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map(([k, label]) => {
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            onClick={() => { if (active && sticky) return; onChange(active ? '' : k); }}
            className={`text-xs font-medium px-3 py-1.5 rounded-md border transition-colors ${
              active ? activeClass : 'bg-surface border-line text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function BadgeToggle({ label, on, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(on ? 0 : 1)}
      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
        on ? 'bg-green-50 border-green-300 text-green-800' : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
      }`}
    >
      <span className={`w-2.5 h-2.5 rounded-full transition-colors ${on ? 'bg-green-500' : 'bg-gray-300'}`} />
      {label}
    </button>
  );
}

function AssigneePicker({ value, onChange, options }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function commitDraft() {
    const name = draft.trim();
    if (name) onChange(value === name ? '' : name);
    setDraft('');
    setAdding(false);
  }

  const allNames = value && !options.includes(value) ? [...options, value] : options;

  return (
    <div className="flex gap-1.5 flex-wrap items-center">
      {allNames.map(name => {
        const active = value === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(active ? '' : name)}
            className={`text-xs font-medium px-3 py-1.5 rounded-md border transition-colors ${
              active ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {name}
          </button>
        );
      })}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') { setDraft(''); setAdding(false); } }}
          onBlur={commitDraft}
          placeholder="Name…"
          className="text-xs px-3 py-1.5 rounded-md border border-line bg-surface outline-none focus:border-accent w-28"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-xs font-medium px-3 py-1.5 rounded-md border border-dashed border-line text-ink-secondary hover:text-ink-primary hover:border-accent"
        >
          + Other…
        </button>
      )}
      {value && (
        <button type="button" onClick={() => onChange('')} className="text-xs text-ink-secondary hover:text-red-500 px-1">
          Clear
        </button>
      )}
    </div>
  );
}

const HEADER_BADGES = [
  { key: 'contacted', label: 'Cont' },
  { key: 'answered', label: 'Rep' },
  { key: 'appointment', label: 'Mtg' },
  { key: 'won', label: 'Client' },
];

const TIMING_QUICK = [
  { key: 'now', label: 'Now', months: 0 },
  { key: '1month', label: '1 month', months: 1 },
  { key: '3months', label: '3 months', months: 3 },
  { key: '6months', label: '6 months', months: 6 },
];

export default function ClientDetail({ clientId, onClose, onSaved, onDeleted, onChanged, notify }) {
  const isNew = !clientId;
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [newMsg, setNewMsg] = useState({ type: 'note', content: '', date: todayISO() });
  const [addingMsg, setAddingMsg] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assignees, setAssignees] = useState([]);

  useEffect(() => {
    api.listAssignees().then(r => setAssignees(r.data)).catch(() => {});
  }, []);

  const set = (key) => (val) => setForm(f => ({ ...f, [key]: val }));

  async function quickSet(field, value) {
    if (isNew) { setForm(f => ({ ...f, [field]: value })); return; }
    const prev = form[field];
    setForm(f => ({ ...f, [field]: value }));
    try {
      const updated = await api.updateClient(clientId, { [field]: value });
      setForm(f => ({ ...f, ...updated }));
      onChanged?.();
    } catch (e) {
      setForm(f => ({ ...f, [field]: prev }));
      notify(e.message, 'error');
    }
  }

  function handleStepClick(field) {
    if (isNew) { quickSet(field, form[field] ? 0 : 1); return; }
    if (form[field]) { quickSet(field, 0); return; }
    const prereq = STAGE_PREREQ[field];
    if (prereq && !form[prereq]) {
      notify(`Complete "${STAGE_META[prereq]?.label || prereq}" first`, 'error');
      return;
    }
    quickSet(field, 1);
  }

  function setTimingQuick(months) {
    const val = months === 0 ? todayISO() : todayPlusMonths(months);
    if (isNew) { set('target_contact_date')(val); return; }
    quickSet('target_contact_date', val);
  }

  useEffect(() => {
    if (isNew) { setForm(EMPTY); setLoading(false); return; }
    setLoading(true);
    api.getClient(clientId)
      .then(data => setForm(data))
      .catch(() => notify('Error loading profile', 'error'))
      .finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    if (activeTab === 'activity' && clientId) {
      setMsgLoading(true);
      api.listMessages(clientId)
        .then(r => setMessages(r.data))
        .catch(() => notify('Error loading activity', 'error'))
        .finally(() => setMsgLoading(false));
    }
  }, [activeTab, clientId]);

  async function handleSave() {
    setSaving(true);
    try {
      const payload = { ...form };
      ['contacted','answered','appointment','won','lost'].forEach(k => { payload[k] = payload[k] ? 1 : 0; });
      if (isNew) { await api.createClient(payload); notify('Client added', 'success'); }
      else { await api.updateClient(clientId, payload); notify('Profile updated', 'success'); }
      onSaved();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try { await api.deleteClient(clientId); notify('Client deleted', 'success'); onDeleted(); }
    catch (e) { notify(e.message, 'error'); }
  }

  async function handleAddMsg() {
    if (!newMsg.content.trim()) return;
    setAddingMsg(true);
    try {
      const msg = await api.addMessage(clientId, newMsg);
      setMessages(m => [...m, msg]);
      setNewMsg({ type: 'note', content: '', date: todayISO() });
    } catch (e) { notify(e.message, 'error'); }
    finally { setAddingMsg(false); }
  }

  async function handleDeleteMsg(msgId) {
    try {
      await api.deleteMessage(clientId, msgId);
      setMessages(m => m.filter(x => x.id !== msgId));
    } catch (e) { notify(e.message, 'error'); }
  }

  const name = [form.first_name, form.last_name].filter(Boolean).join(' ') || (isNew ? 'New client' : '—');
  const ini = initials(form.first_name, form.last_name);
  const effTiming = effectiveTiming(form.target_contact_date);
  const effCfg = TIMING[effTiming];
  const dLeft = daysUntil(form.target_contact_date);

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-ink-secondary">Loading…</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line bg-bg shrink-0">
        <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-medium shrink-0">{ini}</div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-medium text-ink-primary">{name}</div>
          <div className="text-xs text-ink-secondary truncate">
            {[form.city, form.country].filter(Boolean).join(' · ') || 'New profile'}
          </div>
        </div>
        {!isNew && (
          <div className="flex gap-1 shrink-0">
            {HEADER_BADGES.map(({ key, label }) => (
              <span
                key={key}
                onClick={() => handleStepClick(key)}
                title={`Click to toggle "${label}"`}
                className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full transition-colors cursor-pointer hover:opacity-70 ${
                  form[key] ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-400'
                }`}
              >{label}</span>
            ))}
          </div>
        )}
        <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary ml-1 shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-line shrink-0 bg-surface">
        {[['profile','Profile'],['pipeline','Pipeline'],['activity','Activity']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === id ? 'border-accent text-ink-primary' : 'border-transparent text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {label}
            {id === 'activity' && messages.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">{messages.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* PROFILE */}
        {activeTab === 'profile' && (
          <div className="p-5 space-y-6">
            <div className="grid grid-cols-2 gap-5">
              <div className="space-y-3">
                <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Identity</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name"><Input value={form.first_name} onChange={set('first_name')} placeholder="First name" /></Field>
                  <Field label="Last name"><Input value={form.last_name} onChange={set('last_name')} placeholder="Last name" /></Field>
                </div>
                <Field label="Phone"><Input value={form.phone} onChange={set('phone')} placeholder="+33 …" /></Field>
                <Field label="Email"><Input value={form.email} onChange={set('email')} type="email" placeholder="email@…" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="City"><Input value={form.city} onChange={set('city')} placeholder="Paris" /></Field>
                  <Field label="Country"><Input value={form.country} onChange={set('country')} placeholder="France" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Source"><Input value={form.source} onChange={set('source')} placeholder="Instagram, referral…" /></Field>
                  <Field label="Tags"><Input value={form.tags} onChange={set('tags')} placeholder="vip, wholesale…" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3 items-end">
                  <Field label="Birthday">
                    <Input type="date" value={form.birth_date} onChange={v => (isNew ? set('birth_date')(v) : quickSet('birth_date', v))} />
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-ink-secondary pb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!form.email_opt_out}
                      onChange={e => (isNew ? set('email_opt_out')(e.target.checked ? 1 : 0) : quickSet('email_opt_out', e.target.checked ? 1 : 0))}
                    />
                    Opted out of automated emails
                  </label>
                </div>
                {form.birth_date ? (
                  <div className="text-[10px] text-ink-secondary">
                    Used for the birthday reminder + greeting emails — see the Automation tab.
                  </div>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Commercial value</div>
                <Field label="Lifetime revenue"><Input value={form.ca_lifetime} onChange={set('ca_lifetime')} type="number" placeholder="0" /></Field>
                <Field label="Number of orders"><Input value={form.purchase_count} onChange={set('purchase_count')} type="number" placeholder="0" /></Field>
                <Field label="Last purchase date"><Input value={form.last_purchase_date} onChange={set('last_purchase_date')} type="date" /></Field>
                <Field label="Last item"><Input value={form.last_purchase_item} onChange={set('last_purchase_item')} placeholder="What did they buy" /></Field>
                <div className="border-t border-line pt-3">
                  <Field label="Notes"><Textarea value={form.notes} onChange={set('notes')} placeholder="Observations…" rows={5} /></Field>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PIPELINE */}
        {activeTab === 'pipeline' && (
          <div className="p-5 space-y-6">
            <Field label="Assigned to">
              <AssigneePicker value={form.assigned_to} onChange={v => quickSet('assigned_to', v)} options={assignees} />
            </Field>

            <Field label="Potential">
              <Segmented options={Object.entries(POTENTIAL).map(([k, v]) => [k, v.label])} value={form.potential} onChange={v => quickSet('potential', v)} sticky />
            </Field>

            <div>
              <label className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1.5">When to follow up</label>
              <div className="flex gap-1.5 mb-2">
                {TIMING_QUICK.map(t => {
                  const active = effTiming === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTimingQuick(t.months)}
                      className={`flex-1 text-xs font-medium px-2 py-1.5 rounded-md border transition-colors ${
                        active ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink-secondary hover:text-ink-primary'
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <Input type="date" value={form.target_contact_date} onChange={v => quickSet('target_contact_date', v)} />
                {effCfg && (
                  <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full ${effCfg.color}`}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: effCfg.dot }} />
                    {dLeft != null && dLeft > 0 ? `in ${dLeft}d` : 'Now'}
                  </span>
                )}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-2">Pipeline progress</div>
              <div className="text-[10px] text-ink-secondary mb-2">Saved instantly.</div>
              <div className="grid grid-cols-2 gap-3">
                <BadgeToggle label="Contacted"       on={!!form.contacted}   onChange={() => handleStepClick('contacted')} />
                <BadgeToggle label="Replied"         on={!!form.answered}    onChange={() => handleStepClick('answered')} />
                <BadgeToggle label="Meeting booked"  on={!!form.appointment} onChange={() => handleStepClick('appointment')} />
                <BadgeToggle label="Became a client" on={!!form.won}         onChange={() => handleStepClick('won')} />
              </div>
            </div>

            {form.appointment ? (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Meeting date"><Input type="date" value={form.appointment_date} onChange={v => quickSet('appointment_date', v)} /></Field>
                <Field label="Meeting time"><Input type="time" value={form.appointment_time} onChange={v => quickSet('appointment_time', v)} /></Field>
                <Field label="Location"><Input value={form.appointment_location} onChange={v => quickSet('appointment_location', v)} placeholder="Where…" /></Field>
              </div>
            ) : null}

            <div className="border-t border-line pt-4 space-y-3">
              <BadgeToggle label="Lost / not interested" on={!!form.lost} onChange={() => quickSet('lost', form.lost ? 0 : 1)} />
              {!!form.lost && (
                <Field label="Reason">
                  <Input value={form.lost_reason} onChange={v => quickSet('lost_reason', v)} placeholder="Why this lead didn't convert…" />
                </Field>
              )}
            </div>
          </div>
        )}

        {/* ACTIVITY */}
        {activeTab === 'activity' && (
          <div className="p-5 space-y-4">
            <div className="border border-line rounded-lg p-4 bg-amber-50/40 space-y-3">
              <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                <Field label="Next step">
                  <Input value={form.next_step} onChange={v => quickSet('next_step', v)} placeholder="e.g. Send catalog, call Friday…" />
                </Field>
                <Field label="Last contacted">
                  <Input type="date" value={form.last_contacted_date ? String(form.last_contacted_date).slice(0,10) : ''} onChange={v => quickSet('last_contacted_date', v)} />
                </Field>
              </div>
            </div>

            <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] pt-1">Activity log</div>
            {msgLoading && <div className="text-center text-sm text-ink-secondary py-6">Loading…</div>}
            {!msgLoading && messages.length === 0 && (
              <div className="text-center text-sm text-ink-secondary py-6">No activity yet.</div>
            )}
            <div className="space-y-3">
              {messages.map(msg => {
                const cfg = MESSAGE_TYPES[msg.type] || MESSAGE_TYPES.note;
                return (
                  <div key={msg.id} className={`border rounded-lg p-4 ${cfg.color}`}>
                    <div className="flex justify-between items-start mb-2">
                      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-ink-secondary">{fmtDate(msg.date)}</span>
                        <button className="text-gray-300 hover:text-red-400 transition-colors text-xs" onClick={() => handleDeleteMsg(msg.id)} title="Delete">✕</button>
                      </div>
                    </div>
                    <p className="text-sm text-ink-primary whitespace-pre-wrap">{msg.content}</p>
                  </div>
                );
              })}
            </div>

            {!isNew && (
              <div className="border border-line rounded-lg p-4 space-y-3 bg-bg">
                <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.06em]">Add an entry</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type">
                    <Select value={newMsg.type} onChange={v => setNewMsg(m => ({ ...m, type: v }))}>
                      {Object.entries(MESSAGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Date"><Input type="date" value={newMsg.date} onChange={v => setNewMsg(m => ({ ...m, date: v }))} /></Field>
                </div>
                <Field label="Content"><Textarea value={newMsg.content} onChange={v => setNewMsg(m => ({ ...m, content: v }))} placeholder="Write a note here…" rows={4} /></Field>
                <button
                  disabled={!newMsg.content.trim() || addingMsg}
                  onClick={handleAddMsg}
                  className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40"
                >
                  {addingMsg ? 'Adding…' : '+ Add'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-line px-5 py-3 flex items-center justify-between bg-surface shrink-0">
        <div>
          {!isNew && !confirmDelete && (
            <button className="text-sm text-red-500 hover:text-red-700" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
          {!isNew && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600">Confirm?</span>
              <button className="text-sm font-medium text-red-600 hover:text-red-800" onClick={handleDelete}>Yes</button>
              <button className="text-sm text-ink-secondary" onClick={() => setConfirmDelete(false)}>No</button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button className="text-sm text-ink-secondary border border-line rounded-md px-4 py-1.5 hover:text-ink-primary" onClick={onClose}>Close</button>
          {isNew && (
            <button disabled={saving} onClick={handleSave} className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-50">
              {saving ? 'Saving…' : 'Create'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
