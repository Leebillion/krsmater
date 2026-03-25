import type { MasterFileSummary, MasterRecord } from './master';

export type PersistedHistoryItem = {
  id: string;
  name: string;
  importedAt: string;
  summary: MasterFileSummary;
};

export type PersistedMasterState = {
  records: MasterRecord[];
  summary: MasterFileSummary | null;
  history: PersistedHistoryItem[];
  savedAt: string;
};

const DB_NAME = 'krsmaster-db';
const STORE_NAME = 'app';
const STATE_KEY = 'master-state';

export async function loadPersistedState(): Promise<PersistedMasterState | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(STATE_KEY);

    request.onsuccess = () => resolve((request.result as PersistedMasterState | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
}

export async function savePersistedState(state: PersistedMasterState) {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, STATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

export async function clearPersistedState() {
  const db = await openDb();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(STATE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'));
  });
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}
