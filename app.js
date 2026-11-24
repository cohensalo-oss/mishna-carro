import { TRACTATES } from './data.js';
import * as db from './db.js';
import { chapterText, tokenize, letters, gem } from './text.js';
import * as A from './audio.js';
import { listen, compare, splitParts, phraseAround, speechSupported } from './shinun.js';
import * as L from './lesson.js';

const app = document.getElementById('app');
const dock = document.getElementById('dock');
const dockExtra = document.getElementById('dock-extra');
const byId = Object.fromEntries(TRACTATES.map(t => [t.id, t]));

const DEFAULTS = { repeats: 3, shinun: true, parts: true, threshold: 80, attempts: 4, lesson: true, lessonRate: 1, advance: true };
let settings = { ...DEFAULTS };

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const $ = sel => app.querySelector(sel);
const $$ = sel => [...app.querySelectorAll(sel)];
const chKey = (tid, ch) => `${tid}.${ch}`;
const title = (tr, ch, m) => `${tr.he} ${gem(ch)}${m ? ':' + gem(m) : ''}`;

let toastT;
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

function go(hash) { location.hash = hash; }

function showDock(on) {
  dock.hidden = !on;
  document.body.classList.toggle('docked', on);
}

// Limpeza da tela anterior (para gravação, sessão no carro etc.)
let cleanup = [];
function onLeave(fn) { cleanup.push(fn); }

async function route() {
  const fns = cleanup; cleanup = [];
  for (const f of fns) { try { await f(); } catch {} }
  showDock(false);
  dockExtra.innerHTML = '';
  const [view, ...args] = (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(decodeURIComponent);
  const views = { home, upload, record, review, study, chapter, car, settings: settingsView };
  try {
    await (views[view] || home)(...args);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="top"><button class="back" onclick="history.back()">›</button><h1>שגיאה</h1></div>
      <div class="card warn"><p>${esc(e.message || e)}</p></div>`;
  }
  window.scrollTo(0, 0);
}

function header(text, back = '#/') {
  return `<div class="top"><button class="back" data-href="${back}" aria-label="חזרה">›</button><h1>${text}</h1></div>`;
}

app.addEventListener('click', e => {
  const b = e.target.closest('[data-href]');
  if (b) go(b.dataset.href);
});

// ---------------- início ----------------
async function home() {
  const chapters = await db.chapterList();
  app.innerHTML = `
    <h1 style="margin-top:18px">משנה בדרך</h1>
    <p class="muted">הקריאה שלך, שינון, והשיעור של משנה יומית.</p>
    <div class="home-cards">
      <button class="home-card main" data-href="#/study"><b>🚗 לימוד ברכב</b><span>${chapters.length ? (chapters.length === 1 ? 'פרק אחד מוקלט' : chapters.length + ' פרקים מוקלטים') : 'קודם מקליטים פרק'}</span></button>
      <button class="home-card" data-href="#/upload"><b>🎙️ הקלטת פרק</b><span>קוראים פרק, והאפליקציה מחלקת אותו למשניות</span></button>
      <button class="home-card" data-href="#/settings"><b>⚙️ הגדרות</b><span>חזרות, שינון, גיבוי</span></button>
    </div>
    ${speechSupported ? '' : '<div class="card warn small">בדפדפן הזה אין זיהוי דיבור, ולכן השינון כבוי. באנדרואיד פתחו את האפליקציה ב־Chrome.</div>'}`;
}

// ---------------- escolher capítulo para gravar ----------------
function tractateOptions(sel) {
  let html = '', seder = '';
  for (const t of TRACTATES) {
    if (t.seder !== seder) { if (seder) html += '</optgroup>'; seder = t.seder; html += `<optgroup label="${esc(seder)}">`; }
    html += `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.he)}</option>`;
  }
  return html + '</optgroup>';
}

async function upload() {
  const last = (await db.get('kv', 'lastUpload')) || { tid: 'Mishnah_Berakhot', ch: 1 };
  app.innerHTML = `${header('הקלטת פרק')}
    <label class="field"><span>מסכת</span><select id="tr">${tractateOptions(last.tid)}</select></label>
    <label class="field"><span>פרק</span><select id="ch"></select></label>
    <div id="info" class="muted small"></div>
    <div class="spacer"></div>
    <button class="big primary" id="rec">🎙️ הקלטה עכשיו</button>
    <div class="spacer"></div>
    <button class="big" id="file">📁 העלאת קובץ שמע</button>
    <input type="file" id="fileIn" accept="audio/*,.m4a,.mp3,.aac,.wav,.ogg,.opus,.webm" hidden>
    <p class="muted small">בהקלטה כאן לוחצים "המשנה הבאה" כשמתחילים כל משנה, והחיתוך מדויק.
      בהעלאת קובץ האפליקציה מחפשת את ההפסקות בין המשניות, ואפשר לתקן אחר כך.</p>`;
  const trSel = $('#tr'), chSel = $('#ch');
  const fillCh = async keep => {
    const tr = byId[trSel.value];
    chSel.innerHTML = tr.ch.map((n, i) => `<option value="${i + 1}">פרק ${gem(i + 1)} · ${n} משניות</option>`).join('');
    if (keep) chSel.value = String(Math.min(keep, tr.ch.length));
    await info();
  };
  const info = async () => {
    const have = await db.get('chapters', chKey(trSel.value, chSel.value));
    $('#info').textContent = have ? '⚠️ הפרק הזה כבר מוקלט. הקלטה חדשה תחליף את הקודמת.' : '';
  };
  trSel.onchange = () => fillCh(1);
  chSel.onchange = info;
  await fillCh(last.ch);
  const remember = () => db.put('kv', 'lastUpload', { tid: trSel.value, ch: +chSel.value });
  $('#rec').onclick = async () => { await remember(); go(`#/record/${trSel.value}/${chSel.value}`); };
  $('#file').onclick = () => $('#fileIn').click();
  $('#fileIn').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    await remember();
    pendingUpload = { blob: f, tid: trSel.value, ch: +chSel.value, source: 'file' };
    go(`#/review/${trSel.value}/${chSel.value}/new`);
  };
}

// gravação ou arquivo ainda não salvos, passados para a tela de revisão
let pendingUpload = null;

// ---------------- gravar no app ----------------
async function record(tid, ch) {
  const tr = byId[tid]; ch = +ch;
  app.innerHTML = `${header(title(tr, ch), '#/upload')}<p class="muted">טוען את הטקסט…</p>`;
  const text = await chapterText(tr, ch);
  let cur = 0, rec = null, marks = [], tick;
  const draw = () => {
    const recording = !!rec;
    app.innerHTML = `${header(title(tr, ch), '#/upload')}
      <div class="row"><span class="timer" id="timer">${recording ? '<span class="rec-dot"></span> ' : ''}${fmt(rec ? rec.elapsed() : 0)}</span>
        <span class="grow"></span><span class="muted">משנה ${cur + 1} מתוך ${text.length}</span></div>
      <div class="prompter"><div class="label">משנה ${gem(cur + 1)}</div><div class="he">${esc(text[cur])}</div></div>
      ${cur + 1 < text.length ? `<div class="prompter next"><div class="label">הבאה: משנה ${gem(cur + 2)}</div><div class="he">${esc(text[cur + 1])}</div></div>` : ''}
      <div style="position:sticky;bottom:12px;display:grid;gap:10px">
      ${!recording ? `<button class="huge primary" id="start">🎙️ התחלת הקלטה</button>
        <p class="muted small center">מתחילים לקרוא את משנה א. בסוף כל משנה לוחצים "הבאה".</p>` : `
        <button class="huge primary" id="next">${cur + 1 < text.length ? 'המשנה הבאה ‹' : '✓ סיום'}</button>
        <div class="controls">
          <button id="undo" ${cur === 0 ? 'disabled' : ''}>↶<small>אחורה</small></button>
          <button id="pause">${rec.paused() ? '▶' : '⏸'}<small>${rec.paused() ? 'המשך' : 'השהיה'}</small></button>
          <button id="stop" class="danger">✕<small>ביטול</small></button>
        </div>`}
      </div>`;
    $('#start')?.addEventListener('click', start);
    $('#next')?.addEventListener('click', next);
    $('#undo')?.addEventListener('click', () => { marks.pop(); cur--; draw(); });
    $('#pause')?.addEventListener('click', () => { rec.paused() ? rec.resume() : rec.pause(); draw(); });
    $('#stop')?.addEventListener('click', async () => {
      if (!confirm('למחוק את ההקלטה הזאת?')) return;
      await rec.stop(); rec = null; go('#/upload');
    });
  };
  const start = async () => {
    try {
      A.ac();
      rec = await A.startRecorder();
    } catch (e) {
      toast('אין גישה למיקרופון: ' + e.message, 5000);
      return;
    }
    await wake(true);
    tick = setInterval(() => { const t = document.getElementById('timer'); if (t && rec) t.innerHTML = '<span class="rec-dot"></span> ' + fmt(rec.elapsed()); }, 250);
    draw();
  };
  const next = async () => {
    if (cur + 1 < text.length) {
      marks.push(rec.elapsed());
      cur++;
      draw();
      return;
    }
    clearInterval(tick);
    const total = rec.elapsed();
    const blob = await rec.stop();
    rec = null;
    pendingUpload = { blob, tid, ch, source: 'rec', marks: [0, ...marks, total] };
    go(`#/review/${tid}/${ch}/new`);
  };
  onLeave(async () => { clearInterval(tick); if (rec) await rec.stop(); await wake(false); });
  draw();
}

// ---------------- revisar cortes ----------------
async function review(tid, ch, mode) {
  const tr = byId[tid]; ch = +ch;
  const back = mode === 'new' ? '#/upload' : `#/chapter/${tid}/${ch}`;
  app.innerHTML = `${header('כיוון חיתוכים · ' + title(tr, ch), back)}<p class="muted">מכין את השמע…</p>`;
  const text = await chapterText(tr, ch);
  let blob, cuts, isNew = mode === 'new';
  if (isNew) {
    if (!pendingUpload || pendingUpload.tid !== tid || pendingUpload.ch !== ch) { go('#/upload'); return; }
    blob = pendingUpload.blob;
  } else {
    const rec = await db.get('chapters', chKey(tid, ch));
    if (!rec) { go('#/study'); return; }
    blob = rec.audio;
    cuts = rec.cuts;
  }
  let buf;
  try { buf = await A.decode(blob); } catch (e) { throw new Error('לא הצלחתי לקרוא את קובץ השמע. נסו MP3 או M4A. (' + e.message + ')'); }
  if (isNew) {
    if (pendingUpload.source === 'rec') {
      const m = pendingUpload.marks.slice();
      m[m.length - 1] = buf.duration;
      cuts = A.snapCuts(buf, m.map(t => Math.min(t, buf.duration)));
    } else {
      cuts = A.autoCuts(buf, text.map(letters));
    }
  }
  let playing = null;
  const stopPlay = () => { playing?.abort(); playing = null; };
  const play = async (a, b) => {
    stopPlay();
    const ctl = new AbortController();
    playing = ctl;
    await A.playRange(buf, a, b, ctl.signal);
    if (playing === ctl) playing = null;
  };
  onLeave(stopPlay);
  const draw = () => {
    app.innerHTML = `${header('כיוון חיתוכים · ' + title(tr, ch), back)}
      <p class="muted small">${isNew && pendingUpload.source === 'file' ? 'החיתוכים נקבעו לפי ההפסקות בקריאה. ' : ''}לחצו ▶ כדי לשמוע כל משנה. אם ההתחלה לא במקום, תקנו בכפתורים ושמעו שוב ("▶ התחלה" משמיע רק את השניות הראשונות).</p>
      ${text.map((t, i) => `
        <div class="cut">
          <div class="row"><b class="he" style="font-size:22px;color:var(--accent)">משנה ${gem(i + 1)}</b><span class="grow"></span>
            <span class="muted small">${fmt(cuts[i])} – ${fmt(cuts[i + 1])}</span>
            <button data-play="${i}">▶</button></div>
          <div class="he">${esc(t)}</div>
          ${i > 0 ? `<div class="nudge">
            <button data-n="${i}" data-d="-1">−1 שנ׳</button><button data-n="${i}" data-d="-0.25">−¼ שנ׳</button>
            <button data-n="${i}" data-d="0.25">+¼ שנ׳</button><button data-n="${i}" data-d="1">+1 שנ׳</button>
          </div><div class="row" style="margin-top:6px"><button class="ghost small" data-head="${i}">▶ התחלה</button></div>` : ''}
        </div>`).join('')}
      <div class="spacer"></div>
      <button class="big primary" id="save">✓ שמירת הפרק</button>`;
    $$('[data-play]').forEach(b => b.onclick = () => { const i = +b.dataset.play; play(cuts[i], cuts[i + 1]); });
    $$('[data-head]').forEach(b => b.onclick = () => { const i = +b.dataset.head; play(cuts[i], cuts[i] + 3); });
    $$('[data-n]').forEach(b => b.onclick = () => {
      const i = +b.dataset.n;
      cuts[i] = Math.min(cuts[i + 1] - 0.3, Math.max(cuts[i - 1] + 0.3, cuts[i] + +b.dataset.d));
      const y = window.scrollY; draw(); window.scrollTo(0, y);
      play(cuts[i], cuts[i] + 3);
    });
    $('#save').onclick = async () => {
      stopPlay();
      await db.put('chapters', chKey(tid, ch), {
        key: chKey(tid, ch), tid, ch, cuts, audio: blob, mime: blob.type, n: text.length,
        created: isNew ? Date.now() : undefined, updated: Date.now(),
      });
      navigator.storage?.persist?.();
      pendingUpload = null;
      toast('הפרק נשמר ✓');
      go(`#/chapter/${tid}/${ch}`);
    };
  };
  draw();
}

// ---------------- lista para estudar ----------------
async function study() {
  const chapters = await db.chapterList();
  const order = Object.fromEntries(TRACTATES.map((t, i) => [t.id, i]));
  chapters.sort((a, b) => order[a.tid] - order[b.tid] || a.ch - b.ch);
  const groups = {};
  for (const c of chapters) (groups[c.tid] ||= []).push(c);
  app.innerHTML = `${header('לימוד')}
    ${chapters.length ? '' : '<div class="card"><p>עוד לא הוקלט אף פרק.</p><button class="primary" data-href="#/upload">🎙️ הקלטת הפרק הראשון</button></div>'}
    ${Object.entries(groups).map(([tid, list]) => `
      <h2 class="he" style="text-align:start">${esc(byId[tid].he)}</h2>
      <div class="list">${list.map(c => `
        <button class="item" data-href="#/chapter/${tid}/${c.ch}">
          <span class="num">${gem(c.ch)}</span><span class="grow">פרק ${gem(c.ch)}</span><span class="chip">${c.n} משניות</span>
        </button>`).join('')}</div>`).join('')}`;
}

// ---------------- capítulo ----------------
async function chapter(tid, ch) {
  const tr = byId[tid]; ch = +ch;
  const rec = await db.get('chapters', chKey(tid, ch));
  if (!rec) { go('#/study'); return; }
  let lessons = [], lessonErr = '';
  try {
    lessons = await Promise.all(rec.cuts.slice(0, -1).map(async (_, i) => {
      const l = await L.lessonOf(tr, ch, i + 1);
      if (!l) return null;
      const marks = await L.getMarks(l.id);
      return { ...l, exact: marks[ch + ':' + (i + 1)] != null };
    }));
  } catch (e) { lessonErr = e.message; }
  const lessonInfo = i => { const l = lessons[i]; return l ? `שיעור ${l.n}${l.exact ? ' ✓' : ''}` : ''; };
  app.innerHTML = `${header(title(tr, ch), '#/study')}
    <button class="huge primary" data-href="#/car/${tid}/${ch}/1">🚗 מתחילים מההתחלה</button>
    <h2>בחירת משנה</h2>
    <div class="mgrid">${rec.cuts.slice(0, -1).map((_, i) => `
      <button data-href="#/car/${tid}/${ch}/${i + 1}">${gem(i + 1)}<small>${lessonInfo(i)}</small></button>`).join('')}</div>
    <div class="spacer"></div>
    ${lessonErr ? `<p class="muted small">${esc(lessonErr)}</p>` : lessons.some(Boolean) ? '' : '<p class="muted small">לא מצאתי באתר משנה יומית שיעורים לפרק הזה, ולכן ברכב יהיו רק הקריאה והשינון.</p>'}
    <div class="row">
      <button data-href="#/review/${tid}/${ch}/edit">✂️ כיוון חיתוכים</button>
      <button data-href="#/record/${tid}/${ch}">🎙️ הקלטה מחדש</button>
      <button class="danger" id="del">🗑 מחיקה</button>
    </div>`;
  $('#del').onclick = async () => {
    if (!confirm(`למחוק את ההקלטה של ${title(tr, ch)}? אי אפשר לבטל את זה.`)) return;
    await db.del('chapters', chKey(tid, ch));
    go('#/study');
  };
}

// ---------------- tela acordada ----------------
let wakeLock = null, wantWake = false;
async function wake(on) {
  wantWake = on;
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantWake) wake(true); });

// ---------------- modo carro ----------------
async function car(tid, ch, m) {
  const tr = byId[tid];
  let pos = { ch: +ch, m: +m };
  let chap = null, buf = null, text = null;
  let stageCtl = null;          // aborta a etapa atual (pular)
  let sessionOver = false;
  let paused = false, resumeWait = null;
  let skipTo = null;            // 'repeat' | 'next' | 'prev'

  app.innerHTML = `<div class="car">
    <div class="top"><button class="back" id="exit" aria-label="יציאה">›</button><h1 id="ttl" class="he" style="text-align:start"></h1>
      <button class="ghost small" id="adj" title="כיוון השיעור">🎧 כיוון</button></div>
    <div class="progress"><div id="prog"></div></div>
    <div class="stage" id="stage">…</div>
    <div class="mtext" id="mtext"></div>
    <div class="heard" id="heard"></div>
    <div class="controls car-controls">
      <button id="bPrev">⏮<small>משנה קודמת</small></button>
      <button id="bPause">⏸<small>השהיה</small></button>
      <button id="bSkip">⏭<small>דילוג על שלב</small></button>
    </div>
    <button class="big" id="bNext">המשנה הבאה ‹</button>
  </div>`;
  const stageEl = $('#stage'), textEl = $('#mtext'), heardEl = $('#heard'), prog = $('#prog');
  const setStage = (cls, msg) => { stageEl.className = 'stage ' + cls; stageEl.textContent = msg; };
  let tokens = [];
  const paint = (range, okArr) => {
    textEl.innerHTML = tokens.map((t, i) => {
      let c = 'w';
      if (okArr) c += okArr[i] === undefined ? ' dim' : okArr[i] ? ' ok' : ' miss';
      else if (range && (i < range[0] || i >= range[1])) c += ' dim';
      else if (range) c += ' cur';
      return `<span class="${c}">${esc(t.disp)}</span>`;
    }).join(' ');
  };

  const waitIfPaused = async () => { while (paused && !sessionOver) await new Promise(r => (resumeWait = r)); };
  const newStage = () => { stageCtl = new AbortController(); return stageCtl.signal; };
  const setPaused = p => {
    paused = p;
    $('#bPause').innerHTML = p ? '▶<small>המשך</small>' : '⏸<small>השהיה</small>';
    if (p) { A.ac().suspend(); L.pause(); stageCtl?.abort('pause'); }
    else { A.ac().resume(); resumeWait?.(); }
  };

  $('#exit').onclick = () => go(`#/chapter/${tid}/${pos.ch}`);
  $('#bPause').onclick = () => setPaused(!paused);
  $('#bSkip').onclick = () => { if (paused) setPaused(false); stageCtl?.abort('skip'); };
  $('#bNext').onclick = () => { skipTo = 'next'; if (paused) setPaused(false); stageCtl?.abort('jump'); };
  $('#bPrev').onclick = () => { skipTo = 'prev'; if (paused) setPaused(false); stageCtl?.abort('jump'); };
  $('#adj').onclick = () => openCalibration();

  onLeave(async () => { sessionOver = true; stageCtl?.abort('exit'); resumeWait?.(); L.pause(); A.ac().resume(); await wake(false); });
  A.ac();
  await wake(true);
  setupMediaSession();

  async function loadChapter(c) {
    if (chap && chap.ch === c) return true;
    const r = await db.get('chapters', chKey(tid, c));
    if (!r) return false;
    chap = r;
    buf = await A.decode(r.audio);
    text = await chapterText(tr, c);
    return true;
  }

  // segundos de cada palavra dentro da gravação (proporcional ao tamanho)
  const wordTime = (seg, w) => {
    const [a, b] = seg;
    let total = 0, upto = 0;
    tokens.forEach((t, i) => { const l = t.norm.length + 1; if (i < w) upto += l; total += l; });
    return a + ((b - a) * upto) / total;
  };
  const playWords = (seg, w0, w1, signal) =>
    A.playRange(buf, Math.max(seg[0], wordTime(seg, w0) - 0.35), Math.min(seg[1], wordTime(seg, w1) + 0.35), signal);

  // ---- uma unidade de שינון (parte ou mishna inteira) ----
  async function drill(seg, [w0, w1], label, playFirst) {
    const unitTokens = tokens.slice(w0, w1);
    const unitDur = wordTime(seg, w1) - wordTime(seg, w0);
    for (let attempt = 1; attempt <= settings.attempts; attempt++) {
      await waitIfPaused();
      if (sessionOver || skipTo) return;
      let signal = newStage();
      if (playFirst && attempt === 1) {
        setStage('listen', `הקשיבו: ${label}`);
        paint([w0, w1]);
        await playWords(seg, w0, w1, signal);
        if (signal.aborted) { if (signal.reason === 'pause') { attempt--; continue; } if (signal.reason === 'skip') return; return; }
        await A.sleep(400, signal);
      }
      setStage('turn', `תורכם: חזרו על ${label}${attempt > 1 ? ` (ניסיון ${attempt})` : ''}`);
      paint([w0, w1]);
      heardEl.textContent = '';
      await A.cue('turn');
      let heard = '';
      try {
        heard = await listen({ maxMs: unitDur * 1800 + 6000, signal, onText: t => (heardEl.textContent = t) });
      } catch (e) {
        toast(e.message, 5000);
        settings.shinun = false;
        return;
      }
      if (signal.aborted) {
        if (signal.reason === 'pause') { attempt--; continue; }
        return;
      }
      const res = compare(unitTokens, heard);
      const okArr = new Array(tokens.length);
      res.ok.forEach((v, i) => (okArr[w0 + i] = v));
      paint(null, okArr);
      const pct = Math.round(res.score * 100);
      if (!heard) {
        setStage('wrong', 'לא שמעתי כלום. עוד פעם.');
        await A.cue('bad');
        continue;
      }
      if (pct >= settings.threshold && !res.serious) {
        setStage('good', `יפה מאוד! ${pct}%`);
        await A.cue('ok');
        await A.sleep(900, signal);
        return true;
      }
      setStage('wrong', `${pct}%${res.serious ? ' · חסר או הוחלף משהו חשוב' : ''}. הקשיבו לתיקון`);
      await A.cue('bad');
      const miss = w0 + Math.max(0, res.firstMiss);
      const [p0, p1] = phraseAround(tokens, miss);
      signal = newStage();
      paint([p0, Math.min(w1, Math.max(p1, miss + 4))]);
      await playWords(seg, Math.max(w0, p0), Math.min(w1, Math.max(p1, miss + 4)), signal);
      if (signal.aborted && signal.reason !== 'pause') return;
      await A.sleep(500, signal);
    }
    // não chegou lá: ouve mais uma vez e segue
    if (sessionOver || skipTo) return;
    const signal = newStage();
    setStage('listen', `עוד פעם: ${label}`);
    paint([w0, w1]);
    await playWords(seg, w0, w1, signal);
    return false;
  }

  // onde a aula desta mishna começa e termina
  async function lessonSegment(c, i) {
    const lesson = await L.lessonOf(tr, c, i);
    if (!lesson) return null;
    const dur = await L.load(lesson.url);
    const weights = await Promise.all(lesson.members.map(async ([x, y]) => letters((await chapterText(tr, x))[y - 1] || '') || 1));
    const marks = await L.getMarks(lesson.id);
    return { lesson, marks, dur, ...L.segmentTimes(lesson, marks, weights, dur) };
  }

  async function lessonStage(from = null) {
    let s;
    try {
      setStage('lesson', 'טוען את השיעור…');
      s = await lessonSegment(pos.ch, pos.m);
    } catch (e) {
      setStage('wrong', e.message);
      await A.sleep(2500);
      return;
    }
    if (!s) {
      setStage('lesson', 'אין באתר שיעור על המשנה הזאת');
      await A.sleep(1500);
      return;
    }
    const signal = newStage();
    const label = `שיעור ${s.lesson.n}${s.lesson.members.length > 1 ? ` · משנה ${s.lesson.index + 1} מתוך ${s.lesson.members.length}` : ''}${s.exact ? '' : ' (התחלה משוערת)'}`;
    setStage('lesson', label);
    paint(null);
    await L.playSegment(s.lesson.url, from ?? s.start, s.end, {
      signal,
      onBlocked: () => {
        setStage('lesson', '▶ לחצו כאן כדי להשמיע את השיעור');
        stageEl.onclick = () => { stageEl.onclick = null; L.audio.play(); setStage('lesson', label); };
      },
    });
    stageEl.onclick = null;
    if (signal.aborted && signal.reason === 'pause') {
      const at = L.position();
      await waitIfPaused();
      if (!sessionOver && !skipTo) return lessonStage(at);
    }
  }

  async function runMishna() {
    const seg = [chap.cuts[pos.m - 1], chap.cuts[pos.m]];
    tokens = tokenize(text[pos.m - 1]);
    $('#ttl').textContent = title(tr, pos.ch, pos.m);
    prog.style.width = (100 * pos.m / text.length) + '%';
    heardEl.textContent = '';
    updateMediaSession();
    paint(null);
    // 1) ouvir a própria leitura N vezes
    for (let i = 1; i <= settings.repeats; i++) {
      await waitIfPaused();
      if (sessionOver || skipTo) return;
      const signal = newStage();
      setStage('listen', `השמעה ${i} מתוך ${settings.repeats}`);
      paint([0, tokens.length]);
      await A.playRange(buf, seg[0], seg[1], signal);
      if (signal.aborted) { if (signal.reason === 'pause') { i--; continue; } if (signal.reason === 'skip') break; return; }
      await A.sleep(700, signal);
    }
    // 2) שינון
    if (settings.shinun && speechSupported) {
      const parts = settings.parts && tokens.length > 22 ? splitParts(tokens) : [];
      for (let k = 0; k < parts.length; k++) {
        await drill(seg, parts[k], `חלק ${k + 1} מתוך ${parts.length}`, true);
        if (sessionOver || skipTo) return;
      }
      await drill(seg, [0, tokens.length], 'המשנה כולה', false);
      if (sessionOver || skipTo) return;
    }
    // 3) aula
    if (settings.lesson) {
      await waitIfPaused();
      if (sessionOver || skipTo) return;
      await lessonStage();
    }
  }

  // avança para a próxima mishna gravada (inclusive no perek seguinte)
  async function step(dir) {
    if (dir > 0) {
      if (pos.m < chap.cuts.length - 1) { pos.m++; return true; }
      if (await loadChapter(pos.ch + 1)) { pos = { ch: pos.ch + 1, m: 1 }; return true; }
      return false;
    }
    if (pos.m > 1) { pos.m--; return true; }
    if (pos.ch > 1 && await loadChapter(pos.ch - 1)) { pos = { ch: pos.ch - 1, m: chap.cuts.length - 1 }; return true; }
    return true;
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => setPaused(false));
      ms.setActionHandler('pause', () => setPaused(true));
      ms.setActionHandler('nexttrack', () => $('#bNext')?.click());
      ms.setActionHandler('previoustrack', () => $('#bPrev')?.click());
    } catch {}
    onLeave(() => { for (const a of ['play', 'pause', 'nexttrack', 'previoustrack']) try { ms.setActionHandler(a, null); } catch {} });
  }
  function updateMediaSession() {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: title(tr, pos.ch, pos.m), artist: 'משנה בדרך' });
    }
  }

  // calibração da aula (para usar parado)
  async function openCalibration() {
    setPaused(true);
    showDock(true);
    dockExtra.innerHTML = '<div class="card" style="margin:0">טוען את השיעור…</div>';
    let s;
    try { s = await lessonSegment(pos.ch, pos.m); } catch (e) { s = null; toast(e.message, 5000); }
    if (!s) { dockExtra.innerHTML = ''; showDock(false); toast('אין באתר שיעור על המשנה הזאת'); return; }
    const au = L.audio;
    const close = () => { clearInterval(iv); au.pause(); dockExtra.innerHTML = ''; showDock(false); };
    const draw = () => {
      dockExtra.innerHTML = `<div class="card" style="margin:0">
        <div class="row"><b class="grow">שיעור ${s.lesson.n} · ${esc(title(tr, pos.ch, pos.m))}</b><button class="ghost" id="cClose">✕</button></div>
        <p class="small muted">השיעור עוסק ב־${s.lesson.members.map(([c, i]) => esc(title(tr, c, i))).join(', ')}.
          המשנה הזאת מתחילה ב־<bdi>${fmt(s.start)}</bdi>${s.exact ? ' (סומן ✓)' : ' (משוער)'}. הקשיבו ולחצו 📍 כשהרב מתחיל את המשנה הזאת.</p>
        <div class="row"><span class="timer" id="cPos" dir="ltr">${fmt(au.currentTime)} / ${fmt(s.dur)}</span></div>
        <div class="controls" style="margin:8px 0">
          <button id="cBack">−10<small>שניות</small></button>
          <button id="cPlay">${au.paused ? '▶' : '⏸'}<small>${au.paused ? 'השמעה' : 'השהיה'}</small></button>
          <button id="cFwd">+10<small>שניות</small></button>
        </div>
        <div class="row">
          <button class="primary grow" id="cMark">📍 המשנה מתחילה עכשיו</button>
          ${s.exact ? '<button class="ghost" id="cUnmark">ביטול הסימון</button>' : ''}
        </div></div>`;
      const q = sel => dockExtra.querySelector(sel);
      q('#cClose').onclick = close;
      q('#cBack').onclick = () => { au.currentTime = Math.max(0, au.currentTime - 10); };
      q('#cFwd').onclick = () => { au.currentTime = Math.min(s.dur, au.currentTime + 10); };
      q('#cPlay').onclick = () => {
        if (au.paused) {
          if (au.currentTime < 0.5) au.currentTime = Math.max(0, s.start - 3);
          au.play();
        } else au.pause();
        draw();
      };
      q('#cMark').onclick = async () => {
        s.marks[s.key] = au.currentTime;
        await L.setMarks(s.lesson.id, s.marks);
        s.start = au.currentTime;
        s.exact = true;
        toast(`סומן ב־${fmt(au.currentTime)} ✓`);
        draw();
      };
      q('#cUnmark')?.addEventListener('click', async () => {
        delete s.marks[s.key];
        await L.setMarks(s.lesson.id, s.marks);
        s = await lessonSegment(pos.ch, pos.m);
        draw();
      });
    };
    au.pause();
    au.currentTime = Math.max(0, s.start - 3);
    const iv = setInterval(() => { const el = dockExtra.querySelector('#cPos'); if (el) el.textContent = `${fmt(au.currentTime)} / ${fmt(s.dur)}`; }, 300);
    onLeave(() => clearInterval(iv));
    draw();
  }

  // ---- laço principal ----
  if (!(await loadChapter(pos.ch))) { go('#/study'); return; }
  while (!sessionOver) {
    skipTo = null;
    await runMishna();
    if (sessionOver) break;
    if (skipTo === 'prev') { await step(-1); continue; }
    if (skipTo === 'next' || settings.advance) {
      if (await step(1)) { await A.cue('next'); continue; }
      setStage('good', 'סיימתם את הפרקים המוקלטים. כל הכבוד!');
      break;
    }
    setStage('good', 'המשנה הסתיימה ✓ · ⏭ הבאה · ⏸ חזרה');
    // espera o usuário escolher
    const sig = newStage();
    await new Promise(r => sig.addEventListener('abort', r, { once: true }));
    if (sessionOver) break;
    if (skipTo === 'prev') await step(-1);
    else if (skipTo === 'next' || sig.reason === 'skip') { if (!(await step(1))) break; }
    await waitIfPaused(); // ⏸ e depois ▶ = repetir esta mishna
  }
}

// ---------------- configurações ----------------
async function settingsView() {
  const s = settings;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  app.innerHTML = `${header('הגדרות')}
    <label class="field"><span>כמה פעמים לשמוע את הקריאה שלך</span>
      <select id="repeats">${[1, 2, 3, 4, 5].map(n => `<option ${n === s.repeats ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="switch"><span>שינון בעל פה<small>האפליקציה מקשיבה לחזרה שלך ומתקנת</small></span><input type="checkbox" id="shinun" ${s.shinun ? 'checked' : ''}></label>
    <label class="switch"><span>שינון בחלקים<small>במשנה ארוכה: קודם כל קטע, ואחר כך הכול</small></span><input type="checkbox" id="parts" ${s.parts ? 'checked' : ''}></label>
    <label class="field"><span>אחוז הצלחה מינימלי למעבר</span>
      <select id="threshold">${[50, 60, 70, 75, 80, 85, 90].map(n => `<option ${n === s.threshold ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>מספר ניסיונות בשינון</span>
      <select id="attempts">${[1, 2, 3, 4, 5, 6, 8].map(n => `<option ${n === s.attempts ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="switch"><span>שיעור משנה יומית<small>משמיע את השיעור אחרי השינון</small></span><input type="checkbox" id="lesson" ${s.lesson ? 'checked' : ''}></label>
    <label class="field"><span>מהירות השיעור</span>
      <select id="lessonRate">${[1, 1.25, 1.5, 1.75, 2].map(n => `<option value="${n}" ${n === s.lessonRate ? 'selected' : ''}>×${n}</option>`).join('')}</select></label>
    <label class="switch"><span>המשך אוטומטי<small>בסוף עוברים לבד למשנה הבאה</small></span><input type="checkbox" id="advance" ${s.advance ? 'checked' : ''}></label>
    <h2>בדיקת זיהוי הדיבור</h2>
    <button id="test">🎤 אמרו משפט</button>
    <div class="heard" id="heard" style="margin-top:8px"></div>
    <h2>גיבוי</h2>
    <p class="muted small">ההקלטות שמורות רק בטלפון הזה${est ? ` (בשימוש ${(est.usage / 1e6).toFixed(0)} MB)` : ''}. כדאי לגבות מדי פעם.</p>
    <div class="row"><button id="exp">⬇️ ייצוא גיבוי</button><button id="imp">⬆️ ייבוא גיבוי</button>
      <input type="file" id="impIn" accept=".json,application/json" hidden></div>
    <p class="muted small" style="margin-top:24px">נוסח המשנה: ספריא (תורת אמת). השיעורים: <a href="https://ecohen100-collab.github.io/mishna-yomit/" target="_blank" rel="noopener">משנה יומית</a>.</p>`;
  const save = async () => { await db.put('kv', 'settings', settings); };
  for (const k of ['repeats', 'threshold', 'attempts', 'lessonRate']) $('#' + k).onchange = e => { settings[k] = +e.target.value; L.setRate(settings.lessonRate); save(); };
  for (const k of ['shinun', 'parts', 'lesson', 'advance']) $('#' + k).onchange = e => { settings[k] = e.target.checked; save(); };
  $('#test').onclick = async () => {
    $('#heard').textContent = '…';
    try {
      const t = await listen({ onText: x => ($('#heard').textContent = x) });
      $('#heard').textContent = t || '(לא שמעתי כלום)';
    } catch (e) { $('#heard').textContent = e.message; }
  };
  $('#exp').onclick = exportBackup;
  $('#imp').onclick = () => $('#impIn').click();
  $('#impIn').onchange = e => e.target.files[0] && importBackup(e.target.files[0]);
}

const b64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

async function exportBackup() {
  toast('מכין גיבוי…');
  const chapters = [];
  for (const [, c] of await db.entries('chapters')) chapters.push({ ...c, audio: await b64(c.audio) });
  const kv = Object.fromEntries((await db.entries('kv')).filter(([k]) => k !== 'lastUpload'));
  const blob = new Blob([JSON.stringify({ app: 'mishna-carro', v: 1, chapters, kv })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mishna-carro-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'mishna-carro') throw new Error('הקובץ הזה אינו גיבוי של האפליקציה');
    if (!confirm(`לייבא ${data.chapters.length} פרקים? פרקים שכבר קיימים יוחלפו.`)) return;
    for (const c of data.chapters) {
      const audio = await (await fetch(c.audio)).blob();
      await db.put('chapters', c.key, { ...c, audio });
    }
    for (const [k, v] of Object.entries(data.kv || {})) await db.put('kv', k, v);
    settings = { ...DEFAULTS, ...((await db.get('kv', 'settings')) || {}) };
    toast('הגיבוי יובא ✓');
    route();
  } catch (e) { toast('שגיאה: ' + e.message, 5000); }
}

// ---------------- iniciar ----------------
(async () => {
  settings = { ...DEFAULTS, ...((await db.get('kv', 'settings')) || {}) };
  L.setRate(settings.lessonRate);
  L.site().catch(() => {}); // já busca a tabela de aulas
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
