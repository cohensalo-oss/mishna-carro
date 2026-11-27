// שינון: ouvir a repetição (reconhecimento de voz em hebraico) e comparar com o texto
import { normWord } from './text.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = !!SR;

// Escuta até o usuário parar de falar. Resolve com o texto reconhecido.
// onText(texto) é chamado a cada atualização. Lança erro se o microfone for negado.
export function listen({ maxMs = 60000, silenceMs = 2200, startMs = 9000, signal, onText } = {}) {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error('אין זיהוי דיבור בדפדפן הזה'));
    const prev = [];
    let finals = [], interim = '', done = false, rec, lastAct = 0;
    const started = Date.now();
    const text = () => [...prev, ...finals, interim].join(' ').replace(/\s+/g, ' ').trim();
    const finish = err => {
      if (done) return;
      done = true;
      clearInterval(timer);
      try { rec.abort(); } catch {}
      err ? reject(err) : resolve(text());
    };
    const begin = () => {
      rec = new SR();
      rec.lang = 'he-IL';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      finals = [];
      interim = '';
      rec.onresult = e => {
        const f = [];
        let it = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0].transcript.trim();
          if (!r.isFinal) { it += ' ' + t; continue; }
          // alguns Androids repetem o resultado anterior acumulado: "a", "a b", "a b c"
          if (f.length && t.startsWith(f[f.length - 1])) f[f.length - 1] = t; else f.push(t);
        }
        finals = f;
        interim = it.trim();
        lastAct = Date.now();
        onText?.(text());
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          finish(new Error('המיקרופון או זיהוי הדיבור חסומים. אשרו גישה למיקרופון לאתר הזה.'));
        }
      };
      rec.onend = () => {
        if (done) return;
        prev.push(...finals);
        if (interim) prev.push(interim);
        try { begin(); } catch { finish(); }
      };
      rec.start();
    };
    signal?.addEventListener('abort', () => finish(), { once: true });
    try { begin(); } catch (e) { return reject(e); }
    const timer = setInterval(() => {
      const now = Date.now();
      const heard = lastAct > 0;
      if (now - started > maxMs) finish();
      else if (heard && now - lastAct > silenceMs) finish();
      else if (!heard && now - started > startMs) finish();
    }, 200);
  });
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// Alinha as palavras esperadas (ref) com as ouvidas. Devolve quais palavras do texto foram ditas.
// freeEnd: o usuário pode ter parado antes do fim de ref; o resto não lido não custa nada
// (assim o alinhamento não puxa as últimas palavras para uma repetição igual mais adiante).
export function compare(refTokens, heardText, { softStart = 0, softEnd = 0, freeEnd = false } = {}) {
  const ref = refTokens.map(t => t.norm);
  const hyp = heardText.split(/\s+/).map(normWord).filter(Boolean);
  const n = ref.length, m = hyp.length;
  const INS = 0.6, DEL = 1;
  const D = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { D[i][0] = i * DEL; B[i][0] = 1; }
  for (let j = 1; j <= m; j++) { D[0][j] = j * INS; B[0][j] = 2; }
  const S = Array.from({ length: n }, () => new Float32Array(m));
  const cost = s => (s >= 0.55 ? 1 - s : 1.3);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = (S[i - 1][j - 1] = sim(ref[i - 1], hyp[j - 1]));
      let best = D[i - 1][j - 1] + cost(s), b = 0;
      if (D[i - 1][j] + DEL < best) { best = D[i - 1][j] + DEL; b = 1; }
      if (D[i][j - 1] + INS < best) { best = D[i][j - 1] + INS; b = 2; }
      // o reconhecimento às vezes junta duas palavras ("כל שהוא" -> "כלשהו") ou separa uma
      if (i > 1) {
        const s2 = sim(ref[i - 2] + ref[i - 1], hyp[j - 1]);
        if (s2 >= 0.7 && D[i - 2][j - 1] + (1 - s2) * 2 < best) { best = D[i - 2][j - 1] + (1 - s2) * 2; b = 3; }
      }
      if (j > 1) {
        const s2 = sim(ref[i - 1], hyp[j - 2] + hyp[j - 1]);
        if (s2 >= 0.7 && D[i - 1][j - 2] + (1 - s2) < best) { best = D[i - 1][j - 2] + (1 - s2); b = 4; }
      }
      D[i][j] = best;
      B[i][j] = b;
    }
  }
  const ok = new Array(n).fill(false);
  let i = n, j = m;
  if (freeEnd) for (let k = n - 1; k >= 0; k--) if (D[k][m] < D[i][m]) i = k;
  while (i > 0 || j > 0) {
    const b = i > 0 && j > 0 ? B[i][j] : i > 0 ? 1 : 2;
    if (b === 0) { ok[i - 1] = S[i - 1][j - 1] >= 0.6; i--; j--; }
    else if (b === 1) i--;
    else if (b === 2) j--;
    else if (b === 3) { ok[i - 1] = ok[i - 2] = true; i -= 2; j--; }
    else { ok[i - 1] = true; i--; j -= 2; }
  }
  // pontas "macias" de uma parte: o corte do áudio ali é estimado, então palavra faltando ali não conta (fica null)
  for (let k = 0; k < n; k++) if (!ok[k] && (k < softStart || k >= n - softEnd)) ok[k] = null;
  const hits = ok.filter(Boolean).length;
  const counted = ok.filter(v => v !== null).length;
  // erros que importam: trecho pulado (3+ palavras seguidas) ou nome/decisão trocados
  let run = 0, bigRun = -1;
  ok.forEach((v, k) => { run = v !== false ? 0 : run + 1; if (run === 3 && bigRun < 0) bigRun = k - 2; });
  const critical = ok.findIndex((v, k) => v === false && isCritical(ref, k));
  const serious = [bigRun, critical].filter(x => x >= 0);
  return {
    ok, score: counted ? hits / counted : 1,
    firstMiss: serious.length ? Math.min(...serious) : ok.indexOf(false),
    serious: serious.length > 0,
  };
}

// palavras que não podem ser trocadas: o nome depois de רבי/רבן/בית e as decisões
const RULINGS = ['חב', 'פטר', 'טמא', 'טהר', 'כשר', 'פסל', 'מתר', 'אסר', 'זכאה', 'פסלה', 'כשרה', 'טמאה', 'טהרה', 'מתרת', 'אסרה', 'פטרה', 'חבת', 'חבב', 'פטרנ', 'חבנ']
  .map(normWord);
function isCritical(ref, k) {
  const prev = ref[k - 1];
  if (prev === normWord('רבי') || prev === normWord('רבן') || prev === normWord('בית')) return true;
  return RULINGS.includes(ref[k]);
}

// Divide uma mishna em partes. Só corta em fim de frase (ponto / dois-pontos);
// frases curtas seguidas ficam juntas (até maxWords). Só uma frase bem mais longa que o máximo
// (> longWords, ~25% a mais) é cortada na vírgula.
export function splitParts(tokens, maxWords = 16, longWords = Math.round(maxWords * 1.25)) {
  const cut = (from, to, level) => { // [from,to) em trechos que terminam em brk >= level
    const out = [];
    let s = from;
    for (let i = from; i < to; i++) if (tokens[i].brk >= level || i === to - 1) { out.push([s, i + 1]); s = i + 1; }
    return out;
  };
  const len = ([a, b]) => b - a;
  const sentences = [];
  for (const s of cut(0, tokens.length, 2)) {
    if (len(s) <= longWords) { sentences.push(s); continue; }
    // frase longa demais: junta os trechos entre vírgulas em blocos de ~maxWords
    let cur = null;
    for (const c of cut(s[0], s[1], 1)) {
      if (cur && len(cur) + len(c) > maxWords && len(cur) >= 6) { sentences.push(cur); cur = null; }
      cur = cur ? [cur[0], c[1]] : c;
    }
    if (cur) {
      const last = sentences[sentences.length - 1];
      if (len(cur) < 6 && last && last[1] === cur[0] && last[0] >= s[0]) last[1] = cur[1]; else sentences.push(cur);
    }
  }
  const parts = [];
  for (const s of sentences) {
    const p = parts[parts.length - 1];
    if (p && len(p) + len(s) <= maxWords) p[1] = s[1]; else parts.push(s.slice());
  }
  // uma última parte minúscula vai junto com a anterior
  if (parts.length > 1 && len(parts[parts.length - 1]) < 4) { const x = parts.pop(); parts[parts.length - 1][1] = x[1]; }
  return parts; // [início, fim) em índices de palavra
}

// Trecho (frase) que contém a palavra w: [início, fim)
export function phraseAround(tokens, w) {
  let a = w, b = w;
  while (a > 0 && !tokens[a - 1].end) a--;
  while (b < tokens.length - 1 && !tokens[b].end) b++;
  return [a, b + 1];
}
