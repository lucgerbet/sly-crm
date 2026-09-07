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
  res.json({ topic, topicsLeft: left, recent, pillars: PILLARS });
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
  db.prepare('UPDATE content_topics SET pillar = ?, title = ?, angle = ?, status = ? WHERE id = ?')
    .run(
      b.pillar ?? row.pillar,
      b.title ?? row.title,
      b.angle ?? row.angle,
      ['idle', 'used', 'dropped'].includes(b.status) ? b.status : row.status,
      req.params.id
    );
  res.json({ topic: db.prepare('SELECT * FROM content_topics WHERE id = ?').get(req.params.id) });
});

router.delete('/topics/:id', (req, res) => {
  db.prepare('DELETE FROM content_topics WHERE id = ?').run(req.params.id);
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
