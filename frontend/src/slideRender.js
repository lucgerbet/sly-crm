// Compose les visuels Instagram, dans le navigateur, en canvas.
//
// La photo vient de Higgsfield ; le texte, la typo et la charte viennent
// d'ici. Séparer les deux évite le piège habituel du visuel généré : demander
// à un modèle d'image d'écrire du texte, qu'il rend systématiquement faux ou
// mal coupé. Ici le texte est vectoriel, net, et modifiable après coup sans
// régénérer quoi que ce soit.

export const W = 1080;
export const H = 1350;

const IVORY = '#F4EFE7';
const ESPRESSO = '#3A2A23';
const TAUPE = '#7A6B58';
const CHERRY = '#5A1F24';

const SERIF = '"Cormorant Garamond", Georgia, serif';
const SANS = 'Inter, system-ui, sans-serif';

export const imageUrl = (file) => `/api/content/images/${file}`;

// Les polices doivent être réellement chargées avant le premier fillText,
// sinon le canvas rend en fallback système et le visuel part de travers.
export async function ensureFonts() {
  if (!document.fonts) return;
  await Promise.all([
    document.fonts.load(`700 96px ${SERIF}`),
    document.fonts.load(`500 96px ${SERIF}`),
    document.fonts.load(`400 32px ${SANS}`),
    document.fonts.load(`500 24px ${SANS}`),
  ]).catch(() => {});
  await document.fonts.ready;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

// Remplit la zone sans déformer : on recadre, on n'étire jamais.
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function wrap(ctx, text, maxWidth) {
  const out = [];
  String(text || '').split('\n').forEach((paragraph) => {
    let line = '';
    paragraph.split(/\s+/).filter(Boolean).forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    out.push(line);
  });
  return out.filter((l) => l !== '' || out.length === 1);
}

// `y` est la ligne de base de la PREMIÈRE ligne — pas le haut du bloc. Le
// retour est la ligne de base de la dernière, ce qui est ce dont on a besoin
// pour empiler des blocs sans les faire se chevaucher.
function drawLines(ctx, lines, x, y, lineHeight) {
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return y + (lines.length - 1) * lineHeight;
}

// Un titre long doit rétrécir plutôt que déborder : on descend la taille
// jusqu'à ce que le bloc tienne dans la hauteur qu'on lui a réservée.
function fitHeadline(ctx, text, maxWidth, maxHeight, startSize, weight = '600') {
  let size = startSize;
  for (;;) {
    ctx.font = `${weight} ${size}px ${SERIF}`;
    const lines = wrap(ctx, text, maxWidth);
    const lineHeight = size * 1.05;
    if (lines.length * lineHeight <= maxHeight || size <= 40) return { size, lines, lineHeight };
    size -= 4;
  }
}

// Même logique que fitHeadline pour le corps de texte : un paragraphe long
// rétrécit au lieu de sortir de la slide.
function fitBody(ctx, text, maxWidth, maxHeight, startSize = 32) {
  let size = startSize;
  for (;;) {
    ctx.font = `400 ${size}px ${SANS}`;
    const lines = wrap(ctx, text, maxWidth);
    const lineHeight = Math.round(size * 1.44);
    if ((lines.length - 1) * lineHeight <= maxHeight || size <= 20) return { size, lines, lineHeight };
    size -= 2;
  }
}

function smallCaps(ctx, text, x, y, color, size = 22) {
  ctx.font = `500 ${size}px ${SANS}`;
  ctx.fillStyle = color;
  const letters = String(text || '').toUpperCase().split('');
  let cx = x;
  letters.forEach((ch) => {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + size * 0.14; // interlettrage éditorial
  });
  return cx;
}

function drawWordmark(ctx, color, y = H - 56) {
  smallCaps(ctx, 'SLY Atelier', 72, y, color, 20);
}

// —— Les deux mises en page ————————————————————————————————————————
//
// `hero` pour l'accroche et l'appel à l'action : la photo occupe tout, le
// texte se pose dessus. `split` pour les slides pédagogiques : la photo
// illustre, le bloc ivoire porte l'explication et reste lisible en petit.

function renderHero(ctx, slide, img, meta) {
  if (img) {
    drawCover(ctx, img, 0, 0, W, H);
    const scrim = ctx.createLinearGradient(0, H * 0.25, 0, H);
    scrim.addColorStop(0, 'rgba(26,18,15,0)');
    scrim.addColorStop(0.55, 'rgba(26,18,15,0.72)');
    scrim.addColorStop(1, 'rgba(26,18,15,0.94)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = ESPRESSO;
    ctx.fillRect(0, 0, W, H);
  }

  const margin = 72;
  const maxWidth = W - margin * 2;
  ctx.textBaseline = 'alphabetic';

  if (slide.kicker) smallCaps(ctx, slide.kicker, margin, 120, 'rgba(244,239,231,0.72)', 22);

  // Tout se construit depuis le bas : la dernière ligne de texte s'arrête
  // au-dessus du filet de pilier, qui reste au-dessus de la signature.
  const lastBaseline = H - 156;
  const body = slide.body ? fitBody(ctx, slide.body, maxWidth, 200, 32) : null;
  const bodyTop = body ? lastBaseline - (body.lines.length - 1) * body.lineHeight : null;
  const headlineLast = body ? bodyTop - 68 : lastBaseline;
  const headline = fitHeadline(ctx, slide.headline, maxWidth, 520, 108, '600');
  const headlineTop = headlineLast - (headline.lines.length - 1) * headline.lineHeight;

  ctx.fillStyle = IVORY;
  ctx.font = `600 ${headline.size}px ${SERIF}`;
  drawLines(ctx, headline.lines, margin, headlineTop, headline.lineHeight);

  if (body) {
    ctx.font = `400 ${body.size}px ${SANS}`;
    ctx.fillStyle = 'rgba(244,239,231,0.82)';
    drawLines(ctx, body.lines, margin, bodyTop, body.lineHeight);
  }

  // Le filet couleur du pilier : le seul repère de rubrique, discret.
  ctx.fillStyle = meta.pillarColor || CHERRY;
  ctx.fillRect(margin, H - 108, 96, 4);
  drawWordmark(ctx, 'rgba(244,239,231,0.6)');
}

function renderSplit(ctx, slide, img, meta) {
  const imgH = Math.round(H * 0.56);
  ctx.fillStyle = IVORY;
  ctx.fillRect(0, 0, W, H);

  if (img) {
    drawCover(ctx, img, 0, 0, W, imgH);
  } else {
    ctx.fillStyle = '#E8E1D5';
    ctx.fillRect(0, 0, W, imgH);
    ctx.fillStyle = TAUPE;
    ctx.font = `500 28px ${SANS}`;
    ctx.fillText('visuel à déposer', 72, imgH / 2);
  }

  // Pastille de numéro : on suit un carousel du coin de l'œil, pas en lisant.
  const badge = 74;
  ctx.fillStyle = IVORY;
  ctx.beginPath();
  ctx.arc(W - 72 - badge / 2, 72 + badge / 2, badge / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ESPRESSO;
  ctx.font = `600 34px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(meta.index).padStart(2, '0'), W - 72 - badge / 2, 72 + badge / 2 + 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const margin = 72;
  const maxWidth = W - margin * 2;
  let y = imgH + 92;

  if (slide.kicker) {
    smallCaps(ctx, slide.kicker, margin, y, meta.pillarColor || CHERRY, 21);
    y += 46;
  }

  const headline = fitHeadline(ctx, slide.headline, maxWidth, 230, 78, '600');
  ctx.fillStyle = ESPRESSO;
  ctx.font = `600 ${headline.size}px ${SERIF}`;
  y = drawLines(ctx, headline.lines, margin, y + headline.size * 0.82, headline.lineHeight) + 60;

  if (slide.body) {
    // Ce qui reste jusqu'à la signature, et pas un pixel de plus.
    const body = fitBody(ctx, slide.body, maxWidth, (H - 116) - y, 31);
    ctx.font = `400 ${body.size}px ${SANS}`;
    ctx.fillStyle = '#5B4C43';
    drawLines(ctx, body.lines, margin, y, body.lineHeight);
  }

  drawWordmark(ctx, TAUPE);
}

// —— API ————————————————————————————————————————————————————————————

export async function renderSlideCanvas(slide, meta) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  let img = null;
  if (slide.image) {
    try { img = await loadImage(imageUrl(slide.image)); } catch { img = null; }
  }

  const layout = slide.layout === 'hero' || meta.index === 1 || meta.index === meta.total
    ? 'hero' : 'split';
  if (layout === 'hero') renderHero(ctx, slide, img, meta);
  else renderSplit(ctx, slide, img, meta);

  return canvas;
}

function download(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resolve();
    }, 'image/png');
  });
}

const slugify = (s) => String(s || 'sly')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export async function downloadSlide(post, slide, meta) {
  await ensureFonts();
  const canvas = await renderSlideCanvas(slide, meta);
  await download(canvas, `${post.publish_date}-${slugify(post.title)}-${String(meta.index).padStart(2, '0')}.png`);
}

export async function downloadAllSlides(post, pillarColor) {
  await ensureFonts();
  const total = post.slides.length;
  for (let i = 0; i < total; i += 1) {
    const canvas = await renderSlideCanvas(post.slides[i], { index: i + 1, total, pillarColor });
    await download(canvas, `${post.publish_date}-${slugify(post.title)}-${String(i + 1).padStart(2, '0')}.png`);
    // Les navigateurs étranglent les téléchargements en rafale ; on espace.
    await new Promise((r) => setTimeout(r, 350));
  }
}
