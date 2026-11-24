// Texto da Mishna (Sefaria, versão Torat Emet com nikud), normalização e numeração hebraica
import * as db from './db.js';

export async function chapterText(tr, ch) {
  const key = `${tr.id}.${ch}`;
  const cached = await db.get('texts', key);
  if (cached) return cached;
  const url = `https://www.sefaria.org/api/v3/texts/${encodeURIComponent(tr.id)}.${ch}?version=hebrew`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Não consegui baixar o texto da Sefaria (' + r.status + ')');
  const j = await r.json();
  const v = (j.versions || [])[0];
  if (!v || !Array.isArray(v.text)) throw new Error('Texto não encontrado na Sefaria');
  const text = v.text.map(s => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  await db.put('texts', key, text);
  return text;
}

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Forma "esqueleto" de uma palavra para comparar com o reconhecimento de voz:
// sem nikud, sem letras finais, e sem ו/י no meio (escrita plena x defectiva).
export function normWord(w) {
  let s = w.replace(/[֑-ׇ]/g, '').replace(/[^א-ת]/g, '').replace(/[ךםןףץ]/g, c => FINALS[c]);
  if (s.length > 2) s = s[0] + s.slice(1).replace(/[וי]/g, '');
  return s;
}

// Divide a mishna em palavras para mostrar e comparar. end=true marca fim de frase.
export function tokenize(text) {
  return text.replace(/־/g, '־ ').split(/\s+/).filter(Boolean)
    .map(disp => ({ disp, norm: normWord(disp), end: /[.,:;?!׃]$/.test(disp) }))
    .filter(t => t.norm);
}

export function letters(text) {
  return tokenize(text).reduce((n, t) => n + t.norm.length + 1, 0);
}

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNS = ['', 'ק', 'ר', 'ש', 'ת'];
export function gem(n) {
  let s = HUNS[Math.floor(n / 100)] || '';
  n %= 100;
  if (n === 15) return s + 'טו';
  if (n === 16) return s + 'טז';
  return s + TENS[Math.floor(n / 10)] + ONES[n % 10];
}
