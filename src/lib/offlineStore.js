/**
 * Minimal IndexedDB wrapper — no added dependency, since the native API
 * covers everything this needs (one small object store for the current
 * route, one for a queue of writes that failed while offline).
 *
 * IMPORTANT TESTING NOTE: IndexedDB doesn't exist in a Node sandbox, so
 * unlike almost everything else in this project, this module could not be
 * exercised with an actual runtime test before shipping — only reviewed
 * carefully by hand. Treat it with more scrutiny than the rest of the
 * codebase until it's been exercised on a real device/browser.
 */

const DB_NAME = 'flex-route-optimizer';
const DB_VERSION = 1;
const ROUTE_STORE = 'cachedRoute';
const QUEUE_STORE = 'pendingWrites';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROUTE_STORE)) {
        db.createObjectStore(ROUTE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

function runTransaction(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Caches the current route's stops (with coordinates) so a local fallback
 * solver has something to work with if connectivity drops mid-route.
 * Best-effort: never throws to the caller, since a caching failure should
 * degrade to "no offline fallback available," not break route import.
 */
export async function cacheRouteOffline(routeId, stops, meta = {}) {
  try {
    const db = await openDb();
    await runTransaction(db, ROUTE_STORE, 'readwrite', (store) => {
      store.put({
        key: 'current',
        routeId,
        stops,
        currentIndex: meta.currentIndex ?? 0,
        routeStartedAtMs: meta.routeStartedAtMs ?? null,
        routeEstDurationSeconds: meta.routeEstDurationSeconds ?? null,
        cachedAt: Date.now()
      });
    });
    db.close();
    return true;
  } catch (err) {
    console.error('cacheRouteOffline failed (non-fatal — no offline fallback for this route):', err);
    return false;
  }
}

export async function getCachedRoute() {
  try {
    const db = await openDb();
    const result = await runTransaction(db, ROUTE_STORE, 'readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get('current');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
    db.close();
    return result;
  } catch (err) {
    console.error('getCachedRoute failed:', err);
    return null;
  }
}

export async function clearCachedRoute() {
  try {
    const db = await openDb();
    await runTransaction(db, ROUTE_STORE, 'readwrite', (store) => {
      store.delete('current');
    });
    db.close();
    return true;
  } catch (err) {
    console.error('clearCachedRoute failed (non-fatal):', err);
    return false;
  }
}

/**
 * Queues a write that couldn't reach Supabase (device offline). `kind`
 * identifies which function to replay it through later — 'finalizeStop' or
 * 'finalizeRoute' — since the queue needs to know how to flush each entry,
 * not just that "something" needs syncing.
 */
export async function queuePendingWrite(kind, payload) {
  try {
    const db = await openDb();
    await runTransaction(db, QUEUE_STORE, 'readwrite', (store) => {
      store.add({ kind, payload, queuedAt: Date.now() });
    });
    db.close();
    return true;
  } catch (err) {
    console.error('queuePendingWrite failed — this write will be lost:', err);
    return false;
  }
}

export async function getPendingWrites() {
  try {
    const db = await openDb();
    const result = await runTransaction(db, QUEUE_STORE, 'readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
    db.close();
    return result;
  } catch (err) {
    console.error('getPendingWrites failed:', err);
    return [];
  }
}

export async function removePendingWrite(id) {
  try {
    const db = await openDb();
    await runTransaction(db, QUEUE_STORE, 'readwrite', (store) => {
      store.delete(id);
    });
    db.close();
    return true;
  } catch (err) {
    console.error('removePendingWrite failed (may retry/duplicate on next sync):', err);
    return false;
  }
}
