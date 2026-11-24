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
// Encontra pausas (silêncio) na gravação.
export function findGaps(buf) {
  const hop = 0.02;
  const x = buf.getChannelData(0);
  const step = Math.round(buf.sampleRate * hop);
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
  const thr = lo + 0.3 * (hi - lo);
  const gaps = [];
  let run = -1, vStart = -1, vEnd = 0;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && e[i] < thr;
    if (i < n && !quiet) { if (vStart < 0) vStart = i; vEnd = i; }
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      if ((i - run) * hop >= 0.2) gaps.push({ start: run * hop, end: i * hop });
      run = -1;
    }
  }
  return { gaps, vStart: Math.max(0, vStart) * hop, vEnd: (vEnd + 1) * hop };
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
