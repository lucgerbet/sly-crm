// The catalogue: what SLY sells, what it costs, what it earns.
//
// Costs are entered in yuan because that is what the workshop bills and what
// Luc negotiates. The euro figures next to them are computed, never typed —
// a rate typed twice is a rate that will disagree with itself.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const eur = (cents) => (cents == null ? '—' : `${(cents / 100).toFixed(2)} €`);

export default function Products({ notify }) {
  const [rows, setRows] = useState([]);
  const [rate, setRate] = useState(7.8);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ key: '', label: '' });

  const load = () => api.products()
    .then(r => { setRows(r.data); setRate(r.rate); })
    .catch(() => notify?.('Erreur de chargement', 'error'))
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function save(row, patch) {
    setSaving(row.id);
    try {
      const r = await api.updateProduct(row.id, patch);
      setRows(rs => rs.map(x => (x.id === row.id ? r.product : x)));
    } catch (e) {
      notify?.(e.message, 'error');
      load();
    } finally { setSaving(null); }
  }

  async function saveRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) { notify?.('Taux invalide', 'error'); return; }
    try {
      await api.updateSettings({ cny_per_eur: n });
      await load();
      notify?.(`Taux passé à ${n} ¥ / €`);
    } catch (e) { notify?.(e.message, 'error'); }
  }

  async function add() {
    if (!draft.key.trim() || !draft.label.trim()) return;
    setAdding(true);
    try {
      await api.createProduct({ key: draft.key, label: draft.label, sort_order: rows.length * 10 + 10 });
      setDraft({ key: '', label: '' });
      await load();
      notify?.('Produit ajouté');
    } catch (e) {
      notify?.(e.message, 'error');
    } finally { setAdding(false); }
  }

  async function remove(row) {
    if (!window.confirm(`Retirer ${row.label} du catalogue ? Les commandes passées gardent leur coût.`)) return;
    setSaving(row.id);
    try {
      await api.deleteProduct(row.id);
      await load();
      notify?.(`${row.label} retiré du catalogue`);
    } catch (e) {
      notify?.(e.message, 'error');
    } finally { setSaving(null); }
  }

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Chargement…</div>;

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-2">
              Catalogue &amp; marges
            </div>
            <p className="text-sm text-ink-secondary max-w-2xl leading-relaxed">
              Les coûts se saisissent en <strong className="text-ink-primary">yuan</strong>, la devise de l'atelier.
              Les euros à côté sont calculés au taux ci-contre — change le taux et toutes les marges
              se recalculent, sans rien ressaisir. Le <strong className="text-ink-primary">bonus</strong> est
              ce que tu reverses à la production quand le client est satisfait.
            </p>
            <p className="text-[13px] text-ink-secondary mt-2">
              Ces coûts alimentent directement la marge du dashboard et celle de chaque commande.
              Marges hors transport, taxes et frais Stripe.
            </p>
          </div>
          <label className="block shrink-0">
            <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">
              Taux ¥ / €
            </span>
            <input
              type="number" step="0.01" defaultValue={rate}
              onBlur={e => Number(e.target.value) !== rate && saveRate(e.target.value)}
              className="w-24 border border-line rounded-md px-2 py-1.5 text-sm text-right tabular-nums bg-surface outline-none focus:border-accent"
            />
          </label>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] text-ink-secondary uppercase tracking-[0.06em]">
              <th className="text-left font-medium px-4 py-3">Produit</th>
              <th className="text-right font-medium px-2 py-3">Prix €</th>
              <th className="text-right font-medium px-2 py-3">Coût ¥</th>
              <th className="text-right font-medium px-2 py-3">Bonus ¥</th>
              <th className="text-right font-medium px-2 py-3">Coût €</th>
              <th className="text-right font-medium px-2 py-3">Marge sèche</th>
              <th className="text-right font-medium px-2 py-3">Marge si satisfait</th>
              <th className="text-center font-medium px-2 py-3">Sur le site</th>
              <th className="px-2 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={`border-b border-line last:border-0 ${saving === r.id ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      defaultValue={r.label}
                      onBlur={e => e.target.value.trim() && e.target.value !== r.label && save(r, { label: e.target.value.trim() })}
                      className="w-52 border border-transparent hover:border-line focus:border-accent rounded-md px-2 py-1 text-sm outline-none bg-transparent"
                    />
                    {r.is_pack && (
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">PACK</span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-secondary px-2">{r.key}</div>
                </td>
                <Num row={r} field="price_cents" value={r.price_cents == null ? '' : r.price_cents / 100} onSave={save} scale={100} />
                <Num row={r} field="cost_cny" value={r.cost_cny ?? ''} onSave={save} />
                <Num row={r} field="bonus_cny" value={r.bonus_cny ?? ''} onSave={save} />
                <td className="px-2 py-2 text-right tabular-nums text-ink-secondary whitespace-nowrap">
                  {eur(r.costWithBonusCents)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                  {eur(r.marginCents)}
                  <span className="text-ink-secondary text-[11px] ml-1">{r.marginPct}%</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap font-medium" style={{ color: '#1D9E75' }}>
                  {eur(r.marginWithBonusCents)}
                  <span className="text-ink-secondary text-[11px] ml-1 font-normal">{r.marginWithBonusPct}%</span>
                </td>
                <td className="px-2 py-2 text-center">
                  {/* The switch that decides whether sly-shop may offer it.
                      Packs sit here at 0 on purpose: they exist for margin
                      purposes long before they are for sale. */}
                  <input
                    type="checkbox" checked={r.on_site}
                    onChange={e => save(r, { on_site: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-2 text-right">
                  <button onClick={() => remove(r)} className="text-[11px] text-ink-secondary hover:text-red-600 px-2 py-1">
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-surface border border-line rounded-xl p-4 flex items-end gap-3">
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">Code</span>
          <input
            value={draft.key} onChange={e => setDraft(d => ({ ...d, key: e.target.value }))}
            placeholder="shirt_silk"
            className="w-40 border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium text-ink-secondary uppercase tracking-[0.06em] block mb-1">Nom</span>
          <input
            value={draft.label} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="Chemise soie"
            className="w-56 border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent"
          />
        </label>
        <button
          onClick={add} disabled={adding || !draft.key.trim() || !draft.label.trim()}
          className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 disabled:opacity-40"
        >
          Ajouter
        </button>
        <span className="text-[11px] text-ink-secondary pb-1.5">
          Le code doit correspondre à celui qu'utilise le site pour ce produit.
        </span>
      </div>
    </div>
  );
}

// Commits on blur rather than on every keystroke: these numbers drive every
// margin in the CRM, and typing "1" on the way to "1100" must not briefly
// rewrite them.
function Num({ row, field, value, onSave, scale = 1 }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  return (
    <td className="px-2 py-2 text-right">
      <input
        type="number" step="0.01" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          const now = draft.trim();
          if (now === String(value ?? '')) return;
          onSave(row, { [field]: now === '' ? '' : Number(now) * scale });
        }}
        className="w-24 border border-transparent hover:border-line focus:border-accent rounded-md px-2 py-1 text-sm text-right tabular-nums outline-none bg-transparent"
      />
    </td>
  );
}
