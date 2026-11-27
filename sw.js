// שומר את האפליקציה כדי שתיפתח גם בלי אינטרנט. כשיש אינטרנט תמיד בודקים אם יש גרסה חדשה.
const CACHE = 'mishna-carro-v6';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'text.js', 'audio.js', 'shinun.js', 'lesson.js', 'data.js',
  'lessons.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' = לא לקחת עותק ישן מהמטמון של הדפדפן
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// רשת קודם (עם בדיקה מול השרת, לא מהמטמון של הדפדפן), ואם אין אינטרנט - מהשמור.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
