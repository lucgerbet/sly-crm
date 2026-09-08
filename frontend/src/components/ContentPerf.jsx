// Les performances du contenu publié.
//
// L'écran est construit autour d'une conviction : le chiffre brut d'un post ne
// sert à rien. Ce qui sert, c'est de savoir quel PILIER et quel FORMAT
// marchent — croisement qu'aucune plateforme ne peut faire, puisqu'aucune ne
// connaît ta ligne éditoriale. D'où l'ordre : ce qu'il y a à relever
// aujourd'hui, puis ce que les relevés disent, puis le détail.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const PLATFORM_LABEL = {
  instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', linkedin: 'LinkedIn',
};
const FORMATS = [
  ['carousel', 'Carousel'], ['reel', 'Reel / vidéo'], ['photo', 'Photo'], ['texte', 'Texte'],
];
const CHECKPOINT_LABEL = { j3: 'J+3', j30: 'J+30' };

// Chaque plateforme ne rend pas les mêmes chiffres. Les champs restent tous
// affichés — laisser vide veut dire « pas mesurable ici », ce qui n'est pas
// zéro et ne doit jamais compter comme zéro dans une moyenne.
const FIELDS = [
  ['views', 'Vues'],
  ['reach', 'Comptes touchés'],
  ['likes', "J'aime"],
  ['comments', 'Commentaires'],
  ['shares', 'Partages'],
  ['saves', 'Enregistrements'],
  ['follows', 'Abonnés gagnés'],
  ['link_clicks', 'Clics sur le lien'],
];

const fmtNum = (n) => (n == null ? '—' : n.toLocaleString('fr-FR'));
const fmtRate = (r) => (r == null ? '—' : `${r.toFixed(1).replace('.', ',')} %`);
const fmtDate = (d) => (d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' })
  : '—');

export default function ContentPerf({ pillarLabel, notify }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { publicationId, checkpoint }
  const [adding, setAdding] = useState(false);

  const load = () => api.contentPerformance()
    .then(setData)
    .catch(() => notify?.('Erreur de chargement', 'error'))
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Chargement…</div>;
  if (!data) return null;

  const { publications, due, stats } = data;

  return (
    <div className="space-y-4">
      <Intro measured={stats.measured} total={publications.length} />

      {due.length > 0 && (
        <div className="bg-surface border border-amber-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-200 bg-amber-50 text-[11px] uppercase tracking-[0.06em] text-amber-900">
            À relever aujourd'hui — {due.length}
          </div>
          <div className="divide-y divide-line">
            {due.map((d) => (
              <div key={`${d.publicationId}-${d.checkpoint}`} className="px-4 py-2.5 flex items-center gap-3">
                <span className="af-badge border border-line bg-gray-50 text-ink-secondary shrink-0">
                  {CHECKPOINT_LABEL[d.checkpoint]}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{d.title}</div>
                  <div className="text-[12px] text-ink-secondary">
                    {PLATFORM_LABEL[d.platform]} · publié le {fmtDate(d.publishedAt)}
                  </div>
                </div>
                <button
                  className="af-btn-primary shrink-0"
                  onClick={() => setEditing({ publicationId: d.publicationId, checkpoint: d.checkpoint })}
                >
                  Saisir
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <MetricForm
          publication={publications.find((p) => p.id === editing.publicationId)}
          checkpoint={editing.checkpoint}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); notify?.('Relevé enregistré'); }}
          notify={notify}
        />
      )}

      {stats.measured > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <StatTable title="Par pilier" rows={stats.byPillar} label={(k) => pillarLabel[k] || k} />
          <StatTable title="Par plateforme" rows={stats.byPlatform} label={(k) => PLATFORM_LABEL[k] || k} />
          <StatTable title="Par format" rows={stats.byFormat} label={(k) => FORMATS.find((f) => f[0] === k)?.[1] || k} />
          <StatTable title="Par jour de publication" rows={stats.byWeekday} label={(k) => k} />
        </div>
      )}

      <PublicationTable
        publications={publications}
        pillarLabel={pillarLabel}
        onEdit={(publicationId, checkpoint) => setEditing({ publicationId, checkpoint })}
        reload={load}
        notify={notify}
      />

      {adding
        ? <AddPublication
            platforms={data.platforms}
            onClose={() => setAdding(false)}
            onSaved={async () => { setAdding(false); await load(); notify?.('Publication ajoutée'); }}
            notify={notify}
          />
        : <button className="af-btn-secondary" onClick={() => setAdding(true)}>
            + Ajouter une publication faite hors du CRM
          </button>}
    </div>
  );
}

function Intro({ measured, total }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-2">
        Performances
      </div>
      <p className="text-sm text-ink-secondary max-w-3xl leading-relaxed">
        Chaque publication se mesure deux fois : à <strong className="text-ink-primary">J+3</strong>,
        quand la portée initiale est jouée, et à <strong className="text-ink-primary">J+30</strong>,
        qui révèle ce que la recommandation a continué de servir. Comparer un post d'hier à un post
        de trois mois n'apprendrait rien — c'est pourquoi les moyennes ci-dessous ne portent que
        sur les relevés J+3.
      </p>
      {total === 0 ? (
        <p className="text-[13px] text-ink-secondary mt-3 border-t border-line pt-3">
          Rien de publié pour l'instant. Quand tu publieras un carousel, marque-le « publié » dans
          l'onglet Contenu : il apparaîtra ici, et te réclamera ses chiffres trois jours plus tard.
        </p>
      ) : measured < 15 && (
        <p className="text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mt-3">
          {measured} publication{measured > 1 ? 's' : ''} mesurée{measured > 1 ? 's' : ''}. En dessous
          d'une quinzaine, les moyennes par pilier bougent à chaque nouveau post — regarde-les, mais
          ne réoriente pas encore ta ligne éditoriale dessus.
        </p>
      )}
    </div>
  );
}

function StatTable({ title, rows, label }) {
  if (!rows.length) return null;
  const best = rows[0];
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-line text-[11px] uppercase tracking-[0.06em] text-ink-secondary">
        {title}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary border-b border-line">
            <th className="text-left font-medium px-4 py-2"></th>
            <th className="text-right font-medium px-2 py-2">Posts</th>
            <th className="text-right font-medium px-2 py-2">Vues moy.</th>
            <th className="text-right font-medium px-4 py-2">Engagement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            // Moins de 3 relevés : la moyenne est affichée mais estompée, parce
            // qu'à ce stade c'est une anecdote, pas une tendance.
            <tr key={r.key} className={`border-b border-line last:border-0 ${r.n < 3 ? 'opacity-50' : ''}`}>
              <td className="px-4 py-2">
                {label(r.key)}
                {r === best && r.n >= 3 && <span className="text-[10px] text-emerald-700 ml-2">meilleur</span>}
              </td>
              <td className="text-right px-2 py-2 tabular-nums text-ink-secondary">{r.n}</td>
              <td className="text-right px-2 py-2 tabular-nums">{fmtNum(r.avgViews)}</td>
              <td className="text-right px-4 py-2 tabular-nums">{fmtRate(r.avgEngagementRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PublicationTable({ publications, pillarLabel, onEdit, reload, notify }) {
  if (!publications.length) return null;
  return (
    <div className="bg-surface border border-line rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] text-ink-secondary uppercase tracking-[0.06em]">
            <th className="text-left font-medium px-4 py-3">Publication</th>
            <th className="text-left font-medium px-2 py-3">Plateforme</th>
            <th className="text-left font-medium px-2 py-3">Publié</th>
            <th className="text-right font-medium px-2 py-3">Vues J+3</th>
            <th className="text-right font-medium px-2 py-3">Engagement</th>
            <th className="text-right font-medium px-2 py-3">Vues J+30</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {publications.map((p) => (
            <tr key={p.id} className="border-b border-line last:border-0">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  {p.url
                    ? <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">{p.title}</a>
                    : <span>{p.title}</span>}
                </div>
                <div className="text-[11px] uppercase tracking-[0.06em] text-ink-secondary">
                  {pillarLabel[p.pillar] || p.pillar || '—'}
                </div>
              </td>
              <td className="px-2 py-2.5 text-ink-secondary">{PLATFORM_LABEL[p.platform] || p.platform}</td>
              <td className="px-2 py-2.5 text-ink-secondary whitespace-nowrap">{fmtDate(p.published_at)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">
                {fmtNum(p.metrics.j3?.views ?? p.metrics.j3?.reach)}
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">{fmtRate(p.derived.j3.engagementRate)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-ink-secondary">
                {fmtNum(p.metrics.j30?.views ?? p.metrics.j30?.reach)}
              </td>
              <td className="px-4 py-2.5 text-right whitespace-nowrap">
                <button className="text-[11px] text-ink-secondary hover:text-ink-primary" onClick={() => onEdit(p.id, 'j3')}>J+3</button>
                <button className="text-[11px] text-ink-secondary hover:text-ink-primary ml-2" onClick={() => onEdit(p.id, 'j30')}>J+30</button>
                <button
                  className="text-[11px] text-ink-secondary hover:text-red-700 ml-2"
                  onClick={async () => {
                    if (!window.confirm(`Supprimer le suivi de « ${p.title} » sur ${PLATFORM_LABEL[p.platform]} ?`)) return;
                    await api.deletePublication(p.id);
                    await reload();
                    notify?.('Suivi supprimé');
                  }}
                >
                  suppr.
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricForm({ publication, checkpoint, onClose, onSaved, notify }) {
  const existing = publication?.metrics?.[checkpoint];
  const [values, setValues] = useState(() => {
    const v = {};
    FIELDS.forEach(([k]) => { v[k] = existing?.[k] ?? ''; });
    return v;
  });
  const [saving, setSaving] = useState(false);
  if (!publication) return null;

  async function save() {
    setSaving(true);
    try {
      await api.saveMetrics(publication.id, checkpoint, values);
      await onSaved();
    } catch (e) { notify?.(e.message, 'error'); setSaving(false); }
  }

  return (
    <div className="bg-surface border border-accent rounded-xl p-5">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-medium">{publication.title}</span>
        <span className="text-[13px] text-ink-secondary">
          {PLATFORM_LABEL[publication.platform]} · relevé {CHECKPOINT_LABEL[checkpoint]}
        </span>
      </div>
      <p className="text-[13px] text-ink-secondary mb-4">
        Laisse vide tout chiffre que la plateforme ne donne pas — un champ vide est traité comme
        « non mesurable », jamais comme un zéro.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="block">
            <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary block mb-1">{label}</span>
            <input
              type="number"
              min="0"
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              className="af-input tabular-nums"
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2 mt-4">
        <button className="af-btn-primary" disabled={saving} onClick={save}>
          {saving ? 'Enregistrement…' : 'Enregistrer le relevé'}
        </button>
        <button className="af-btn-secondary" onClick={onClose}>Annuler</button>
      </div>
    </div>
  );
}

function AddPublication({ platforms, onClose, onSaved, notify }) {
  const [draft, setDraft] = useState({
    title: '', platforms: [], format: 'reel', publishedAt: new Date().toISOString().slice(0, 10), url: '',
  });
  const [saving, setSaving] = useState(false);

  const toggle = (p) => setDraft((d) => ({
    ...d,
    platforms: d.platforms.includes(p) ? d.platforms.filter((x) => x !== p) : [...d.platforms, p],
  }));

  async function save() {
    if (!draft.title.trim() || !draft.platforms.length) {
      notify?.('Titre et au moins une plateforme', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.createPublication(draft);
      await onSaved();
    } catch (e) { notify?.(e.message, 'error'); setSaving(false); }
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
      <div className="af-label">Publication faite hors du CRM</div>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="block flex-1 min-w-[220px]">
          <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary block mb-1">Titre</span>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="af-input" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary block mb-1">Format</span>
          <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })} className="af-select w-auto">
            {FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary block mb-1">Publié le</span>
          <input type="date" value={draft.publishedAt} onChange={(e) => setDraft({ ...draft, publishedAt: e.target.value })} className="af-input w-auto" />
        </label>
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary block mb-1">Lien (optionnel)</span>
          <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} className="af-input" />
        </label>
      </div>
      <PlatformPicker platforms={platforms} selected={draft.platforms} onToggle={toggle} />
      <div className="flex gap-2">
        <button className="af-btn-primary" disabled={saving} onClick={save}>Ajouter</button>
        <button className="af-btn-secondary" onClick={onClose}>Annuler</button>
      </div>
    </div>
  );
}

// Partagé avec l'onglet Contenu, qui s'en sert au moment de marquer un
// carousel publié : même contenu, une ligne de suivi par plateforme.
export function PlatformPicker({ platforms, selected, onToggle }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {platforms.map((p) => (
        <button
          key={p}
          onClick={() => onToggle(p)}
          className={`px-2.5 py-1 rounded-md text-[13px] border transition-colors ${
            selected.includes(p)
              ? 'bg-accent text-white border-accent'
              : 'border-line text-ink-secondary hover:text-ink-primary'
          }`}
        >
          {PLATFORM_LABEL[p]}
        </button>
      ))}
    </div>
  );
}
