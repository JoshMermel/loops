// Page-side controller for opt-in offline play (sw.js + Cache Storage).
export const CACHE_PREFIX = 'masyu-';
export const BOOK_CACHE = 'masyu-books-v1';
export const SW_PATH = './sw.js';

const CONCURRENCY = 4;

export function isOfflineSupported() {
  return (
    typeof window !== 'undefined'
    && Boolean(window.isSecureContext)
    && 'serviceWorker' in navigator
    && 'caches' in window
  );
}

export function bookUrlsOf(books, baseUrl = typeof location !== 'undefined' ? location.href : 'http://localhost/') {
  const all = [];
  const visible = [];
  const seen = new Set();
  for (const b of books || []) {
    if (!b || !b.file) continue;
    const url = new URL(b.file, baseUrl).href;
    if (seen.has(url)) continue;
    seen.add(url);
    all.push(url);
    if (!b.hidden) visible.push(url);
  }
  return { all, visible };
}

async function getSwRegistration() {
  if (!isOfflineSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    if (!reg) return null;
    const expected = new URL(SW_PATH, location.href).href;
    const worker = reg.active || reg.waiting || reg.installing;
    if (!worker || worker.scriptURL !== expected) return null;
    return reg;
  } catch {
    return null;
  }
}

function waitForActive(reg) {
  if (reg.active && !reg.installing && !reg.waiting) return Promise.resolve(reg.active);
  const worker = reg.installing || reg.waiting;
  if (!worker) return navigator.serviceWorker.ready.then((r) => r.active);
  return new Promise((resolve, reject) => {
    const onState = () => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onState);
        resolve(worker);
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onState);
        reject(new Error('Service worker installation failed'));
      }
    };
    worker.addEventListener('statechange', onState);
    onState();
  });
}

function refreshAppShell(worker) {
  if (!worker) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false }), 15000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data || { ok: false });
    };
    worker.postMessage({ type: 'REFRESH_APP' }, [ch.port2]);
  });
}

export async function getOfflineStatus(books) {
  const { visible } = bookUrlsOf(books);
  if (!isOfflineSupported()) {
    return { supported: false, enabled: false, cached: 0, total: visible.length };
  }
  const reg = await getSwRegistration();
  if (!reg) {
    return { supported: true, enabled: false, cached: 0, total: visible.length };
  }
  let cached = 0;
  try {
    if (await caches.has(BOOK_CACHE)) {
      const cache = await caches.open(BOOK_CACHE);
      const keys = new Set((await cache.keys()).map((r) => r.url));
      cached = visible.filter((u) => keys.has(u)).length;
    }
  } catch { /* ignore */ }
  return { supported: true, enabled: true, cached, total: visible.length };
}

export async function cacheBooks(books, { force = false, onProgress, signal } = {}) {
  const { all, visible } = bookUrlsOf(books);
  const allSet = new Set(all);
  const visibleSet = new Set(visible);
  const cache = await caches.open(BOOK_CACHE);
  const existing = new Set((await cache.keys()).map((r) => r.url));

  // Prune any retired book CSVs no longer in manifest.json
  const stale = [...existing].filter((u) => !allSet.has(u));
  if (stale.length) await Promise.all(stale.map((u) => cache.delete(u)));

  const todo = force ? all : all.filter((u) => !existing.has(u));
  let cachedVisible = force ? 0 : visible.filter((u) => existing.has(u)).length;
  let failed = 0;
  onProgress?.(cachedVisible, visible.length);

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (signal?.aborted) return;
      const url = todo[next++];
      try {
        const req = new Request(url, force ? { cache: 'reload' } : undefined);
        const res = await fetch(req, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cache.put(url, res);
        if (visibleSet.has(url)) {
          cachedVisible++;
          onProgress?.(cachedVisible, visible.length);
        }
      } catch (err) {
        if (signal?.aborted) return;
        failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return {
    aborted: Boolean(signal?.aborted),
    ok: !signal?.aborted && failed === 0,
    cached: cachedVisible,
    total: visible.length,
    failed,
  };
}

export async function enableOffline(books, { force = false, onProgress, signal } = {}) {
  if (!isOfflineSupported()) throw new Error('Offline play is not supported in this browser');
  const reg = await navigator.serviceWorker.register(SW_PATH, { scope: './' });
  if (signal?.aborted) {
    await reg.unregister().catch(() => {});
    return { aborted: true, ok: false, cached: 0, total: bookUrlsOf(books).visible.length, failed: 0 };
  }
  if (force) await reg.update().catch(() => {});
  const active = await waitForActive(reg);
  if (signal?.aborted) {
    await reg.unregister().catch(() => {});
    return { aborted: true, ok: false, cached: 0, total: bookUrlsOf(books).visible.length, failed: 0 };
  }
  if (force) await refreshAppShell(active);
  if (signal?.aborted) {
    await reg.unregister().catch(() => {});
    return { aborted: true, ok: false, cached: 0, total: bookUrlsOf(books).visible.length, failed: 0 };
  }
  return cacheBooks(books, { force, onProgress, signal });
}

export async function disableOffline() {
  if (!isOfflineSupported()) return;
  try {
    const reg = await getSwRegistration();
    if (reg) await reg.unregister();
  } catch { /* ignore */ }
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n)));
  } catch { /* ignore */ }
}

export async function syncMissingBooks(books) {
  if (!isOfflineSupported() || !navigator.onLine) return;
  const reg = await getSwRegistration();
  if (!reg) return;
  try {
    await cacheBooks(books, { force: false });
  } catch { /* ignore */ }
}
