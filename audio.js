// Áudio: gravação, decodificação, tocar um trecho exato, sinais sonoros e divisão automática em mishnaiot
let ctx;

export function ac() {
  if (!ctx) {
    try { ctx = new AudioContext({ sampleRate: 24000 }); } catch { ctx = new AudioContext(); }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export async function decode(blob) {
  const data = await blob.arrayBuffer();
  return await ac().decodeAudioData(data);
}

// Toca buf de a até b (segundos). Resolve no fim ou quando signal é abortado.
export function playRange(buf, a, b, signal) {
  return new Promise(res => {
    const c = ac();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      res();
    };
    const abort = () => { try { src.stop(); } catch {} end(); };
    src.onended = end;
    if (signal?.aborted) return end();
    signal?.addEventListener('abort', abort);
    const start = Math.max(0, a);
    src.start(0, start, Math.max(0.05, Math.min(b, buf.duration) - start));
  });
}

export function sleep(ms, signal) {
  return new Promise(res => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
}

function tone(freq, start, dur, gain = 0.25) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.05);
}

// Sinais: 'turn' = sua vez de falar, 'ok' = acertou, 'bad' = errou, 'next' = próxima etapa
export function cue(kind) {
  const seq = {
    turn: [[660, 0, 0.12], [880, 0.15, 0.18]],
    ok: [[784, 0, 0.12], [988, 0.12, 0.12], [1319, 0.24, 0.3]],
    bad: [[330, 0, 0.18], [262, 0.2, 0.3]],
    next: [[523, 0, 0.15]],
  }[kind] || [];
  seq.forEach(([f, s, d]) => tone(f, s, d));
  const total = Math.max(...seq.map(([, s, d]) => s + d), 0);
  return new Promise(r => setTimeout(r, total * 1000 + 150));
}

// ---------- gravação ----------
export async function startRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
  });
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mime = types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : {});
  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  let t0 = 0, pausedAt = 0, pausedTotal = 0;
  await new Promise(r => { mr.onstart = () => { t0 = performance.now(); r(); }; mr.start(1000); });
  return {
    elapsed: () => ((pausedAt || performance.now()) - t0 - pausedTotal) / 1000,
    paused: () => !!pausedAt,
    pause() { if (!pausedAt) { mr.pause(); pausedAt = performance.now(); } },
    resume() { if (pausedAt) { mr.resume(); pausedTotal += performance.now() - pausedAt; pausedAt = 0; } },
    stop: () => new Promise(r => {
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        r(new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' }));
      };
      mr.stop();
    }),
  };
}

// ---------- divisão automática ----------
const HOP = 0.02;
const energyCache = new WeakMap();
// Energia (dB) a cada 20 ms e o limiar entre fala e silêncio.
function energy(buf) {
  let r = energyCache.get(buf);
  if (r) return r;
  const x = buf.getChannelData(0);
  const step = Math.round(buf.sampleRate * HOP);
  const n = Math.floor(x.length / step);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * step, k = j + step; j < k; j++) s += x[j] * x[j];
    e[i] = 10 * Math.log10(s / step + 1e-10);
  }
  const sorted = Array.from(e).sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.1)] ?? -100;
  const hi = sorted[Math.floor(n * 0.8)] ?? 0;
  r = { e, thr: lo + 0.3 * (hi - lo) };
  energyCache.set(buf, r);
  return r;
}

// Encontra pausas (silêncio) na gravação.
export function findGaps(buf, minGap = 0.2) {
  const { e, thr } = energy(buf);
  const n = e.length;
  const gaps = [];
  let run = -1, vStart = -1, vEnd = 0;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && e[i] < thr;
    if (i < n && !quiet) { if (vStart < 0) vStart = i; vEnd = i; }
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      if ((i - run) * HOP >= minGap) gaps.push({ start: run * HOP, end: i * HOP });
      run = -1;
    }
  }
  return { gaps, vStart: Math.max(0, vStart) * HOP, vEnd: (vEnd + 1) * HOP };
}

// Onde a fala realmente começa e termina dentro de [a, b] (corta o silêncio das pontas).
export function trimRange(buf, a, b, padIn = 0.25, padOut = 0.35) {
  const { e, thr } = energy(buf);
  const i0 = Math.max(0, Math.floor(a / HOP)), i1 = Math.min(e.length, Math.ceil(b / HOP));
  const MIN = 4; // 80 ms seguidos de som contam como fala (um clique não conta)
  let on = -1, off = -1, run = 0;
  for (let i = i0; i < i1; i++) {
    if (e[i] >= thr) { if (++run >= MIN) { on = i - MIN + 1; break; } } else run = 0;
  }
  run = 0;
  for (let i = i1 - 1; i >= i0; i--) {
    if (e[i] >= thr) { if (++run >= MIN) { off = i + MIN; break; } } else run = 0;
  }
  if (on < 0 || off <= on) return [a, b];
  return [Math.max(a, on * HOP - padIn), Math.min(b, off * HOP + padOut)];
}

// Tempo de cada palavra dentro de seg=[a, b] (já sem silêncio nas pontas).
// weights[i] = duração relativa da palavra i; brk[i] = 2 se a palavra i termina uma frase (ponto), 1 se vírgula, 0 se nada.
// Devolve bounds (n+1): bounds[i] = { s, e } = fim da palavra i-1 e começo da palavra i (iguais quando não há pausa ali).
// Cada pausa da gravação é casada com uma fronteira entre palavras (de preferência com pontuação), escolhendo
// a combinação em que o ritmo de fala fica mais constante (programação dinâmica).
export function wordBounds(buf, [a, b], weights, brk, opt = {}) {
  const o = { minGap: 0.18, sigma: 1.1, r2: 2.5, r1: 2, r0: 2, skip2: 1.2, skip1: 0.2, skipGap: 4, ...opt };
  const n = weights.length;
  const gaps = findGaps(buf, o.minGap).gaps
    .map(g => ({ start: Math.max(g.start, a), end: Math.min(g.end, b) }))
    .filter(g => g.end - g.start >= o.minGap && g.start > a + 0.15 && g.end < b - 0.15);
  const K = gaps.length;
  // tempo "falado" (sem as pausas) até t, e o inverso
  const voiced = t => { let v = t - a; for (const g of gaps) { if (g.end <= t) v -= g.end - g.start; else if (g.start < t) v -= t - g.start; } return v; };
  const real = v => { let t = a + v; for (const g of gaps) { if (g.start < t) t += g.end - g.start; else break; } return t; };
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + weights[i]);
  const V = voiced(b), rate = V / (cum[n] || 1);
  // nós: 0 = início, 1..K = pausas, K+1 = fim
  const vAt = [0, ...gaps.map(g => voiced(g.start)), V];
  const gapCost = g => o.skipGap * Math.max(0, g.end - g.start - 0.08);
  const skipG = [0];
  for (let j = 1; j <= K; j++) skipG.push(skipG[j - 1] + gapCost(gaps[j - 1]));
  // pc[x] = custo das fronteiras pontuadas 1..x-1 que ficarem sem pausa
  const pc = [0, 0];
  for (let x = 1; x < n; x++) pc.push(pc[x] + (brk[x - 1] === 2 ? o.skip2 : brk[x - 1] === 1 ? o.skip1 : 0));
  const reward = x => (x >= n ? 0 : brk[x - 1] === 2 ? -o.r2 : brk[x - 1] === 1 ? -o.r1 : o.r0);
  const INF = 1e9;
  const best = Array.from({ length: K + 2 }, () => new Float64Array(n + 1).fill(INF));
  const from = Array.from({ length: K + 2 }, () => new Int32Array(n + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= K + 1; j++) {
    const xs = j === K + 1 ? [n] : Array.from({ length: n - 1 }, (_, k) => k + 1);
    for (const x of xs) {
      let bv = INF, bf = -1;
      for (let jp = 0; jp < j; jp++) {
        const D = vAt[j] - vAt[jp];
        const skipped = skipG[j - 1] - skipG[jp];
        for (let xp = jp === 0 ? 0 : 1; xp < x; xp++) {
          const prev = best[jp][xp];
          if (prev >= INF) continue;
          if (jp === 0 && xp !== 0) continue;
          const W = (cum[x] - cum[xp]) * rate;
          const e = D - W;
          const c = prev + (e * e) / (o.sigma * o.sigma * Math.max(W, 0.3)) + skipped + (pc[x] - pc[xp + 1]);
          if (c < bv) { bv = c; bf = jp * (n + 1) + xp; }
        }
      }
      if (bf >= 0) { best[j][x] = bv + reward(x); from[j][x] = bf; }
    }
  }
  // volta pelo caminho: quais pausas ficaram com qual fronteira
  const anchor = new Map(); // fronteira -> pausa
  for (let j = K + 1, x = n; j > 0;) {
    const f = from[j][x];
    if (f < 0) break;
    const jp = Math.floor(f / (n + 1)), xp = f % (n + 1);
    if (jp > 0) anchor.set(xp, gaps[jp - 1]);
    j = jp; x = xp;
  }
  const ks = [0, ...[...anchor.keys()].sort((p, q) => p - q), n];
  const vk = k => (k === 0 ? 0 : k === n ? V : voiced(anchor.get(k).start));
  const bounds = new Array(n + 1);
  for (let s = 0; s + 1 < ks.length; s++) {
    const lo = ks[s], hi = ks[s + 1], vlo = vk(lo), vhi = vk(hi);
    for (let i = lo + 1; i < hi; i++) {
      const t = real(vlo + ((cum[i] - cum[lo]) * (vhi - vlo)) / (cum[hi] - cum[lo] || 1));
      bounds[i] = { s: t, e: t };
    }
  }
  bounds[0] = { s: a, e: a };
  bounds[n] = { s: b, e: b };
  for (const [k, g] of anchor) bounds[k] = { s: g.start, e: g.end };
  return bounds;
}

// weights: tamanho (letras) de cada mishna. Devolve n+1 cortes [0, ..., duração].
export function autoCuts(buf, weights) {
  const { gaps, vStart, vEnd } = findGaps(buf);
  const n = weights.length;
  const cutAt = g => Math.max(g.start, g.end - 0.25);
  // Se exatamente n-1 pausas se destacam como bem mais longas, são elas.
  if (n > 1) {
    const inner = gaps.filter(g => g.start > vStart && g.end < vEnd);
    const byLen = inner.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const len = g => (g ? g.end - g.start : 0);
    if (byLen.length >= n - 1 && len(byLen[n - 2]) >= 0.6 && len(byLen[n - 2]) >= 1.6 * len(byLen[n - 1])) {
      return [0, ...byLen.slice(0, n - 1).sort((a, b) => a.start - b.start).map(cutAt), buf.duration];
    }
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const D = Math.max(1, vEnd - vStart);
  const win = Math.max(3, (D / n) * 0.45);
  const cuts = [0];
  let prev = vStart, cum = 0;
  for (let k = 1; k < n; k++) {
    cum += weights[k - 1];
    const T = vStart + (D * cum) / total;
    let best = null, bestScore = -1e9;
    for (const g of gaps) {
      const c = (g.start + g.end) / 2;
      if (c <= prev + 1) continue;
      const d = Math.abs(c - T);
      if (d > win) continue;
      const score = Math.min(g.end - g.start, 1.5) - 0.8 * (d / win);
      if (score > bestScore) { bestScore = score; best = g; }
    }
    const cut = best ? cutAt(best) : T;
    cuts.push(cut);
    prev = cut;
  }
  cuts.push(buf.duration);
  return cuts;
}

// Ajusta cortes marcados com toque para a pausa mais próxima (até `radius` segundos).
export function snapCuts(buf, cuts, radius = 1.5) {
  const { gaps } = findGaps(buf);
  return cuts.map((c, i) => {
    if (i === 0 || i === cuts.length - 1) return c;
    let best = null, bestScore = -1e9;
    for (const g of gaps) {
      const d = Math.min(Math.abs(g.end - c), Math.abs(g.start - c), c > g.start && c < g.end ? 0 : 1e9);
      if (d > radius) continue;
      const score = Math.min(g.end - g.start, 1.5) - d / radius;
      if (score > bestScore) { bestScore = score; best = g; }
    }
    return best ? Math.max(best.start, best.end - 0.25) : c;
  });
}
