// Scan record persistence on IndexedDB (no dependencies).
// Each scan run is stored as one record: config summary + the collected points.
// Records persist across page refresh (IndexedDB) and can be listed/selected/deleted.

import type { ScanPoint } from '../sequence/scanner';

export interface ScanRecord {
  id: string;
  createdAt: number;
  kind: 'voltage' | 'current';
  start: number;
  stop: number;
  step: number;
  fixed: number;
  settleMs: number;
  points: ScanPoint[];
  interrupted?: boolean;
}

const DB = 'dps150.scanrecords';
const STORE = 'records';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function listScanRecords(): Promise<ScanRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const all = tx.objectStore(STORE).getAll() as IDBRequest<ScanRecord[]>;
    all.onsuccess = () => {
      const arr = all.result ?? [];
      arr.sort((a, b) => b.createdAt - a.createdAt);
      resolve(arr);
    };
    all.onerror = () => reject(all.error);
  });
}

export async function saveScanRecord(rec: ScanRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteScanRecord(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
