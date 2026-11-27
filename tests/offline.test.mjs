import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  CACHE_PREFIX, BOOK_CACHE, isOfflineSupported, bookUrlsOf,
  getOfflineStatus, cacheBooks, enableOffline, disableOffline, syncMissingBooks,
} from '../js/offline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

function walkJsImports(entryRel) {
  const seen = new Set();
  const stack = [entryRel];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const full = path.join(ROOT, rel);
    const src = fs.readFileSync(full, 'utf8');
    const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      stack.push(target);
    }
  }
  return seen;
}

function makeMockEnv({ scope = 'https://example.com/loops/', fetchImpl }) {
  const store = new Map(); // cacheName -> Map<url, Response>
  const getMap = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  const makeCache = (name) => ({
    async put(req, res) { getMap(name).set(keyOf(req), res.clone()); },
    async match(req) {
      const hit = getMap(name).get(keyOf(req));
      return hit ? hit.clone() : undefined;
    },
    async delete(req) { return getMap(name).delete(keyOf(req)); },
    async keys() { return [...getMap(name).keys()].map((u) => new Request(u)); },
  });
  const caches = {
    async open(name) { return makeCache(name); },
    async has(name) { return store.has(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) {
      for (const name of store.keys()) {
        const hit = await makeCache(name).match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const listeners = new Map();
  let skipWaitingCalled = false;
  let claimed = false;

  const selfObj = {
    location: new URL(`${scope}sw.js`),
    registration: { scope },
    clients: { async claim() { claimed = true; } },
    skipWaiting: async () => { skipWaitingCalled = true; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };

  const context = vm.createContext({
    self: selfObj,
    caches,
    fetch: (req) => fetchImpl(req),
    Request,
    Response,
    Headers,
    URL,
    Promise,
    Error,
  });

  vm.runInContext(
    `${SW_SRC}\nself.__exports = { CACHE_PREFIX, APP_CACHE, BOOK_CACHE, APP_SHELL };`,
    context,
  );

  async function dispatchLifecycle(type) {
    const waits = [];
    for (const fn of listeners.get(type) || []) {
      fn({ waitUntil(p) { waits.push(p); } });
    }
    await Promise.all(waits);
  }

  async function dispatchFetch(req) {
    let handled = false;
    let respPromise = null;
    const waits = [];
    for (const fn of listeners.get('fetch') || []) {
      fn({
        request: req,
        respondWith(p) { handled = true; respPromise = p; },
        waitUntil(p) { waits.push(p); },
      });
    }
    if (!handled) return { handled: false, response: null, waits };
    const response = await respPromise;
    return { handled: true, response, waits };
  }

  async function dispatchMessage(data) {
    let reply = null;
    const waits = [];
    const port = { postMessage(msg) { reply = msg; } };
    for (const fn of listeners.get('message') || []) {
      fn({ data, ports: [port], waitUntil(p) { waits.push(p); } });
    }
    await Promise.all(waits);
    return reply;
  }

  return {
    exports: selfObj.__exports,
    store,
    caches,
    dispatchLifecycle,
    dispatchFetch,
    dispatchMessage,
    get skipWaitingCalled() { return skipWaitingCalled; },
    get claimed() { return claimed; },
  };
}

test('sw.js APP_SHELL covers all browser modules and static assets', () => {
  const env = makeMockEnv({ fetchImpl: async () => new Response('ok') });
  const shell = new Set(env.exports.APP_SHELL);

  assert.equal(env.exports.CACHE_PREFIX, CACHE_PREFIX);
  assert.equal(env.exports.BOOK_CACHE, BOOK_CACHE);

  // Every JS module transitively imported by js/main.js must be in APP_SHELL
  const jsModules = walkJsImports('js/main.js');
  for (const mod of jsModules) {
    assert.ok(shell.has(mod), `Missing JS module in sw.js APP_SHELL: ${mod}`);
    assert.ok(fs.existsSync(path.join(ROOT, mod)), `Missing file on disk: ${mod}`);
  }

  // Every listed APP_SHELL asset must exist on disk
  for (const asset of shell) {
    if (asset === './') continue;
    assert.ok(fs.existsSync(path.join(ROOT, asset)), `APP_SHELL entry missing on disk: ${asset}`);
  }

  // Required core assets
  for (const req of ['./', 'index.html', 'style.css', 'favicon.svg', 'apple-touch-icon.png', 'manifest.webmanifest', 'data/manifest.json']) {
    assert.ok(shell.has(req), `Required core asset missing in APP_SHELL: ${req}`);
  }

  // Web app manifest is valid JSON and all icons exist
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Loops');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `Manifest icon missing on disk: ${icon.src}`);
  }
});

test('sw.js install precaches app shell and activate prunes old loops caches only', async () => {
  const fetched = [];
  const env = makeMockEnv({
    fetchImpl: async (req) => {
      fetched.push({ url: req.url, cache: req.cache });
      return new Response(`body:${req.url}`, { status: 200 });
    },
  });

  // Pre-seed an obsolete loops cache, the current book cache, and an unrelated cache
  await (await env.caches.open('loops-app-v0')).put('https://example.com/loops/old.js', new Response('old'));
  await (await env.caches.open(BOOK_CACHE)).put('https://example.com/loops/data/intro.csv', new Response('csv'));
  await (await env.caches.open('other-site-v1')).put('https://example.com/other', new Response('other'));

  await env.dispatchLifecycle('install');
  assert.equal(env.skipWaitingCalled, true);
  assert.equal(fetched.length, env.exports.APP_SHELL.length);
  assert.ok(fetched.every((f) => f.cache === 'reload'));

  await env.dispatchLifecycle('activate');
  assert.equal(env.claimed, true);
  assert.equal(await env.caches.has('loops-app-v0'), false);
  assert.equal(await env.caches.has(env.exports.APP_CACHE), true);
  assert.equal(await env.caches.has(BOOK_CACHE), true);
  assert.equal(await env.caches.has('other-site-v1'), true);
});

test('sw.js handles navigation with query params, asset fallback, and book CSV SWR/reload', async () => {
  let online = true;
  let version = 1;
  const env = makeMockEnv({
    fetchImpl: async (req) => {
      if (!online) throw new TypeError('Failed to fetch');
      const url = typeof req === 'string' ? req : req.url;
      return new Response(`v${version}:${url}`, { status: 200 });
    },
  });

  await env.dispatchLifecycle('install');

  // Deep-link navigation online updates canonical index.html without creating duplicate query-string entries
  const navReq = { url: 'https://example.com/loops/?book=8x8-medium&puzzle=5', method: 'GET', mode: 'navigate' };
  const navOnline = await env.dispatchFetch(navReq);
  assert.equal(navOnline.handled, true);
  assert.match(await navOnline.response.text(), /^v1:/);
  const appKeysAfterNav = [...env.store.get(env.exports.APP_CACHE).keys()];
  assert.equal(appKeysAfterNav.some((u) => u.includes('?book=')), false, 'query-string URL should not be cached');

  // Non-root navigation (solving guide) caches under its own URL
  const guideReq = { url: 'https://example.com/loops/docs/how_to_solve.html', method: 'GET', mode: 'navigate' };
  const guideOnline = await env.dispatchFetch(guideReq);
  assert.match(await guideOnline.response.text(), /how_to_solve\.html/);

  // Book CSV cache miss -> fetches v1 and caches in BOOK_CACHE
  const csvUrl = 'https://example.com/loops/data/intro.csv';
  const csvMiss = await env.dispatchFetch(new Request(csvUrl));
  assert.equal(await csvMiss.response.text(), `v1:${csvUrl}`);

  // Bump server version -> book CSV cache hit returns v1 immediately, background SWR updates to v2
  version = 2;
  const csvHit = await env.dispatchFetch(new Request(csvUrl));
  assert.equal(await csvHit.response.text(), `v1:${csvUrl}`);
  await Promise.all(csvHit.waits);
  const csvAfterSwr = await env.dispatchFetch(new Request(csvUrl));
  assert.equal(await csvAfterSwr.response.text(), `v2:${csvUrl}`);
  await Promise.all(csvAfterSwr.waits);

  // Forced reload (cache: 'reload') bypasses BOOK_CACHE and fetches v3 immediately
  version = 3;
  const csvReload = await env.dispatchFetch(new Request(csvUrl, { cache: 'reload' }));
  assert.equal(await csvReload.response.text(), `v3:${csvUrl}`);

  // Go offline: deep-link navigation, JS asset, solving guide, and cached CSV all work
  online = false;
  const navOffline = await env.dispatchFetch({
    url: 'https://example.com/loops/?book=12x12-hard&puzzle=99',
    method: 'GET',
    mode: 'navigate',
  });
  assert.match(await navOffline.response.text(), /v1:https:\/\/example\.com\/loops\/\?book=8x8-medium&puzzle=5/);

  const jsOffline = await env.dispatchFetch(new Request('https://example.com/loops/js/main.js'));
  assert.equal(await jsOffline.response.text(), 'v1:https://example.com/loops/js/main.js');

  const guideOffline = await env.dispatchFetch(guideReq);
  assert.match(await guideOffline.response.text(), /how_to_solve\.html/);

  // Unvisited non-root page does NOT wrongly return index.html
  await assert.rejects(() => env.dispatchFetch({
    url: 'https://example.com/loops/docs/other.html',
    method: 'GET',
    mode: 'navigate',
  }));

  const csvOffline = await env.dispatchFetch(new Request(csvUrl));
  assert.equal(await csvOffline.response.text(), `v3:${csvUrl}`);
  await Promise.all(csvOffline.waits); // background SWR error swallowed cleanly

  // Cross-origin, out-of-scope same-origin, and non-GET requests are not intercepted
  const xOrigin = await env.dispatchFetch(new Request('https://other.example/foo.js'));
  assert.equal(xOrigin.handled, false);
  const outScope = await env.dispatchFetch(new Request('https://example.com/other/app.js'));
  assert.equal(outScope.handled, false);
  const postReq = await env.dispatchFetch(new Request('https://example.com/loops/data/intro.csv', { method: 'POST' }));
  assert.equal(postReq.handled, false);

  // REFRESH_APP message refreshes app shell when online and reports error when offline
  online = true;
  version = 4;
  const reply = await env.dispatchMessage({ type: 'REFRESH_APP' });
  assert.equal(reply?.ok, true);
  online = false;
  const jsRefreshed = await env.dispatchFetch(new Request('https://example.com/loops/js/main.js'));
  assert.equal(await jsRefreshed.response.text(), 'v4:https://example.com/loops/js/main.js');
  const failReply = await env.dispatchMessage({ type: 'REFRESH_APP' });
  assert.equal(failReply?.ok, false);
  assert.ok(failReply?.error);
});

test('sw.js handles redirected responses, non-200/206 responses, QuotaExceededError, and atomic precache rollback', async () => {
  let mode = 'ok';
  let version = 1;
  let quotaFail = false;
  const env = makeMockEnv({
    fetchImpl: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      if (mode === 'fail-one' && url.endsWith('js/rotate.js')) {
        return new Response('err', { status: 500 });
      }
      if (mode === 'status-500') return new Response('server error', { status: 500 });
      if (mode === 'status-206') return new Response('partial', { status: 206 });
      if (mode === 'redirect') {
        const res = new Response('redirected-body', { status: 200 });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      }
      return new Response(`v${version}:${url}`, { status: 200 });
    },
  });

  // Initial clean install at v1
  await env.dispatchLifecycle('install');

  // Atomic precacheAppShell: bump to v2 and fail 1 file -> prior v1 APP_CACHE must stay untouched
  version = 2;
  mode = 'fail-one';
  const failedRefresh = await env.dispatchMessage({ type: 'REFRESH_APP' });
  assert.equal(failedRefresh?.ok, false);
  const cachedMain = await (await env.caches.open(env.exports.APP_CACHE)).match('https://example.com/loops/js/main.js');
  assert.equal(await cachedMain.text(), 'v1:https://example.com/loops/js/main.js');

  // Redirected navigation response is cleaned before returning and caching
  mode = 'redirect';
  const redNav = await env.dispatchFetch({ url: 'https://example.com/loops/', method: 'GET', mode: 'navigate' });
  assert.equal(redNav.response.redirected, false);
  assert.equal(await redNav.response.text(), 'redirected-body');

  // Non-200 / 206 responses never overwrite good cached entries and never fail online fetches
  mode = 'ok';
  const csvUrl = 'https://example.com/loops/data/intro.csv';
  await env.dispatchFetch(new Request(csvUrl));
  mode = 'status-500';
  const badAsset = await env.dispatchFetch(new Request('https://example.com/loops/js/main.js'));
  assert.equal(badAsset.response.status, 500);
  const stillGoodMain = await (await env.caches.open(env.exports.APP_CACHE)).match('https://example.com/loops/js/main.js');
  assert.equal(await stillGoodMain.text(), 'v1:https://example.com/loops/js/main.js');

  mode = 'status-206';
  const partialRes = await env.dispatchFetch(new Request('https://example.com/loops/data/other.csv'));
  assert.equal(partialRes.response.status, 206);
  assert.equal(await (await env.caches.open(BOOK_CACHE)).match('https://example.com/loops/data/other.csv'), undefined);

  // QuotaExceededError during cache.put must not break normal online fetches, but MUST fail cache: 'reload'
  const origOpen = env.caches.open.bind(env.caches);
  env.caches.open = async (name) => {
    const c = await origOpen(name);
    return {
      ...c,
      async put(k, v) {
        if (quotaFail) throw new Error('QuotaExceededError');
        return c.put(k, v);
      },
    };
  };
  mode = 'ok';
  quotaFail = true;
  const onlineRes = await env.dispatchFetch(new Request('https://example.com/loops/data/new.csv'));
  assert.equal(onlineRes.response.status, 200);
  assert.equal(await onlineRes.response.text(), 'v2:https://example.com/loops/data/new.csv');
  await assert.rejects(
    () => env.dispatchFetch(new Request('https://example.com/loops/data/new.csv', { cache: 'reload' })),
    /QuotaExceededError/,
  );
});

test('js/offline.js controller handles status, cacheBooks pruning/abort, enableOffline, disableOffline, and syncMissingBooks', async () => {
  const base = 'https://example.com/loops/';
  const books = [
    { id: 'intro', file: 'data/intro.csv' },
    { id: '8x8-beginner', file: 'data/8x8-beginner.csv' },
    { id: 'armory', file: 'data/armory.csv', hidden: true },
  ];

  // Build in-memory browser globals for js/offline.js
  const store = new Map();
  const getMap = (name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  const makeCache = (name) => ({
    async put(req, res) { getMap(name).set(typeof req === 'string' ? req : req.url, res.clone()); },
    async match(req) { const h = getMap(name).get(typeof req === 'string' ? req : req.url); return h ? h.clone() : undefined; },
    async delete(req) { return getMap(name).delete(typeof req === 'string' ? req : req.url); },
    async keys() { return [...getMap(name).keys()].map((u) => new Request(u)); },
  });
  const mockCaches = {
    async open(name) { return makeCache(name); },
    async has(name) { return store.has(name); },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
  };

  let currentReg = null;
  let refreshReply = { ok: true };
  let online = true;
  const makeReg = (scriptURL = `${base}sw.js`, initialState = 'activated') => {
    const listeners = new Set();
    const worker = {
      scriptURL,
      state: initialState,
      addEventListener(t, fn) { if (t === 'statechange') listeners.add(fn); },
      removeEventListener(t, fn) { if (t === 'statechange') listeners.delete(fn); },
      postMessage(msg, [port]) {
        if (msg?.type === 'REFRESH_APP') setTimeout(() => port?.postMessage(refreshReply), 0);
      },
      _setState(next) { worker.state = next; for (const fn of [...listeners]) fn(); },
    };
    const reg = {
      active: initialState === 'activated' ? worker : null,
      installing: initialState === 'installing' ? worker : null,
      waiting: null,
      async update() {},
      async unregister() { if (currentReg === reg) currentReg = null; return true; },
      _worker: worker,
    };
    return reg;
  };

  let registerCount = 0;
  const mockNav = {
    get onLine() { return online; },
    serviceWorker: {
      controller: null,
      async getRegistration() { return currentReg; },
      async register(path) {
        registerCount++;
        currentReg = makeReg(new URL(path, base).href, 'activated');
        return currentReg;
      },
    },
  };

  let fetchFailUrl = null;
  const keysToPatch = ['window', 'location', 'caches', 'navigator', 'fetch'];
  const origDescs = Object.fromEntries(keysToPatch.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));

  try {
    Object.defineProperty(globalThis, 'window', { value: { isSecureContext: true, caches: mockCaches }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: new URL(`${base}index.html`), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'caches', { value: mockCaches, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: mockNav, configurable: true, writable: true });
    globalThis.fetch = async (req, opts) => {
      if (opts?.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const url = typeof req === 'string' ? req : req.url;
      if (fetchFailUrl && url === fetchFailUrl) return new Response('err', { status: 500 });
      return new Response(`csv:${url}`, { status: 200 });
    };

    assert.equal(isOfflineSupported(), true);

    // Pre-aborted signal returns immediately without registering SW
    const preAbort = new AbortController();
    preAbort.abort();
    const preRes = await enableOffline(books, { signal: preAbort.signal });
    assert.equal(preRes.aborted, true);
    assert.equal(registerCount, 0);

    // Disabled by default
    let st = await getOfflineStatus(books);
    assert.deepEqual(st, { supported: true, enabled: false, cached: 0, total: 2 });

    // Foreign SW scriptURL must not count as enabled
    currentReg = makeReg('https://example.com/other-sw.js');
    st = await getOfflineStatus(books);
    assert.equal(st.enabled, false);
    currentReg = null;

    // Enable offline: caches all 3 files (2 visible + hidden armory) and reports visible progress
    const progress = [];
    const res = await enableOffline(books, { onProgress: (d, t) => progress.push([d, t]) });
    assert.equal(res.ok, true);
    assert.equal(res.cached, 2);
    assert.equal(res.total, 2);
    assert.deepEqual(progress[progress.length - 1], [2, 2]);
    assert.equal(getMap(BOOK_CACHE).size, 3);

    st = await getOfflineStatus(books);
    assert.deepEqual(st, { supported: true, enabled: true, cached: 2, total: 2 });

    // Foreign SW controller must NOT skip cache.put on force: true
    mockNav.serviceWorker.controller = { scriptURL: 'https://example.com/other-sw.js' };
    getMap(BOOK_CACHE).clear();
    const foreignRes = await cacheBooks(books, { force: true });
    assert.equal(foreignRes.ok, true);
    assert.equal(getMap(BOOK_CACHE).size, 3);
    mockNav.serviceWorker.controller = null;

    // Empty books array must NEVER prune BOOK_CACHE
    const emptyRes = await cacheBooks([]);
    assert.equal(emptyRes.total, 0);
    assert.equal(getMap(BOOK_CACHE).size, 3);

    // Retired book gets pruned when manifest drops it
    await (await mockCaches.open(BOOK_CACHE)).put(`${base}data/retired.csv`, new Response('old'));
    assert.equal(getMap(BOOK_CACHE).size, 4);
    await syncMissingBooks(books);
    assert.equal(getMap(BOOK_CACHE).has(`${base}data/retired.csv`), false);
    assert.equal(getMap(BOOK_CACHE).size, 3);

    // Force refresh propagates REFRESH_APP failure into res.ok === false
    refreshReply = { ok: false, error: 'offline' };
    const failRefresh = await enableOffline(books, { force: true });
    assert.equal(failRefresh.appOk, false);
    assert.equal(failRefresh.ok, false);
    refreshReply = { ok: true };

    // Book fetch failure increments failed count cleanly
    fetchFailUrl = `${base}data/intro.csv`;
    const partial = await enableOffline(books, { force: true });
    assert.equal(partial.ok, false);
    assert.equal(partial.failed, 1);
    fetchFailUrl = null;

    // AbortSignal cancels enableOffline cleanly without disabling already-enabled offline mode
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await enableOffline(books, { force: true, signal: ctrl.signal });
    assert.equal(aborted.aborted, true);
    assert.ok(currentReg !== null, 'aborting a force-refresh must keep offline enabled');

    // disableOffline unregisters SW and deletes all loops-* caches (preserving unrelated caches)
    await (await mockCaches.open('loops-app-v0')).put(`${base}index.html`, new Response('html'));
    await (await mockCaches.open('unrelated-v1')).put(`${base}x`, new Response('x'));
    await disableOffline();
    assert.equal(currentReg, null);
    assert.equal(await mockCaches.has(BOOK_CACHE), false);
    assert.equal(await mockCaches.has('loops-app-v0'), false);
    assert.equal(await mockCaches.has('unrelated-v1'), true);

    // syncMissingBooks is a no-op when offline or disabled
    online = false;
    assert.equal(await syncMissingBooks(books), null);
    online = true;
    assert.equal(await syncMissingBooks(books), null);
  } finally {
    for (const k of keysToPatch) {
      if (origDescs[k]) Object.defineProperty(globalThis, k, origDescs[k]);
      else delete globalThis[k];
    }
  }
});

test('bookUrlsOf separates visible and hidden books and ignores file uploads', () => {
  const books = [
    { id: 'intro', file: 'data/intro.csv' },
    { id: '8x8-beginner', file: 'data/8x8-beginner.csv' },
    { id: 'armory', file: 'data/armory.csv', hidden: true },
    { id: 'file:custom.csv', puzzles: [] },
  ];
  const { all, visible } = bookUrlsOf(books, 'https://example.com/loops/index.html?book=intro');
  assert.deepEqual(all, [
    'https://example.com/loops/data/intro.csv',
    'https://example.com/loops/data/8x8-beginner.csv',
    'https://example.com/loops/data/armory.csv',
  ]);
  assert.deepEqual(visible, [
    'https://example.com/loops/data/intro.csv',
    'https://example.com/loops/data/8x8-beginner.csv',
  ]);
});
