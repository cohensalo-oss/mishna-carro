// Armazenamento local (IndexedDB). Tudo fica só no celular.
// stores: chapters (gravações + cortes), texts (texto da Sefaria), kv (configurações e mapeamento das aulas)
const DB_NAME = 'mishna-carro';
let dbp;

function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      for (const s of ['chapters', 'texts', 'kv']) {
        if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, key, val) => run(store, 'readwrite', s => s.put(val, key));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clear = store => run(store, 'readwrite', s => s.clear());

export async function entries(store) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store);
    const s = t.objectStore(store);
    const ks = s.getAllKeys();
    const vs = s.getAll();
    t.oncomplete = () => res(ks.result.map((k, i) => [k, vs.result[i]]));
    t.onerror = () => rej(t.error);
  });
}

// Metadados dos capítulos sem carregar os áudios na memória da lista
export async function chapterList() {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('chapters');
    const out = [];
    const cur = t.objectStore('chapters').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const { audio, ...meta } = c.value;
      out.push(meta);
      c.continue();
    };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
