"""Finds where each mishna starts inside the משנה יומית lessons, writes lessons.json.

At the start of each mishna the rabbi announces it: "משנה ב'", "משנה ג'" (and sometimes "פרק ו'").
This script transcribes the lesson audio with Whisper (ivrit-ai) and looks for those announcements.

    python tools/lesson_marks.py ברכות            # one masechet
    python tools/lesson_marks.py ברכות שבת --limit 20
    python tools/lesson_marks.py --all --limit 40 # next 40 lessons not done yet

lessons.json = { "<drive file id>": { "c:i": seconds, ..., "_": number of mishnayot found } }
"""
import argparse, json, math, os, re, sys, time, urllib.request

SITE = 'https://ecohen100-collab.github.io/mishna-yomit/'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'lessons.json')

ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט']
TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ']
def gem(n):
    if n == 15: return 'טו'
    if n == 16: return 'טז'
    return TENS[n // 10] + ONES[n % 10]

NAMES = {1: 'אלף', 2: 'בית', 3: 'גימל גמל', 4: 'דלת דלד', 5: 'הא הי', 6: 'וו ואו', 7: 'זין זיין', 8: 'חית חת',
         9: 'טית טת', 10: 'יוד יוד', 11: 'יא', 12: 'יב'}
ORD = {1: 'ראשונה', 2: 'שנייה שניה', 3: 'שלישית', 4: 'רביעית', 5: 'חמישית', 6: 'שישית', 7: 'שביעית', 8: 'שמינית',
       9: 'תשיעית', 10: 'עשירית'}

ORD_M = {1: 'ראשון', 2: 'שני', 3: 'שלישי', 4: 'רביעי', 5: 'חמישי', 6: 'שישי', 7: 'שביעי', 8: 'שמיני',
         9: 'תשיעי', 10: 'עשירי'}

def clean(w):
    return re.sub(r'[^א-ת0-9]', '', w)

def forms(n):
    f = {gem(n), str(n)}
    f.update(NAMES.get(n, '').split())
    f.update(ORD.get(n, '').split())
    f.update(ORD_M.get(n, '').split())
    return {x for x in f if x}

def site():
    html = urllib.request.urlopen(SITE).read().decode('utf-8')
    a = html.index('const SEDARIM = ')
    b = html.index(';\n', a)
    sed = json.loads(html[a + 16:b])
    key = re.search(r"DRIVE_KEY\s*=\s*['\"]([^'\"]+)", html).group(1)
    return [m for s in sed for m in s['m']], key

def lessons_of(m):
    """[(lesson number, drive id, [(c, i), ...])]"""
    ln = lambda j: math.ceil((m['off'] + j) / 3) - math.ceil((m['off'] + 1) / 3) + 1
    out = {}
    j = 0
    for c, cnt in enumerate(m['ch'], 1):
        for i in range(1, cnt + 1):
            j += 1
            out.setdefault(ln(j), []).append((c, i))
    return [(n, m['a'][n - 1], mem) for n, mem in sorted(out.items()) if n - 1 < len(m.get('a') or [])]

def find_marks(segments, members):
    """segments: iterator of (start, end, text). Returns {"c:i": t}. Stops when all are found."""
    marks, k = {}, 0
    for s0, s1, text in segments:
        words = text.split()
        for p, w in enumerate(words):
            cw = clean(w)
            if cw not in ('משנה', 'פרק') or p + 1 >= len(words):
                continue
            nxt = clean(words[p + 1])
            # the announcement can be for this mishna or (if one was missed) a later one
            for q in range(k, len(members)):
                c, i = members[q]
                ok = (cw == 'משנה' and nxt in forms(i)) or (cw == 'פרק' and i == 1 and nxt in forms(c))
                if ok:
                    # time inside the segment, proportional to the characters before the word
                    t = s0 + (s1 - s0) * len(' '.join(words[:p])) / max(len(text), 1)
                    marks[f'{c}:{i}'] = round(max(0, t - 0.3), 1)
                    k = q + 1
                    break
            if k >= len(members):
                return marks
    return marks

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*', help='masechtot (Hebrew name as on the site)')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='max lessons this run')
    ap.add_argument('--cache', default=os.path.join(ROOT, '..', 'lesson-audio'))
    ap.add_argument('--model', default='ivrit-ai/whisper-large-v3-turbo-ct2')
    ap.add_argument('--redo', action='store_true')
    args = ap.parse_args()

    tractates, key = site()
    if not args.all:
        tractates = [m for m in tractates if m['n'] in args.names]
        if not tractates:
            sys.exit('masechet not found')
    data = json.load(open(OUT, encoding='utf-8')) if os.path.exists(OUT) else {}
    todo = [(m, l) for m in tractates for l in lessons_of(m) if args.redo or l[1] not in data]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(todo)} lessons to do', flush=True)
    if not todo:
        return
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 4)
    os.makedirs(args.cache, exist_ok=True)
    for m, (n, fid, members) in todo:
        t0 = time.time()
        f = os.path.join(args.cache, fid + '.mp3')
        try:
            if not os.path.exists(f):
                urllib.request.urlretrieve(f'https://www.googleapis.com/drive/v3/files/{fid}?alt=media&key={key}', f + '.part')
                os.replace(f + '.part', f)
            segs, info = model.transcribe(f, language='he', beam_size=1, vad_filter=True,
                                          condition_on_previous_text=False)
            marks = find_marks(((s.start, s.end, s.text) for s in segs), members)
        except Exception as e:
            print(f'{m["n"]} {n}: error {e}', flush=True)
            continue
        marks['_'] = len([k for k in marks if k != '_'])
        data[fid] = marks
        json.dump(data, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        try:
            os.remove(f)
        except OSError:
            pass
        print(f'{m["n"]} lesson {n}: {marks["_"]}/{len(members)} {marks}  ({time.time() - t0:.0f}s)', flush=True)

if __name__ == '__main__':
    main()
