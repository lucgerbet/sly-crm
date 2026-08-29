// SLY's standard size chart — the table that turns a set of body measurements
// into a retail size everyone understands.
//
// Empty until Luc fills it in, and the emptiness is stated rather than hidden:
// nothing downstream (the dashboard's sales-by-size breakdown, the size shown
// on an order) can say anything until at least one row here has a range.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function SizeChart({ notify }) {
  const [rows, setRows] = useState([]);
  const [matchable, setMatchable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(null);

  const load = () => api.sizes()
    .then(r => { setRows(r.data); setMatchable(r.matchable); })
    .catch(() => notify?.('Erreur de chargement', 'error'))
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function add() {
    const label = newLabel.trim();
    if (!label) return;
    setSaving('new');
    try {
      await api.createSize({ label });
      setNewLabel('');
      await load();
      notify?.(`Taille ${label} ajoutée`);
    } catch (e) {
      notify?.(e.message, 'error');
    } finally { setSaving(null); }
  }

  async function saveRange(row, key, bound, value) {
    const ranges = { ...(parse(row.ranges_json)) };
    const current = ranges[key] || {};
    const next = { ...current, [bound]: value === '' ? null : Number(value) };
    if (next.min == null && next.max == null) delete ranges[key];
    else ranges[key] = next;

    setSaving(row.id);
    try {
      const r = await api.updateSize(row.id, { ranges });
      setRows(rs => rs.map(x => (x.id === row.id ? r.size : x)));
    } catch (e) {
      notify?.(e.message, 'error');
      load();
    } finally { setSaving(null); }
  }

  async function saveField(row, field, value) {
    setSaving(row.id);
    try {
      const r = await api.updateSize(row.id, { [field]: value });
      setRows(rs => rs.map(x => (x.id === row.id ? r.size : x)));
    } catch (e) {
      notify?.(e.message, 'error');
      load();
    } finally { setSaving(null); }
  }

  async function remove(row) {
    // A chart row silently disappearing would re-attribute every order that
    // matched it, so this asks first.
    if (!window.confirm(`Supprimer la taille ${row.label} ? Les commandes qui lui étaient associées deviendront non classées.`)) return;
    setSaving(row.id);
    try {
      await api.deleteSize(row.id);
      await load();
      notify?.(`Taille ${row.label} supprimée`);
    } catch (e) {
      notify?.(e.message, 'error');
    } finally { setSaving(null); }
  }

  const parse = (raw) => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Chargement…</div>;

  const anyRange = rows.some(r => Object.keys(parse(r.ranges_json)).length > 0);

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-2">
          Size chart standard
        </div>
        <p className="text-sm text-ink-secondary max-w-3xl leading-relaxed">
          Ton propre référentiel de tailles. Chaque ligne est une taille retail
          (48, M, 50R — le nom est le tien) et les colonnes sont les bornes de
          mensurations qui la définissent. Laisse une case vide pour que cette
          mensuration ne compte pas dans l'association.
        </p>
        <p className="text-sm text-ink-secondary max-w-3xl leading-relaxed mt-2">
          Dès qu'une ligne a au moins une borne, chaque commande est associée
          automatiquement à la taille la plus proche, et la répartition des
          ventes par taille apparaît sur le dashboard. Rien n'est figé sur les
          commandes : modifie une borne ici et tout l'historique se recalcule.
        </p>
        {!anyRange && (
          <div className="mt-3 text-[13px] rounded-md px-3 py-2" style={{ background: '#FEF6E7', color: '#8A5A00' }}>
            Chart vide — aucune commande n'est associée pour l'instant, et le
            dashboard le dit plutôt que d'inventer une répartition.
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left font-medium text-[11px] text-ink-secondary uppercase tracking-[0.06em] px-4 py-3 sticky left-0 bg-surface">
                  Taille
                </th>
                {matchable.map(m => (
                  <th key={m.key} className="text-center font-medium text-[11px] text-ink-secondary px-3 py-3 whitespace-nowrap">
                    {m.label}<span className="block text-[10px] opacity-70">min – max {m.unit}</span>
                  </th>
                ))}
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const ranges = parse(row.ranges_json);
                return (
                  <tr key={row.id} className={`border-b border-line last:border-0 ${saving === row.id ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2 sticky left-0 bg-surface">
                      <input
                        defaultValue={row.label}
                        onBlur={e => e.target.value.trim() && e.target.value !== row.label && saveField(row, 'label', e.target.value.trim())}
                        className="w-20 border border-line rounded-md px-2 py-1 text-sm font-medium outline-none focus:border-accent bg-surface"
                      />
                    </td>
                    {matchable.map(m => {
                      const r = ranges[m.key] || {};
                      return (
                        <td key={m.key} className="px-3 py-2">
                          <div className="flex items-center gap-1 justify-center">
                            <Bound value={r.min} onCommit={v => saveRange(row, m.key, 'min', v)} />
                            <span className="text-ink-secondary text-xs">–</span>
                            <Bound value={r.max} onCommit={v => saveRange(row, m.key, 'max', v)} />
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => remove(row)}
                        className="text-[11px] text-ink-secondary hover:text-red-600 px-2 py-1"
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl p-4 flex items-end gap-3">
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">
            Nouvelle taille
          </span>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="48"
            className="w-32 border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent bg-surface"
          />
        </label>
        <button
          onClick={add}
          disabled={saving === 'new' || !newLabel.trim()}
          className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40"
        >
          Ajouter
        </button>
        <span className="text-[11px] text-ink-secondary pb-1.5">
          Ajoute d'abord les tailles, remplis les bornes ensuite.
        </span>
      </div>
    </div>
  );
}

// A single bound. Commits on blur rather than on every keystroke, so typing
// "10" on the way to "100" never briefly saves a range that would re-sort every
// order in the CRM.
function Bound({ value, onCommit }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => { setDraft(value == null ? '' : String(value)); }, [value]);
  return (
    <input
      type="number"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const now = draft.trim();
        const before = value == null ? '' : String(value);
        if (now !== before) onCommit(now);
      }}
      className="w-14 border border-line rounded-md px-1.5 py-1 text-sm text-center outline-none focus:border-accent bg-surface tabular-nums"
    />
  );
}
