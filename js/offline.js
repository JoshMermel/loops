// Page-side controller for opt-in offline play (sw.js + Cache Storage).
export const CACHE_PREFIX = 'masyu-';
export const BOOK_CACHE = 'masyu-books-v1';
export const SW_PATH = './sw.js';

const CONCURRENCY = 4;
const SW_TIMEOUT_MS = 15000;

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

function makeAbortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function waitForActive(reg, signal, timeoutMs = SW_TIMEOUT_MS) {
  if (signal?.aborted) return Promise.reject(makeAbortError());
  if (reg.active?.state === 'activated' && !reg.installing && !reg.waiting) {
    return Promise.resolve(reg.active);
  }
  const worker = reg.installing || reg.waiting || reg.active;
  if (!worker) return Promise.reject(new Error('No service worker instance'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(makeAbortError());
    };
    const onState = () => {
      if (settled) return;
      if (worker.state === 'activated') {
        cleanup();
        resolve(worker);
      } else if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('Service worker installation failed'));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Timed out waiting for service worker activation'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('statechange', onState);
    onState();
  });
}

function refreshAppShell(worker, signal, timeoutMs = SW_TIMEOUT_MS) {
  if (!worker) return Promise.resolve({ ok: false, error: 'No active service worker' });
  if (signal?.aborted) return Promise.resolve({ ok: false, aborted: true });
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { ch.port1.close(); } catch { /* ignore */ }
      resolve(res);
    };
    const onAbort = () => finish({ ok: false, aborted: true });
    const timer = setTimeout(() => finish({ ok: false, error: 'Timed out refreshing app shell' }), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    ch.port1.onmessage = (e) => finish(e.data || { ok: false });
    try {
      worker.postMessage({ type: 'REFRESH_APP' }, [ch.port2]);
    } catch (err) {
      finish({ ok: false, error: err?.message || 'Could not message service worker' });
    }
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
  // Never prune BOOK_CACHE when the manifest hasn't loaded yet
  if (!all.length) {
    return { aborted: Boolean(signal?.aborted), ok: !signal?.aborted, cached: 0, total: 0, failed: 0 };
  }
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
        // When the SW already controls this page, sw.js's handleBookRequest writes to BOOK_CACHE on miss/reload.
        // Only write from the page if uncontrolled (or if SW storage skipped it) to avoid double-writing ~6.6 MB.
        const controlled = Boolean(navigator.serviceWorker?.controller);
        if (!controlled || (!force && !(await cache.match(url)))) {
          await cache.put(url, res);
        }
        if (visibleSet.has(url)) {
          cachedVisible++;
          onProgress?.(cachedVisible, visible.length);
        }
      } catch {
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
  const total = bookUrlsOf(books).visible.length;
  const reg = await navigator.serviceWorker.register(SW_PATH, { scope: './' });
  const abortAndCleanup = async () => {
    if (!force) await reg.unregister().catch(() => {});
    return { aborted: true, ok: false, appOk: false, cached: 0, total, failed: 0 };
  };
  if (signal?.aborted) return abortAndCleanup();

  if (force) await reg.update().catch(() => {});
  let active;
  try {
    active = await waitForActive(reg, signal);
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return abortAndCleanup();
    if (!force) await reg.unregister().catch(() => {});
    throw err;
  }
  if (signal?.aborted) return abortAndCleanup();

  let appOk = true;
  if (force) {
    const appRes = await refreshAppShell(active, signal);
    if (signal?.aborted || appRes?.aborted) return abortAndCleanup();
    appOk = Boolean(appRes?.ok);
  }

  let res;
  try {
    res = await cacheBooks(books, { force, onProgress, signal });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') return abortAndCleanup();
    if (!force) await reg.unregister().catch(() => {});
    throw err;
  }
  if (res.aborted) return abortAndCleanup();
  return { ...res, appOk, ok: res.ok && appOk };
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

export async function syncMissingBooks(books, { signal } = {}) {
  if (!books?.length || !isOfflineSupported() || !navigator.onLine || signal?.aborted) return null;
  const reg = await getSwRegistration();
  if (!reg || signal?.aborted) return null;
  try {
    return await cacheBooks(books, { force: false, signal });
  } catch {
    return null;
  }
}
