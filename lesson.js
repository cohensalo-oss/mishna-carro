// Aulas do משנה יומית (site ecohen100-collab.github.io/mishna-yomit).
// A tabela de aulas é lida do próprio site (e guardada para usar sem internet).
// Cada aula cobre 3 mishnaiot seguidas, contadas em sequência dentro do seder.
import * as db from './db.js';
import { normWord } from './text.js';

export const SITE = 'https://ecohen100-collab.github.io/mishna-yomit/';
const DAY = 24 * 3600 * 1000;

let siteP = null;

function parseSite(html) {
  const a = html.indexOf('const SEDARIM = ');
  if (a < 0) throw new Error('מבנה האתר השתנה');
  const b = html.indexOf(';\n', a);
  const sedarim = JSON.parse(html.slice(a + 16, b));
  const k = html.match(/DRIVE_KEY\s*=\s*['"]([^'"]+)['"]/);
  const tractates = [];
  for (const s of sedarim) for (const m of s.m) tractates.push({ seder: s.n, n: m.n, ch: m.ch, off: m.off, a: m.a || [] });
  return { key: k ? k[1] : '', tractates, fetched: Date.now() };
}

// Carrega a tabela (cache de 1 dia; sem internet usa a última guardada).
export function site() {
  return siteP ||= (async () => {
    const cached = await db.get('kv', 'yomit');
    if (cached && Date.now() - cached.fetched < DAY) return cached;
    try {
      const r = await fetch(SITE, { cache: 'no-cache' });
      const data = parseSite(await r.text());
      await db.put('kv', 'yomit', data);
      return data;
    } catch (e) {
      if (cached) return cached;
      siteP = null;
      throw new Error('לא הצלחתי לטעון את השיעורים (' + e.message + ')');
    }
  })();
}

const key = s => s.split(/\s+/).map(normWord).join(' ');

// Encontra a masechet do site que corresponde à masechet do app (nomes podem ter grafias diferentes).
export async function findTractate(tr) {
  const d = await site();
  // nome exato primeiro (שבועות x שביעית ficam iguais sem ו/י); depois grafia aproximada (עדיות/עדויות)
  return d.tractates.find(m => m.n === tr.he) || d.tractates.find(m => key(m.n) === key(tr.he)) || null;
}

const flat = (ch, c, i) => ch.slice(0, c - 1).reduce((a, b) => a + b, 0) + i; // 1-based

// Igual ao site: número da aula (1-based) que contém a mishna j (1-based na masechet)
function lessonNo(m, j) {
  return Math.ceil((m.off + j) / 3) - Math.ceil((m.off + 1) / 3) + 1;
}

function fromFlat(ch, j) {
  let c = 1;
  while (c <= ch.length && j > ch[c - 1]) { j -= ch[c - 1]; c++; }
  return [c, j];
}

// Informação da aula de uma mishna: url, número, e quais mishnaiot a aula cobre.
export async function lessonOf(tr, c, i) {
  const m = await findTractate(tr);
  if (!m || c > m.ch.length || i > m.ch[c - 1]) return null;
  const j = flat(m.ch, c, i);
  const n = lessonNo(m, j);
  const id = m.a[n - 1];
  if (!id) return null;
  const total = m.ch.reduce((a, b) => a + b, 0);
  const members = [];
  for (let k = Math.max(1, j - 2); k <= Math.min(total, j + 2); k++) if (lessonNo(m, k) === n) members.push(fromFlat(m.ch, k));
  const d = await site();
  return {
    n, id, members, index: members.findIndex(([x, y]) => x === c && y === i),
    url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${d.key}`,
  };
}

// ---------- marcações de tempo (onde cada mishna começa dentro da aula) ----------
// marks:<aula id> = { "c:i": segundos }
export const getMarks = async id => (await db.get('kv', 'marks:' + id)) || {};
export const setMarks = (id, marks) => db.put('kv', 'marks:' + id, marks);

// Marcações automáticas: onde o rabino anuncia "משנה ב'", "משנה ג'"... (lessons.json, gerado por tools/lesson_marks.py)
let autoP = null;
export async function autoMarks(id) {
  autoP ||= fetch('lessons.json').then(r => (r.ok ? r.json() : {})).catch(() => { autoP = null; return {}; });
  const m = { ...((await autoP)[id] || {}) };
  delete m._;
  return m;
}
// marcações do usuário valem mais que as automáticas
export async function allMarks(id) {
  const [auto, user] = await Promise.all([autoMarks(id), getMarks(id)]);
  return { user, merged: { ...auto, ...user } };
}

// Início/fim estimados da mishna na aula: marcações do usuário, senão proporcional ao tamanho do texto.
export function segmentTimes(lesson, marks, weights, dur) {
  const k = lesson.members.map(([c, i]) => c + ':' + i);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const est = idx => (dur * weights.slice(0, idx).reduce((a, b) => a + b, 0)) / total;
  const at = idx => {
    if (idx >= k.length) return dur;
    if (marks[k[idx]] != null) return marks[k[idx]];
    // entre marcações conhecidas, distribui proporcionalmente
    let lo = 0, tlo = 0;
    for (let x = idx - 1; x >= 0; x--) if (marks[k[x]] != null) { lo = x; tlo = marks[k[x]]; break; }
    let hi = k.length, thi = dur;
    for (let x = idx + 1; x < k.length; x++) if (marks[k[x]] != null) { hi = x; thi = marks[k[x]]; break; }
    const span = est(hi) - est(lo) || 1;
    return tlo + ((est(idx) - est(lo)) * (thi - tlo)) / span;
  };
  const me = lesson.index;
  return { start: at(me), end: me + 1 >= k.length ? null : at(me + 1), exact: marks[k[me]] != null, key: k[me] };
}

// ---------- player ----------
export const audio = new Audio();
audio.preload = 'auto';
let rate = 1;
export function setRate(r) { rate = r; audio.playbackRate = r; }

function once(el, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { off(); rej(new Error('timeout')); }, ms);
    const ok = () => { off(); res(); };
    const bad = () => { off(); rej(new Error('לא הצלחתי לטעון את השמע של השיעור')); };
    const off = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
  });
}

export async function load(url) {
  if (audio.src !== url) {
    audio.src = url;
    await once(audio, 'loadedmetadata', 30000);
  } else if (!audio.duration) {
    await once(audio, 'loadedmetadata', 30000);
  }
  return audio.duration;
}

export const pause = () => audio.pause();
export const position = () => audio.currentTime;

// Toca de start até end (null = até o fim). onBlocked é chamado se o navegador exigir um toque para tocar.
export async function playSegment(url, start, end, { signal, onBlocked } = {}) {
  await load(url);
  if (signal?.aborted) return;
  audio.currentTime = Math.max(0, start);
  audio.playbackRate = rate;
  try {
    await audio.play();
  } catch (e) {
    if (e.name !== 'NotAllowedError') throw e;
    onBlocked?.();
    await new Promise(res => {
      const go = () => { audio.removeEventListener('play', go); res(); };
      audio.addEventListener('play', go);
      signal?.addEventListener('abort', go, { once: true });
    });
    if (signal?.aborted) return;
  }
  await new Promise(res => {
    const stop = () => { clearInterval(iv); audio.removeEventListener('ended', stop); res(); };
    const iv = setInterval(() => {
      if (end != null && audio.currentTime >= end) { audio.pause(); stop(); }
    }, 100);
    audio.addEventListener('ended', stop);
    signal?.addEventListener('abort', () => { audio.pause(); stop(); }, { once: true });
  });
}
