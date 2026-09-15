// The invoice library. Every invoice the CRM has issued, filtered by month,
// with the one button the accountant actually needs: the month's bundle.
//
// Nothing here creates or edits an invoice. They are issued by the payment
// webhooks the moment money lands, and a document that can be changed after
// the fact is not an invoice.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../labels.js';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const eur = (cents) => `${((cents || 0) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} €`;

export default function Invoices({ notify }) {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState(null);   // { year, month } or null = all
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.invoices({ ...(period || {}), q: q || undefined })
      .then(setData)
      .catch(() => notify?.('Erreur de chargement des factures', 'error'))
      .finally(() => setLoading(false));
  }, [period?.year, period?.month, q]);

  const legal = data?.legal;
  const months = data?.months || [];

  return (
    <div className="space-y-4">
      {/* The gate, made visible. An invoice with a missing SIRET is refused
          server-side; this is where Luc learns why nothing is being issued. */}
      {legal && !legal.ready && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA' }}>
          <strong>Aucune facture ne peut être émise</strong> — identité vendeur incomplète dans les réglages :{' '}
          {legal.missing.join(', ')}. Les paiements sont bien enregistrés, les factures seront émises dès que c'est renseigné.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setPeriod(null)}
          className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
            !period ? 'bg-ink-primary text-white border-ink-primary' : 'border-line text-ink-secondary hover:text-ink-primary'
          }`}
        >
          Toutes
        </button>
        {months.map(m => {
          const active = period?.year === m.year && period?.month === m.month;
          return (
            <button
              key={`${m.year}-${m.month}`}
              onClick={() => setPeriod({ year: m.year, month: m.month })}
              className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                active ? 'bg-ink-primary text-white border-ink-primary' : 'border-line text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {MONTHS[Number(m.month) - 1]} {m.year} <span className="opacity-60">· {m.n}</span>
            </button>
          );
        })}
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="N° facture, client, commande…"
          className="ml-auto border border-line rounded-md px-3 py-1.5 text-sm bg-surface outline-none focus:border-accent w-56"
        />
      </div>

      {/* The accountant's hand-off: every PDF of the month plus a CSV ledger,
          in one file. Offered only once a month is selected — "export
          everything" is how a bookkeeper ends up with duplicates. */}
      {period && (
        <div className="bg-surface border border-line rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="text-sm">
            <span className="font-medium">{MONTHS[Number(period.month) - 1]} {period.year}</span>
            <span className="text-ink-secondary"> · {data?.data.length || 0} facture{(data?.data.length || 0) > 1 ? 's' : ''} · {eur(data?.totalCents)} net facturé</span>
          </div>
          <a
            href={`/api/invoices/export?year=${period.year}&month=${period.month}`}
            className="bg-accent text-white text-sm font-medium px-4 py-1.5 rounded-md hover:bg-accent/90 whitespace-nowrap"
          >
            Exporter le mois (ZIP : PDF + grand-livre CSV)
          </a>
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="grid grid-cols-[150px_90px_1fr_140px_120px_110px] border-b border-line px-4 py-2.5 bg-bg text-[11px] font-medium text-ink-secondary">
          <span>Numéro</span>
          <span>Type</span>
          <span>Client · commande</span>
          <span>Émise le</span>
          <span className="text-right">Net facturé</span>
          <span></span>
        </div>

        {loading && <div className="px-4 py-10 text-center text-sm text-ink-secondary">Chargement…</div>}
        {!loading && !data?.data.length && (
          <div className="px-4 py-10 text-center text-sm text-ink-secondary">
            {q || period
              ? 'Aucune facture ne correspond.'
              : 'Aucune facture encore — la première sera émise au prochain acompte encaissé.'}
          </div>
        )}
        {!loading && data?.data.map(inv => (
          <div key={inv.id} className="grid grid-cols-[150px_90px_1fr_140px_120px_110px] border-b border-line last:border-0 px-4 py-3 items-center">
            <span className="text-sm font-medium tabular-nums">{inv.number}</span>
            <span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                inv.kind === 'deposit' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'
              }`}>
                {inv.kind_label}
              </span>
            </span>
            <span className="min-w-0">
              <div className="text-sm truncate">{inv.client?.name || '—'}</div>
              <div className="text-[11px] text-ink-secondary truncate">{inv.order_number}{inv.client?.email ? ` · ${inv.client.email}` : ''}</div>
            </span>
            <span className="text-xs text-ink-secondary">{fmtDate(inv.issued_at)}</span>
            <span className="text-sm font-medium tabular-nums text-right">{eur(inv.due_cents)}</span>
            <span className="text-right">
              <a
                href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"
                className="text-[11px] border border-line px-2.5 py-1 rounded-md hover:bg-bg text-ink-secondary hover:text-ink-primary"
              >
                PDF ↗
              </a>
            </span>
          </div>
        ))}
      </div>

      <div className="text-[11px] text-ink-secondary px-1">
        Les factures sont émises automatiquement à chaque encaissement Stripe — une d'acompte, puis une de solde —
        et ne sont jamais modifiées ensuite. Numérotation continue par année.
      </div>
    </div>
  );
}
