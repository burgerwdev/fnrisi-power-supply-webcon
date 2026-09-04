// Long-run sampling & session persistence on IndexedDB (no dependencies).
// Record rows are {ts, vin?, vout?, iout?, pout?, temp?, ah?, wh?, out, prot, mode}
// Sessions are chunked per ~N points to keep writes fast; metadata kept separately.

export interface SampleRow {
  ts: number;
  vin?: number;
  vout?: number;
  iout?: number;
  pout?: number;
  temp?: number;
  ah?: number;
  wh?: number;
  out: number; // 0 STOP 1 RUN
  prot: number;
  mode: number;
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  endedAt?: number;
  count: number;
  samplePeriodMs: number;
  device?: { model?: string; hw?: string; fw?: string };
  recipeName?: string;
}

const DB = 'dps150.sessions';
const META = 'meta';
const DATA = 'data';
const CHUNK = 10000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'chunkId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, 'readonly');
    const all = tx.objectStore(META).getAll() as IDBRequest<SessionMeta[]>;
    all.onsuccess = () => {
      const arr = all.result ?? [];
      arr.sort((a, b) => b.createdAt - a.createdAt);
      resolve(arr);
    };
    all.onerror = () => reject(all.error);
  });
}

export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, 'readonly');
    const r = tx.objectStore(META).get(id) as IDBRequest<SessionMeta>;
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

export interface SessionRecorder {
  append(rows: SampleRow[]): Promise<void>;
  finish(): Promise<void>;
  readonly id: string;
}

export async function startSession(
  meta: Omit<SessionMeta, 'id' | 'createdAt' | 'count'> & { id?: string },
): Promise<SessionRecorder> {
  const db = await openDb();
  const id = meta.id ?? `s${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const full: SessionMeta = { ...meta, id, createdAt: Date.now(), count: 0 };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(full);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  let chunk: SampleRow[] = [];
  let chunksStored = 0;

  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const rows = chunk;
    chunk = [];
    const chunkId = `${id}:${chunksStored++}`;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DATA, 'readwrite');
      tx.objectStore(DATA).put({ chunkId, id, rows });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  return {
    id,
    async append(rows: SampleRow[]): Promise<void> {
      chunk.push(...rows);
      if (chunk.length >= CHUNK) await flush();
    },
    async finish(): Promise<void> {
      await flush();
      // count stored rows
      let count = 0;
      await new Promise<void>((resolve, reject) => {
        const dtx = db.transaction(DATA, 'readonly');
        const cur = dtx.objectStore(DATA).openCursor(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            count += (c.value as { rows: SampleRow[] }).rows.length;
            c.continue();
          } else resolve();
        };
        cur.onerror = () => reject(cur.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(META, 'readwrite');
        tx.objectStore(META).put({ ...full, count, endedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

export async function loadSessionRows(id: string, cb: (row: SampleRow) => void): Promise<number> {
  const db = await openDb();
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DATA, 'readonly');
    const cur = tx.objectStore(DATA).openCursor(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        for (const row of (c.value as { rows: SampleRow[] }).rows) {
          cb(row);
          count++;
        }
        c.continue();
      } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  });
  return count;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).delete(id);
    const cur = tx.objectStore(DATA).openCursor(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
