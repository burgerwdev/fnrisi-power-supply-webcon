// Script metadata + script output persistence on IndexedDB (no dependencies).
// Scripts are stored with a stable id+name so an edited script can be overwritten
// or saved-as-new. Each script run appends output records (data or log) tagged with
// the owning script id, so a script's history can be viewed/exported.

export interface ScriptMeta {
  id: string;
  name: string;
  code: string;
  updatedAt: number;
}

export interface ScriptOutputRec {
  id: string;
  scriptId: string;
  ts: number;
  kind: 'data' | 'log'; // data = ECHO-collected values, log = diagnostic
  text: string;
}

const DB = 'dps150.scripts';
const STORE_SCRIPTS = 'scripts';
const STORE_OUTPUTS = 'outputs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SCRIPTS)) db.createObjectStore(STORE_SCRIPTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_OUTPUTS)) db.createObjectStore(STORE_OUTPUTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function listScripts(): Promise<ScriptMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SCRIPTS, 'readonly');
    const all = tx.objectStore(STORE_SCRIPTS).getAll() as IDBRequest<ScriptMeta[]>;
    all.onsuccess = () => { const arr = (all.result ?? []).sort((a, b) => b.updatedAt - a.updatedAt); resolve(arr); };
    all.onerror = () => reject(all.error);
  });
}

export async function saveScript(meta: ScriptMeta): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SCRIPTS, 'readwrite');
    tx.objectStore(STORE_SCRIPTS).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteScript(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SCRIPTS, 'readwrite');
    tx.objectStore(STORE_SCRIPTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function appendOutput(rec: ScriptOutputRec): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTPUTS, 'readwrite');
    tx.objectStore(STORE_OUTPUTS).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listOutputs(scriptId?: string): Promise<ScriptOutputRec[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OUTPUTS, 'readonly');
    const all = tx.objectStore(STORE_OUTPUTS).getAll() as IDBRequest<ScriptOutputRec[]>;
    all.onsuccess = () => {
      let arr = all.result ?? [];
      if (scriptId) arr = arr.filter((r) => r.scriptId === scriptId);
      arr.sort((a, b) => (a.scriptId === b.scriptId ? a.ts - b.ts : a.scriptId < b.scriptId ? -1 : 1));
      resolve(arr);
    };
    all.onerror = () => reject(all.error);
  });
}

export async function clearOutputs(scriptId?: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTPUTS, 'readwrite');
    const all = tx.objectStore(STORE_OUTPUTS).getAll() as IDBRequest<ScriptOutputRec[]>;
    all.onsuccess = () => {
      for (const r of all.result ?? []) {
        if (!scriptId || r.scriptId === scriptId) tx.objectStore(STORE_OUTPUTS).delete(r.id);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
