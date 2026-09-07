// L'onglet Contenu : où vivent les carousels Instagram de SLY.
//
// Le travail arrive déjà écrit — la routine programmée pousse le texte, la
// structure et les prompts d'image trois fois par semaine. Ce qui reste à
// faire tient en trois gestes : copier le prompt dans Higgsfield, déposer
// l'image, télécharger les visuels composés. L'écran est construit autour de
// ces trois gestes, pas autour des données.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { imageUrl, downloadAllSlides, downloadSlide } from '../slideRender.js';

const STATUS = {
  to_illustrate: { label: 'À illustrer', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  ready:         { label: 'Prêt',        tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  published:     { label: 'Publié',      tone: 'bg-gray-100 text-ink-secondary border-line' },
  archived:      { label: 'Archivé',     tone: 'bg-gray-50 text-ink-secondary border-line' },
};

const fmtDate = (d) => (d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
  : '—');

function useCopy(notify) {
  return async (text, what = 'Copié') => {
    try {
      await navigator.clipboard.writeText(text || '');
      notify?.(what);
    } catch {
      notify?.('Copie impossible — sélectionne le texte à la main', 'error');
    }
  };
}

export default function Content({ notify }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('to_illustrate');
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => api.contentOverview()
    .then((r) => {
      setData(r);
      setOpenId((id) => (r.posts.some((p) => p.id === id) ? id : null));
    })
    .catch(() => notify?.('Erreur de chargement', 'error'))
    .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const pillarColor = useMemo(() => {
    const m = {};
    (data?.pillars || []).forEach((p) => { m[p.key] = p.color; });
    return m;
  }, [data]);
  const pillarLabel = useMemo(() => {
    const m = {};
    (data?.pillars || []).forEach((p) => { m[p.key] = p.label; });
    return m;
  }, [data]);

  if (loading) return <div className="text-ink-secondary py-16 text-center text-sm">Chargement…</div>;
  if (!data) return null;

  const posts = tab === 'all'
    ? data.posts.filter((p) => p.status !== 'archived')
    : data.posts.filter((p) => p.status === tab);
  const open = data.posts.find((p) => p.id === openId) || null;

  const TABS = [
    ['to_illustrate', `À illustrer (${data.counts.to_illustrate})`],
    ['ready', `Prêt à publier (${data.counts.ready})`],
    ['published', `Publié (${data.counts.published})`],
    ['all', 'Tout'],
    ['topics', `Banque de sujets (${data.counts.topicsLeft})`],
  ];

  return (
    <div className="space-y-4">
      <Header counts={data.counts} />

      <div className="flex flex-wrap gap-1.5">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => { setTab(id); setOpenId(null); }}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              tab === id ? 'bg-accent text-white' : 'text-ink-secondary hover:text-ink-primary border border-line'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'topics' ? (
        <TopicBank data={data} pillarLabel={pillarLabel} reload={load} notify={notify} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 items-start">
          <div className="space-y-2">
            {posts.length === 0 && (
              <div className="af-card text-sm text-ink-secondary">
                Rien ici pour l'instant. La routine publie un carousel lundi, mercredi et vendredi matin.
              </div>
            )}
            {posts.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenId(p.id)}
                className={`w-full text-left bg-surface border rounded-xl p-3.5 transition-colors ${
                  p.id === openId ? 'border-accent' : 'border-line hover:border-ink-secondary'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: pillarColor[p.pillar] || '#7A6B58' }}
                  />
                  <span className="text-[10px] uppercase tracking-[0.08em] text-ink-secondary truncate">
                    {pillarLabel[p.pillar] || p.pillar}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-secondary shrink-0">{fmtDate(p.publish_date)}</span>
                </div>
                <div className="text-sm font-medium leading-snug">{p.title}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`af-badge border ${STATUS[p.status]?.tone}`}>{STATUS[p.status]?.label}</span>
                  <span className="text-[11px] text-ink-secondary">
                    {p.slides.filter((s) => s.image).length}/{p.slides.length} visuels
                  </span>
                </div>
              </button>
            ))}
          </div>

          {open
            ? <PostDetail
                key={open.id}
                post={open}
                pillars={data.pillars}
                pillarColor={pillarColor[open.pillar] || '#5A1F24'}
                reload={load}
                notify={notify}
              />
            : <div className="af-card text-sm text-ink-secondary">Sélectionne un carousel à gauche.</div>}
        </div>
      )}
    </div>
  );
}

function Header({ counts }) {
  const low = counts.topicsLeft < 12;
  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="text-[11px] font-medium text-ink-secondary uppercase tracking-[0.08em] mb-2">
        Contenu Instagram
      </div>
      <p className="text-sm text-ink-secondary max-w-3xl leading-relaxed">
        Trois carousels par semaine, écrits automatiquement le lundi, le mercredi et le vendredi
        matin à partir de la banque de sujets. Pour chaque slide : copie le prompt, génère l'image
        dans Higgsfield, dépose-la ici. Le texte est ajouté par le CRM à l'export — jamais par le
        générateur d'image, qui écrirait faux.
      </p>
      {low && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mt-3">
          Il ne reste que {counts.topicsLeft} sujets dans la banque. La routine en ajoutera
          automatiquement au prochain passage, mais tu peux en écrire toi-même dans l'onglet
          « Banque de sujets ».
        </p>
      )}
    </div>
  );
}

// —— Le carousel ouvert ————————————————————————————————————————————

function PostDetail({ post, pillars, pillarColor, reload, notify }) {
  const copy = useCopy(notify);
  const [draft, setDraft] = useState(post);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(post);

  useEffect(() => { setDraft(post); }, [post.id, post.updated_at]);

  const setSlide = (i, patch) => setDraft((d) => ({
    ...d,
    slides: d.slides.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
  }));

  async function save(extra = {}) {
    setSaving(true);
    try {
      await api.updatePost(post.id, {
        title: draft.title,
        pillar: draft.pillar,
        publishDate: draft.publish_date,
        caption: draft.caption,
        hashtags: draft.hashtags,
        notes: draft.notes,
        slides: draft.slides,
        ...extra,
      });
      await reload();
      notify?.('Enregistré');
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setSaving(false); }
  }

  async function setStatus(status) {
    setSaving(true);
    try {
      await api.updatePost(post.id, { status });
      await reload();
      notify?.(status === 'published' ? 'Marqué publié' : 'Statut mis à jour');
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!window.confirm(`Supprimer « ${post.title} » ? Le sujet retournera dans la banque.`)) return;
    try {
      await api.deletePost(post.id);
      await reload();
      notify?.('Carousel supprimé');
    } catch (e) { notify?.(e.message, 'error'); }
  }

  async function exportAll() {
    setBusy(true);
    try {
      await downloadAllSlides(post, pillarColor);
      notify?.(`${post.slides.length} visuels téléchargés`);
    } catch (e) { notify?.(`Export impossible : ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  const missing = post.slides.filter((s) => !s.image).length;
  const fullCaption = [draft.caption, draft.hashtags].filter(Boolean).join('\n\n');

  return (
    <div className="space-y-3">
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="w-full text-lg font-medium bg-transparent outline-none border-b border-transparent focus:border-line pb-1"
            />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <select
                value={draft.pillar || ''}
                onChange={(e) => setDraft({ ...draft, pillar: e.target.value })}
                className="af-select w-auto py-1 text-[13px]"
              >
                {pillars.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <input
                type="date"
                value={draft.publish_date || ''}
                onChange={(e) => setDraft({ ...draft, publish_date: e.target.value })}
                className="af-input w-auto py-1 text-[13px]"
              />
              <span className={`af-badge border ${STATUS[post.status]?.tone}`}>{STATUS[post.status]?.label}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button className="af-btn-primary" disabled={busy} onClick={exportAll}>
            {busy ? 'Export…' : `Télécharger les ${post.slides.length} visuels`}
          </button>
          <button className="af-btn-secondary" onClick={() => copy(fullCaption, 'Légende copiée')}>
            Copier la légende
          </button>
          {post.status !== 'published'
            ? <button className="af-btn-secondary" onClick={() => setStatus('published')}>Marquer publié</button>
            : <button className="af-btn-secondary" onClick={() => setStatus('ready')}>Repasser en « prêt »</button>}
          {dirty && (
            <button className="af-btn-primary" disabled={saving} onClick={() => save()}>
              {saving ? 'Enregistrement…' : 'Enregistrer les modifications'}
            </button>
          )}
          <button className="af-btn-secondary ml-auto text-red-700" onClick={remove}>Supprimer</button>
        </div>

        {missing > 0 && (
          <p className="text-[13px] text-ink-secondary mt-3">
            {missing} visuel{missing > 1 ? 's' : ''} manquant{missing > 1 ? 's' : ''} — les slides sans
            image s'exportent quand même, sur fond ivoire.
          </p>
        )}
        {draft.notes && (
          <p className="text-[13px] text-ink-secondary mt-3 whitespace-pre-wrap border-t border-line pt-3">
            {draft.notes}
          </p>
        )}
      </div>

      {draft.slides.map((slide, i) => (
        <SlideCard
          key={i}
          post={post}
          slide={slide}
          index={i + 1}
          total={draft.slides.length}
          pillarColor={pillarColor}
          onChange={(patch) => setSlide(i, patch)}
          reload={reload}
          notify={notify}
          copy={copy}
        />
      ))}

      <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
        <div className="af-label">Légende</div>
        <textarea
          value={draft.caption || ''}
          onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
          rows={7}
          className="af-input font-normal leading-relaxed"
        />
        <div className="af-label">Hashtags</div>
        <textarea
          value={draft.hashtags || ''}
          onChange={(e) => setDraft({ ...draft, hashtags: e.target.value })}
          rows={2}
          className="af-input"
        />
        {dirty && (
          <button className="af-btn-primary" disabled={saving} onClick={() => save()}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        )}
      </div>
    </div>
  );
}

function SlideCard({ post, slide, index, total, pillarColor, onChange, reload, notify, copy }) {
  const [uploading, setUploading] = useState(false);
  const inputId = `slide-img-${post.id}-${index}`;

  async function upload(file) {
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadSlideImage(post.id, index, file);
      await reload();
      notify?.(`Visuel ${index} déposé`);
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setUploading(false); }
  }

  async function removeImage() {
    try {
      await api.deleteSlideImage(post.id, index);
      await reload();
    } catch (e) { notify?.(e.message, 'error'); }
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex gap-4">
        <label
          htmlFor={inputId}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]); }}
          className="w-[104px] h-[130px] shrink-0 rounded-lg border border-dashed border-line overflow-hidden
                     flex items-center justify-center text-center cursor-pointer bg-[#FAF7F2] hover:border-accent"
        >
          {slide.image
            ? <img src={imageUrl(slide.image)} alt="" className="w-full h-full object-cover" />
            : <span className="text-[10px] text-ink-secondary px-2 leading-tight">
                {uploading ? 'Envoi…' : 'Déposer\nl\'image'}
              </span>}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
        />

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium tabular-nums text-ink-secondary">
              {String(index).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </span>
            <input
              value={slide.kicker || ''}
              onChange={(e) => onChange({ kicker: e.target.value })}
              placeholder="sur-titre"
              className="text-[11px] uppercase tracking-[0.08em] bg-transparent outline-none text-ink-secondary
                         border-b border-transparent focus:border-line flex-1 min-w-0"
            />
            <div className="ml-auto flex gap-1.5 shrink-0">
              {slide.image && (
                <button className="text-[11px] text-ink-secondary hover:text-red-700" onClick={removeImage}>
                  retirer
                </button>
              )}
              <button
                className="text-[11px] text-ink-secondary hover:text-ink-primary"
                onClick={() => downloadSlide(post, slide, { index, total, pillarColor })}
              >
                télécharger
              </button>
            </div>
          </div>

          <textarea
            value={slide.headline || ''}
            onChange={(e) => onChange({ headline: e.target.value })}
            rows={2}
            placeholder="Titre de la slide"
            className="w-full bg-transparent outline-none resize-none text-[15px] font-medium leading-snug
                       border-b border-transparent focus:border-line"
          />
          <textarea
            value={slide.body || ''}
            onChange={(e) => onChange({ body: e.target.value })}
            rows={2}
            placeholder="Texte de la slide"
            className="w-full bg-transparent outline-none resize-none text-[13px] text-ink-secondary leading-relaxed
                       border-b border-transparent focus:border-line"
          />

          <div className="bg-[#FAF9F6] border border-line rounded-md p-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-[0.08em] text-ink-secondary">Prompt Higgsfield</span>
              <button
                className="ml-auto text-[11px] text-ink-secondary hover:text-ink-primary"
                onClick={() => copy(slide.imagePrompt, `Prompt ${index} copié`)}
              >
                copier
              </button>
            </div>
            <textarea
              value={slide.imagePrompt || ''}
              onChange={(e) => onChange({ imagePrompt: e.target.value })}
              rows={3}
              className="w-full bg-transparent outline-none resize-none text-[12px] font-mono leading-relaxed text-ink-secondary"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// —— La banque de sujets ————————————————————————————————————————————

function TopicBank({ data, pillarLabel, reload, notify }) {
  const [draft, setDraft] = useState({ pillar: 'anatomie', title: '', angle: '' });
  const [adding, setAdding] = useState(false);
  const idle = data.topics.filter((t) => t.status === 'idle');
  const used = data.topics.filter((t) => t.status !== 'idle');

  async function add() {
    if (!draft.title.trim()) return;
    setAdding(true);
    try {
      await api.createTopic(draft);
      setDraft({ ...draft, title: '', angle: '' });
      await reload();
      notify?.('Sujet ajouté');
    } catch (e) { notify?.(e.message, 'error'); }
    finally { setAdding(false); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="af-label">Ajouter un sujet</div>
        <div className="flex flex-wrap gap-2 items-end">
          <select
            value={draft.pillar}
            onChange={(e) => setDraft({ ...draft, pillar: e.target.value })}
            className="af-select w-auto"
          >
            {data.pillars.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Titre du sujet"
            className="af-input flex-1 min-w-[220px]"
          />
          <input
            value={draft.angle}
            onChange={(e) => setDraft({ ...draft, angle: e.target.value })}
            placeholder="L'angle, en une phrase"
            className="af-input flex-1 min-w-[260px]"
          />
          <button className="af-btn-primary" disabled={adding} onClick={add}>Ajouter</button>
        </div>
        <p className="text-[13px] text-ink-secondary mt-3">
          La routine pioche le sujet suivant en tournant entre les piliers, pour ne pas publier trois
          fois le même registre d'affilée. Un sujet déjà traité ne peut pas ressortir.
        </p>
      </div>

      <TopicTable title={`À traiter — ${idle.length}`} rows={idle} pillarLabel={pillarLabel} reload={reload} notify={notify} />
      <TopicTable title={`Déjà traités — ${used.length}`} rows={used} pillarLabel={pillarLabel} reload={reload} notify={notify} muted />
    </div>
  );
}

function TopicTable({ title, rows, pillarLabel, reload, notify, muted }) {
  if (!rows.length) return null;
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-line text-[11px] uppercase tracking-[0.06em] text-ink-secondary">
        {title}
      </div>
      <div className="divide-y divide-line">
        {rows.map((t) => (
          <div key={t.id} className={`px-4 py-2.5 flex items-start gap-3 ${muted ? 'opacity-60' : ''}`}>
            <span className="text-[10px] uppercase tracking-[0.06em] text-ink-secondary w-40 shrink-0 pt-0.5">
              {pillarLabel[t.pillar] || t.pillar}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm">{t.title}</div>
              {t.angle && <div className="text-[13px] text-ink-secondary">{t.angle}</div>}
            </div>
            {!muted && (
              <button
                className="text-[11px] text-ink-secondary hover:text-red-700 shrink-0"
                onClick={async () => {
                  await api.deleteTopic(t.id);
                  await reload();
                  notify?.('Sujet retiré');
                }}
              >
                retirer
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
