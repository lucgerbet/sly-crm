// Le contenu Instagram de SLY : la banque de sujets, les carousels écrits par
// la routine, et les visuels que Luc y dépose.
//
// Le partage du travail est volontaire. La routine programmée écrit (texte,
// structure, prompts d'image) et pousse ici via /intake ; Luc illustre dans
// Higgsfield et publie. Le CRM est l'endroit unique où l'on voit où en est
// chaque carousel — pas un dossier de fichiers qu'on oublie d'ouvrir.
import { Router } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import { PILLARS } from '../lib/contentSeed.js';
import { requireIntakeSecret } from '../lib/orderHelpers.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Les visuels vivent à côté de la base, donc dans le volume persistant en
// production (/data) et dans backend/ en local — un seul endroit à sauvegarder.
const IMAGES_DIR = path.resolve(
  path.dirname(
    process.env.DATABASE_PATH
      ? path.resolve(__dirname, '..', process.env.DATABASE_PATH)
      : path.resolve(__dirname, '../sly_crm.db')
  ),
  'content-images'
);
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const newId = () => randomBytes(8).toString('hex');

function parseSlides(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

const hydrate = (row) => row && ({
  ...row,
  slides: parseSlides(row.slides),
});

function touch(id) {
  db.prepare("UPDATE content_posts SET updated_at = datetime('now') WHERE id = ?").run(id);
}

// Une slide venue de l'extérieur n'est jamais recopiée telle quelle : on ne
// garde que les champs connus, et `image` reste sous le seul contrôle des
// routes d'upload (sinon un intake pourrait pointer vers un fichier arbitraire).
function sanitizeSlides(input, previous = []) {
  if (!Array.isArray(input)) return previous;
  return input.slice(0, 12).map((s, i) => ({
    n: i + 1,
    kicker: String(s?.kicker ?? '').slice(0, 60),
    headline: String(s?.headline ?? '').slice(0, 160),
    body: String(s?.body ?? '').slice(0, 400),
    imagePrompt: String(s?.imagePrompt ?? '').slice(0, 1200),
    layout: s?.layout === 'hero' ? 'hero' : 'split',
    image: previous[i]?.image ?? null,
  }));
}

// —— Lecture ————————————————————————————————————————————————————————

router.get('/overview', (_req, res) => {
  const posts = db.prepare('SELECT * FROM content_posts ORDER BY publish_date DESC, created_at DESC')
    .all().map(hydrate);
  const topics = db.prepare('SELECT * FROM content_topics ORDER BY status ASC, sort_order ASC').all();
  res.json({
    pillars: PILLARS,
    posts,
    topics,
    counts: {
      to_illustrate: posts.filter(p => p.status === 'to_illustrate').length,
      ready: posts.filter(p => p.status === 'ready').length,
      published: posts.filter(p => p.status === 'published').length,
      topicsLeft: topics.filter(t => t.status === 'idle').length,
    },
  });
});

// Le prochain sujet à traiter. La rotation se fait par pilier — le pilier dont
// le dernier passage est le plus ancien gagne — pour ne pas publier trois
// "anatomie" d'affilée simplement parce qu'ils sont en tête de la liste.
export function pickNextTopic() {
  return db.prepare(`
    SELECT t.*
      FROM content_topics t
      LEFT JOIN (
        SELECT pillar, MAX(used_at) AS last_used
          FROM content_topics WHERE status = 'used' GROUP BY pillar
      ) p ON p.pillar = t.pillar
     WHERE t.status = 'idle'
     ORDER BY (p.last_used IS NOT NULL), p.last_used ASC, t.sort_order ASC
     LIMIT 1
  `).get() || null;
}

router.get('/next-topic', requireIntakeSecret, (_req, res) => {
  const topic = pickNextTopic();
  const left = db.prepare("SELECT COUNT(*) AS n FROM content_topics WHERE status = 'idle'").get().n;
  const recent = db.prepare(
    'SELECT title, pillar, publish_date FROM content_posts ORDER BY created_at DESC LIMIT 15'
  ).all();
  // Performance par pilier — vide tant que rien n'est mesuré, ce qui est le
  // comportement voulu : on ne biaise pas une rotation sur zéro donnée.
  const pillarStats = aggregate(publicationsWithMetrics(), 'pillar').filter((g) => g.n >= 3);
  res.json({ topic, topicsLeft: left, recent, pillars: PILLARS, pillarStats });
});

// —— Écriture ————————————————————————————————————————————————————————

function createPost(body) {
  const id = newId();
  const slides = sanitizeSlides(body.slides);
  db.prepare(`
    INSERT INTO content_posts (id, topic_id, pillar, title, publish_date, slides, caption, hashtags, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'to_illustrate')
  `).run(
    id,
    body.topicId || null,
    body.pillar || null,
    String(body.title || 'Sans titre').slice(0, 200),
    body.publishDate || new Date().toISOString().slice(0, 10),
    JSON.stringify(slides),
    body.caption || '',
    body.hashtags || '',
    body.notes || ''
  );
  if (body.topicId) {
    db.prepare("UPDATE content_topics SET status = 'used', used_at = datetime('now') WHERE id = ?")
      .run(body.topicId);
  }
  return hydrate(db.prepare('SELECT * FROM content_posts WHERE id = ?').get(id));
}

// Appelée par la tâche programmée, depuis l'extérieur du réseau : protégée par
// le même secret porteur que les autres intakes serveur-à-serveur du CRM.
router.post('/intake', requireIntakeSecret, (req, res) => {
  const post = createPost(req.body || {});
  res.status(201).json({ post });
});

// Réapprovisionnement de la banque quand la routine constate qu'elle s'épuise.
router.post('/topics/bulk', requireIntakeSecret, (req, res) => {
  const items = Array.isArray(req.body?.topics) ? req.body.topics : [];
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM content_topics').get().m;
  const ins = db.prepare(
    'INSERT INTO content_topics (id, pillar, title, angle, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  const existing = new Set(
    db.prepare('SELECT LOWER(title) AS t FROM content_topics').all().map(r => r.t)
  );
  let added = 0;
  db.transaction(() => {
    items.slice(0, 40).forEach((t, i) => {
      const title = String(t?.title || '').trim();
      if (!title || existing.has(title.toLowerCase())) return;
      existing.add(title.toLowerCase());
      ins.run(newId(), String(t?.pillar || 'gentleman'), title.slice(0, 200),
        String(t?.angle || '').slice(0, 400), max + (i + 1) * 10);
      added += 1;
    });
  })();
  res.status(201).json({ added });
});

router.post('/posts', (req, res) => res.status(201).json({ post: createPost(req.body || {}) }));

router.patch('/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM content_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const next = {
    title: b.title ?? row.title,
    pillar: b.pillar ?? row.pillar,
    publish_date: b.publishDate ?? row.publish_date,
    caption: b.caption ?? row.caption,
    hashtags: b.hashtags ?? row.hashtags,
    notes: b.notes ?? row.notes,
    status: ['to_illustrate', 'ready', 'published', 'archived'].includes(b.status)
      ? b.status : row.status,
    slides: b.slides ? JSON.stringify(sanitizeSlides(b.slides, parseSlides(row.slides))) : row.slides,
  };
  // Passer en "publié" horodate une fois ; repasser en arrière efface la date
  // plutôt que de laisser un post non publié porter une date de publication.
  const publishedAt = next.status === 'published'
    ? (row.published_at || new Date().toISOString())
    : null;
  db.prepare(`
    UPDATE content_posts
       SET title = ?, pillar = ?, publish_date = ?, caption = ?, hashtags = ?, notes = ?,
           status = ?, slides = ?, published_at = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(next.title, next.pillar, next.publish_date, next.caption, next.hashtags, next.notes,
    next.status, next.slides, publishedAt, req.params.id);
  res.json({ post: hydrate(db.prepare('SELECT * FROM content_posts WHERE id = ?').get(req.params.id)) });
});

router.delete('/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM content_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Les visuels partent avec le post — les garder ne ferait qu'accumuler des
  // fichiers que plus rien ne référence.
  parseSlides(row.slides).forEach((s) => {
    if (s.image) fs.rmSync(path.join(IMAGES_DIR, path.basename(s.image)), { force: true });
  });
  if (row.topic_id) {
    db.prepare("UPDATE content_topics SET status = 'idle', used_at = NULL WHERE id = ?").run(row.topic_id);
  }
  db.prepare('DELETE FROM content_posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// —— Sujets ————————————————————————————————————————————————————————

router.post('/topics', (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'Titre requis' });
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM content_topics').get().m;
  const id = newId();
  db.prepare('INSERT INTO content_topics (id, pillar, title, angle, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, b.pillar || 'gentleman', String(b.title).slice(0, 200), String(b.angle || '').slice(0, 400), max + 10);
  res.status(201).json({ topic: db.prepare('SELECT * FROM content_topics WHERE id = ?').get(id) });
});

router.patch('/topics/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM content_topics WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  // La date suit le drapeau : repasser en « à produire » l'efface, plutôt que
  // de laisser une date qui ne correspond plus à rien.
  const produced = b.produced === undefined ? !!row.produced : !!b.produced;
  db.prepare(`
    UPDATE content_topics
       SET pillar = ?, title = ?, angle = ?, status = ?, produced = ?, produced_at = ?
     WHERE id = ?
  `).run(
    b.pillar ?? row.pillar,
    b.title ?? row.title,
    b.angle ?? row.angle,
    ['idle', 'used', 'dropped'].includes(b.status) ? b.status : row.status,
    produced ? 1 : 0,
    produced ? (row.produced_at || new Date().toISOString()) : null,
    req.params.id
  );
  res.json({ topic: db.prepare('SELECT * FROM content_topics WHERE id = ?').get(req.params.id) });
});

router.delete('/topics/:id', (req, res) => {
  db.prepare('DELETE FROM content_topics WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// —— Performances ————————————————————————————————————————————————————
//
// Ce que les plateformes ne diront jamais : quel PILIER marche, quel format
// tient, quel jour porte. Instagram connaît ses chiffres mais pas ta ligne
// éditoriale ; le CRM connaît les deux, et c'est tout l'intérêt de mesurer ici.

export const PLATFORMS = ['instagram', 'tiktok', 'facebook', 'linkedin'];
const CHECKPOINTS = ['j3', 'j30'];
const CHECKPOINT_DAYS = { j3: 3, j30: 30 };
const METRIC_FIELDS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'follows', 'link_clicks'];

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// L'engagement se rapporte à la portée quand on l'a, aux vues sinon. Mélanger
// les deux dans une même moyenne comparerait des taux qui ne mesurent pas la
// même chose — d'où `base`, exposé pour que l'écran puisse le dire.
function derive(metrics) {
  const m = metrics || {};
  const interactions = ['likes', 'comments', 'shares', 'saves']
    .map((k) => m[k])
    .filter((v) => v != null)
    .reduce((a, b) => a + b, 0);
  const base = m.reach ?? m.views ?? null;
  return {
    interactions: interactions || null,
    base,
    baseKind: m.reach != null ? 'reach' : (m.views != null ? 'views' : null),
    engagementRate: base ? Math.round((interactions / base) * 1000) / 10 : null,
  };
}

function publicationsWithMetrics() {
  const pubs = db.prepare('SELECT * FROM content_publications ORDER BY published_at DESC, created_at DESC').all();
  const metrics = db.prepare('SELECT * FROM content_metrics').all();
  return pubs.map((p) => {
    const own = {};
    metrics.filter((m) => m.publication_id === p.id).forEach((m) => { own[m.checkpoint] = m; });
    return { ...p, metrics: own, derived: { j3: derive(own.j3), j30: derive(own.j30) } };
  });
}

// Les moyennes ne portent que sur J+3 : c'est la seule fenêtre où tous les
// posts sont comparables entre eux, quel que soit leur âge.
function aggregate(pubs, key) {
  const groups = new Map();
  pubs.forEach((p) => {
    const m = p.metrics.j3;
    if (!m) return;
    const g = typeof key === 'function' ? key(p) : p[key];
    if (!g) return;
    if (!groups.has(g)) groups.set(g, { key: g, n: 0, views: [], rates: [] });
    const entry = groups.get(g);
    entry.n += 1;
    const v = m.views ?? m.reach;
    if (v != null) entry.views.push(v);
    const r = p.derived.j3.engagementRate;
    if (r != null) entry.rates.push(r);
  });
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  return [...groups.values()]
    .map((g) => ({ key: g.key, n: g.n, avgViews: avg(g.views), avgEngagementRate: avg(g.rates) }))
    .sort((a, b) => (b.avgEngagementRate ?? -1) - (a.avgEngagementRate ?? -1));
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

router.get('/performance', (_req, res) => {
  const pubs = publicationsWithMetrics();
  const t = today();

  // Ce qu'il y a à relever aujourd'hui. Sans cette file, un relevé à J+30 ne
  // se fait jamais : personne ne tient un calendrier de mesures dans sa tête.
  const due = [];
  pubs.forEach((p) => {
    CHECKPOINTS.forEach((c) => {
      if (!p.metrics[c] && addDays(p.published_at, CHECKPOINT_DAYS[c]) <= t) {
        due.push({ publicationId: p.id, checkpoint: c, title: p.title, platform: p.platform, publishedAt: p.published_at });
      }
    });
  });

  const measured = pubs.filter((p) => p.metrics.j3).length;
  res.json({
    publications: pubs,
    due,
    platforms: PLATFORMS,
    stats: {
      measured,
      byPillar: aggregate(pubs, 'pillar'),
      byPlatform: aggregate(pubs, 'platform'),
      byFormat: aggregate(pubs, 'format'),
      byWeekday: aggregate(pubs, (p) => WEEKDAYS[new Date(`${p.published_at}T12:00:00`).getDay()]),
    },
  });
});

// Publier un carousel sur trois plateformes crée trois lignes : même contenu,
// trois audiences, trois résultats.
router.post('/publications', (req, res) => {
  const b = req.body || {};
  const platforms = (Array.isArray(b.platforms) ? b.platforms : [b.platform])
    .filter((p) => PLATFORMS.includes(p));
  if (!platforms.length) return res.status(400).json({ error: 'Au moins une plateforme' });

  const post = b.postId ? db.prepare('SELECT * FROM content_posts WHERE id = ?').get(b.postId) : null;
  const topic = b.topicId ? db.prepare('SELECT * FROM content_topics WHERE id = ?').get(b.topicId) : null;
  const title = String(b.title || post?.title || topic?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  const created = [];
  const ins = db.prepare(`
    INSERT INTO content_publications (id, post_id, topic_id, title, pillar, platform, format, published_at, url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    platforms.forEach((platform) => {
      const id = newId();
      ins.run(
        id, post?.id || null, topic?.id || post?.topic_id || null, title.slice(0, 200),
        b.pillar || post?.pillar || topic?.pillar || null,
        platform,
        b.format || (post ? 'carousel' : null),
        b.publishedAt || post?.publish_date || today(),
        b.url || null, b.notes || null
      );
      created.push(id);
    });
  })();
  res.status(201).json({ created: created.length });
});

router.patch('/publications/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM content_publications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE content_publications
       SET title = ?, pillar = ?, platform = ?, format = ?, published_at = ?, url = ?, notes = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    b.title ?? row.title,
    b.pillar ?? row.pillar,
    PLATFORMS.includes(b.platform) ? b.platform : row.platform,
    b.format ?? row.format,
    b.publishedAt ?? row.published_at,
    b.url ?? row.url,
    b.notes ?? row.notes,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/publications/:id', (req, res) => {
  db.prepare('DELETE FROM content_metrics WHERE publication_id = ?').run(req.params.id);
  db.prepare('DELETE FROM content_publications WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Un relevé se corrige, il ne s'empile pas : re-saisir J+3 remplace le
// précédent (index unique sur publication_id + checkpoint).
router.put('/publications/:id/metrics/:checkpoint', (req, res) => {
  const row = db.prepare('SELECT * FROM content_publications WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const checkpoint = req.params.checkpoint;
  if (!CHECKPOINTS.includes(checkpoint)) return res.status(400).json({ error: 'Relevé inconnu' });

  const b = req.body || {};
  // Un champ laissé vide reste NULL : « non mesuré » et « zéro » ne sont pas
  // la même chose, et confondre les deux fausserait toutes les moyennes.
  const values = METRIC_FIELDS.map((f) => {
    const raw = b[f] ?? b[f.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  });

  const existing = db.prepare('SELECT id FROM content_metrics WHERE publication_id = ? AND checkpoint = ?')
    .get(req.params.id, checkpoint);
  if (existing) {
    db.prepare(`
      UPDATE content_metrics
         SET measured_at = ?, ${METRIC_FIELDS.map((f) => `${f} = ?`).join(', ')}
       WHERE id = ?
    `).run(today(), ...values, existing.id);
  } else {
    db.prepare(`
      INSERT INTO content_metrics (id, publication_id, checkpoint, measured_at, ${METRIC_FIELDS.join(', ')})
      VALUES (?, ?, ?, ?, ${METRIC_FIELDS.map(() => '?').join(', ')})
    `).run(newId(), req.params.id, checkpoint, today(), ...values);
  }
  res.json({ ok: true });
});

// —— Visuels ————————————————————————————————————————————————————————
//
// Le corps de la requête est l'image elle-même : pas de multipart, donc pas de
// dépendance supplémentaire pour un besoin qui se résume à « écris ces octets ».

router.put(
  '/posts/:id/slides/:n/image',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '15mb' }),
  (req, res) => {
    const row = db.prepare('SELECT * FROM content_posts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const ext = EXT[req.headers['content-type']];
    if (!ext) return res.status(415).json({ error: 'Format accepté : JPG, PNG ou WebP' });
    if (!req.body?.length) return res.status(400).json({ error: 'Image vide' });

    const slides = parseSlides(row.slides);
    const idx = Number(req.params.n) - 1;
    if (!slides[idx]) return res.status(404).json({ error: 'Slide inconnue' });

    if (slides[idx].image) {
      fs.rmSync(path.join(IMAGES_DIR, path.basename(slides[idx].image)), { force: true });
    }
    const file = `${row.id}-${idx + 1}-${randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, file), req.body);
    slides[idx].image = file;

    // Tous les visuels déposés : le carousel bascule tout seul en « prêt ».
    // C'est l'état que Luc veut voir sans avoir à le cocher lui-même.
    const allIllustrated = slides.every((s) => s.image);
    const status = row.status === 'to_illustrate' && allIllustrated ? 'ready' : row.status;
    db.prepare('UPDATE content_posts SET slides = ?, status = ? WHERE id = ?')
      .run(JSON.stringify(slides), status, row.id);
    touch(row.id);
    res.json({ post: hydrate(db.prepare('SELECT * FROM content_posts WHERE id = ?').get(row.id)) });
  }
);

router.delete('/posts/:id/slides/:n/image', (req, res) => {
  const row = db.prepare('SELECT * FROM content_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const slides = parseSlides(row.slides);
  const idx = Number(req.params.n) - 1;
  if (!slides[idx]) return res.status(404).json({ error: 'Slide inconnue' });
  if (slides[idx].image) {
    fs.rmSync(path.join(IMAGES_DIR, path.basename(slides[idx].image)), { force: true });
    slides[idx].image = null;
  }
  const status = row.status === 'ready' ? 'to_illustrate' : row.status;
  db.prepare('UPDATE content_posts SET slides = ?, status = ? WHERE id = ?')
    .run(JSON.stringify(slides), status, row.id);
  touch(row.id);
  res.json({ post: hydrate(db.prepare('SELECT * FROM content_posts WHERE id = ?').get(row.id)) });
});

router.get('/images/:file', (req, res) => {
  // basename() seul décide du nom lu : un ../ dans l'URL ne peut pas sortir du dossier.
  const file = path.basename(req.params.file);
  const full = path.join(IMAGES_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

export default router;
