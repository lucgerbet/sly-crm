import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../labels.js';

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-ink-secondary mt-1">{hint}</div>}
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

// Settings store cents; nobody wants to type "16600" for 166 €. Keeps a local
// draft while typing and only converts on blur, so a half-typed "166." isn't
// reformatted out from under the cursor.
function MoneyInput({ cents, onCents, placeholder }) {
  const asEuros = cents === '' || cents == null ? '' : String(Number(cents) / 100);
  const [draft, setDraft] = useState(asEuros);
  useEffect(() => { setDraft(asEuros); }, [asEuros]);

  const commit = () => {
    const t = draft.trim();
    if (t === '') { onCents(''); return; }
    const n = Number(t);
    // Reject junk by snapping back to the saved value rather than writing a
    // cost of NaN, which would silently drop orders out of the margin.
    if (!Number.isFinite(n) || n < 0) { setDraft(asEuros); return; }
    onCents(String(Math.round(n * 100)));
  };

  return (
    <input
      type="number" min="0" step="0.01"
      value={draft}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      className="w-full border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent bg-surface"
    />
  );
}

function Textarea({ value, onChange, rows = 5 }) {
  return (
    <textarea
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      rows={rows}
      className="w-full border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent resize-none bg-surface font-mono"
    />
  );
}

export default function Automation({ notify }) {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([api.automationStatus(), api.getSettings()])
      .then(([s, set]) => { setStatus(s); setSettings(set); })
      .catch(() => notify?.('Error loading automation settings', 'error'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const set = (key) => (val) => setSettings(s => ({ ...s, [key]: val }));

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        automation_enabled: settings.automation_enabled,
        birthday_reminder_days_before: settings.birthday_reminder_days_before,
        shop_url: settings.shop_url,
        birthday_reminder_subject: settings.birthday_reminder_subject,
        birthday_reminder_body: settings.birthday_reminder_body,
        birthday_greeting_subject: settings.birthday_greeting_subject,
        birthday_greeting_body: settings.birthday_greeting_body,
        default_cost_suit_cents: settings.default_cost_suit_cents ?? '',
        default_cost_blazer_cents: settings.default_cost_blazer_cents ?? '',
        default_cost_trousers_cents: settings.default_cost_trousers_cents ?? '',
        stripe_fee_percent: settings.stripe_fee_percent ?? '',
        stripe_fee_fixed_cents: settings.stripe_fee_fixed_cents ?? '',
        redo_cost_cents: settings.redo_cost_cents ?? '',
        alteration_cost_cents: settings.alteration_cost_cents ?? '',
      };
      await api.updateSettings(payload);
      notify?.('Automation settings saved', 'success');
      load();
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestEmail() {
    if (!testEmail.trim()) return;
    setSendingTest(true);
    try {
      await api.automationTestEmail(testEmail.trim());
      notify?.(`Test email sent to ${testEmail}`, 'success');
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setSendingTest(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      const result = await api.automationRun(true);
      setPreview(result);
      if (result.skipped) notify?.(result.reason, 'error');
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setPreviewing(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    try {
      const result = await api.automationRun(false);
      if (result.skipped) {
        notify?.(result.reason, 'error');
      } else {
        const sentR = result.reminders.filter(r => r.sent).length;
        const sentG = result.greetings.filter(r => r.sent).length;
        notify?.(`Sent ${sentR} reminder(s) and ${sentG} greeting(s)`, 'success');
        load();
      }
    } catch (e) {
      notify?.(e.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  if (loading || !status || !settings) return <div className="text-ink-secondary py-16 text-center text-sm">Loading…</div>;

  return (
    <div className="space-y-5 max-w-3xl">
      {!status.emailConfigured && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3">
          Email sending isn't configured yet. Add <code className="font-mono">RESEND_API_KEY</code> (and optionally{' '}
          <code className="font-mono">EMAIL_FROM</code>) to the backend environment, then restart. Until then,
          automation stays off and no emails will be sent.
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Birthday email automation</div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!settings.automation_enabled}
              onChange={e => set('automation_enabled')(e.target.checked)}
              disabled={!status.emailConfigured}
            />
            Enabled
          </label>
        </div>
        <div className="text-xs text-ink-secondary">
          Runs automatically every day at 08:00. Each client gets a reminder email {settings.birthday_reminder_days_before || 30} days
          before their birthday, and a greeting email on the day itself — at most once per type per year, and never to
          clients who opted out.
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Days before birthday for the reminder">
            <Input type="number" value={settings.birthday_reminder_days_before} onChange={set('birthday_reminder_days_before')} />
          </Field>
          <Field label="Shop link (used in the reminder as {{shop_url}})">
            <Input value={settings.shop_url} onChange={set('shop_url')} placeholder="https://…" />
          </Field>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Reminder email (sent {settings.birthday_reminder_days_before || 30} days before)</div>
        <Field label="Subject"><Input value={settings.birthday_reminder_subject} onChange={set('birthday_reminder_subject')} /></Field>
        <Field label="Body" hint="Placeholders: {{first_name}}, {{last_name}}, {{shop_url}}. An unsubscribe link is appended automatically.">
          <Textarea value={settings.birthday_reminder_body} onChange={set('birthday_reminder_body')} />
        </Field>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Birthday-day greeting</div>
        <Field label="Subject"><Input value={settings.birthday_greeting_subject} onChange={set('birthday_greeting_subject')} /></Field>
        <Field label="Body" hint="Placeholders: {{first_name}}, {{last_name}}, {{shop_url}}. An unsubscribe link is appended automatically.">
          <Textarea value={settings.birthday_greeting_body} onChange={set('birthday_greeting_body')} />
        </Field>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Production costs &amp; payment fees</div>
        <div className="text-xs text-ink-secondary">
          What each piece costs you to make — workshop, fabric, shipping. Applied automatically to every
          settled order of that type, so you never retype it. A cost entered on an individual order overrides
          it. Leave a piece blank if you don't know its cost yet: its orders are excluded from the margin
          rather than counted as pure profit.
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Suit — cost (€)">
            <MoneyInput cents={settings.default_cost_suit_cents} onCents={set('default_cost_suit_cents')} placeholder="166" />
          </Field>
          <Field label="Blazer — cost (€)">
            <MoneyInput cents={settings.default_cost_blazer_cents} onCents={set('default_cost_blazer_cents')} placeholder="not set" />
          </Field>
          <Field label="Trousers — cost (€)">
            <MoneyInput cents={settings.default_cost_trousers_cents} onCents={set('default_cost_trousers_cents')} placeholder="not set" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Remake — cost you bear (€)" hint="Applied per remake. Deducted from the margin.">
            <MoneyInput cents={settings.redo_cost_cents} onCents={set('redo_cost_cents')} placeholder="140" />
          </Field>
          <Field label="Alteration — standard cost (€)" hint="Leave blank if unknown: alterations then count as incidents with no price, never as free.">
            <MoneyInput cents={settings.alteration_cost_cents} onCents={set('alteration_cost_cents')} placeholder="not set" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Stripe fee (%)" hint="Counted once on the order total.">
            <Input type="number" value={settings.stripe_fee_percent} onChange={set('stripe_fee_percent')} placeholder="1.5" />
          </Field>
          <Field label="Stripe fixed fee per payment (€)" hint="Charged twice per order — deposit, then balance.">
            <MoneyInput cents={settings.stripe_fee_fixed_cents} onCents={set('stripe_fee_fixed_cents')} placeholder="0.25" />
          </Field>
        </div>

        <div className="text-[11px] text-ink-secondary">
          These four figures are what the Dashboard's gross and net margin are built from — change one and both
          recompute across every settled order, including past ones.
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em]">Test</div>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Field label="Send a test email to">
              <Input value={testEmail} onChange={setTestEmail} placeholder="you@example.com" type="email" />
            </Field>
          </div>
          <button
            onClick={handleTestEmail}
            disabled={sendingTest || !status.emailConfigured || !testEmail.trim()}
            className="text-sm text-ink-secondary border border-line rounded-md px-3 py-1.5 hover:text-ink-primary disabled:opacity-40 shrink-0"
          >
            {sendingTest ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handlePreview}
            disabled={previewing}
            className="text-sm text-ink-secondary border border-line rounded-md px-3 py-1.5 hover:text-ink-primary disabled:opacity-40"
          >
            {previewing ? 'Checking…' : 'Preview who would be emailed today'}
          </button>
          <button
            onClick={handleRunNow}
            disabled={running || !status.emailConfigured}
            className="text-sm text-white bg-accent rounded-md px-3 py-1.5 hover:bg-accent/90 disabled:opacity-40"
            title={!status.emailConfigured ? 'Configure RESEND_API_KEY first' : 'Sends real emails now, ignoring the daily 08:00 schedule'}
          >
            {running ? 'Running…' : 'Run now (sends real emails)'}
          </button>
        </div>

        {preview && !preview.skipped && (
          <div className="text-xs text-ink-secondary border border-line rounded-md p-3 space-y-1">
            <div><strong>{preview.reminders.length}</strong> would get the reminder: {preview.reminders.map(r => r.client.first_name).join(', ') || '—'}</div>
            <div><strong>{preview.greetings.length}</strong> would get the greeting: {preview.greetings.map(r => r.client.first_name).join(', ') || '—'}</div>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] px-5 py-3 border-b border-line">Recent automated sends</div>
        {status.recent.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-ink-secondary">Nothing sent yet.</div>
        ) : (
          status.recent.map(r => (
            <div key={r.id} className="px-5 py-2.5 border-b border-line last:border-0 flex items-center justify-between text-sm">
              <span>{[r.first_name, r.last_name].filter(Boolean).join(' ')} — {r.type === 'birthday_reminder' ? 'reminder' : 'greeting'}</span>
              <span className="text-xs text-ink-secondary">{fmtDate(r.date)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
