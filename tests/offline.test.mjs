import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CACHE_PREFIX, BOOK_CACHE, bookUrlsOf } from '../js/offline.js';

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

function makeMockEnv({ scope = 'https://example.com/masyu/', fetchImpl }) {
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
  assert.equal(manifest.name, 'Masyu');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `Manifest icon missing on disk: ${icon.src}`);
  }
});

test('sw.js install precaches app shell and activate prunes old masyu caches only', async () => {
  const fetched = [];
  const env = makeMockEnv({
    fetchImpl: async (req) => {
      fetched.push({ url: req.url, cache: req.cache });
      return new Response(`body:${req.url}`, { status: 200 });
    },
  });

  // Pre-seed an obsolete masyu cache, the current book cache, and an unrelated cache
  await (await env.caches.open('masyu-app-v0')).put('https://example.com/masyu/old.js', new Response('old'));
  await (await env.caches.open(BOOK_CACHE)).put('https://example.com/masyu/data/intro.csv', new Response('csv'));
  await (await env.caches.open('other-site-v1')).put('https://example.com/other', new Response('other'));

  await env.dispatchLifecycle('install');
  assert.equal(env.skipWaitingCalled, true);
  assert.equal(fetched.length, env.exports.APP_SHELL.length);
  assert.ok(fetched.every((f) => f.cache === 'reload'));

  await env.dispatchLifecycle('activate');
  assert.equal(env.claimed, true);
  assert.equal(await env.caches.has('masyu-app-v0'), false);
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
  const navReq = { url: 'https://example.com/masyu/?book=8x8-medium&puzzle=5', method: 'GET', mode: 'navigate' };
  const navOnline = await env.dispatchFetch(navReq);
  assert.equal(navOnline.handled, true);
  assert.match(await navOnline.response.text(), /^v1:/);

  // Non-root navigation (solving guide) caches under its own URL
  const guideReq = { url: 'https://example.com/masyu/docs/how_to_solve.html', method: 'GET', mode: 'navigate' };
  const guideOnline = await env.dispatchFetch(guideReq);
  assert.match(await guideOnline.response.text(), /how_to_solve\.html/);

  // Book CSV cache miss -> fetches v1 and caches in BOOK_CACHE
  const csvUrl = 'https://example.com/masyu/data/intro.csv';
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
    url: 'https://example.com/masyu/?book=12x12-hard&puzzle=99',
    method: 'GET',
    mode: 'navigate',
  });
  assert.match(await navOffline.response.text(), /v1:https:\/\/example\.com\/masyu\/\?book=8x8-medium&puzzle=5/);

  const jsOffline = await env.dispatchFetch(new Request('https://example.com/masyu/js/main.js'));
  assert.equal(await jsOffline.response.text(), 'v1:https://example.com/masyu/js/main.js');

  const guideOffline = await env.dispatchFetch(guideReq);
  assert.match(await guideOffline.response.text(), /how_to_solve\.html/);

  // Unvisited non-root page does NOT wrongly return index.html
  await assert.rejects(() => env.dispatchFetch({
    url: 'https://example.com/masyu/docs/other.html',
    method: 'GET',
    mode: 'navigate',
  }));

  const csvOffline = await env.dispatchFetch(new Request(csvUrl));
  assert.equal(await csvOffline.response.text(), `v3:${csvUrl}`);
  await Promise.all(csvOffline.waits); // background SWR error swallowed cleanly

  // Cross-origin and non-GET requests are not intercepted
  const xOrigin = await env.dispatchFetch(new Request('https://other.example/foo.js'));
  assert.equal(xOrigin.handled, false);
  const postReq = await env.dispatchFetch(new Request('https://example.com/masyu/data/intro.csv', { method: 'POST' }));
  assert.equal(postReq.handled, false);

  // REFRESH_APP message refreshes app shell when online
  online = true;
  version = 4;
  const reply = await env.dispatchMessage({ type: 'REFRESH_APP' });
  assert.equal(reply?.ok, true);
  online = false;
  const jsRefreshed = await env.dispatchFetch(new Request('https://example.com/masyu/js/main.js'));
  assert.equal(await jsRefreshed.response.text(), 'v4:https://example.com/masyu/js/main.js');
});

test('bookUrlsOf separates visible and hidden books and ignores file uploads', () => {
  const books = [
    { id: 'intro', file: 'data/intro.csv' },
    { id: '8x8-beginner', file: 'data/8x8-beginner.csv' },
    { id: 'armory', file: 'data/armory.csv', hidden: true },
    { id: 'file:custom.csv', puzzles: [] },
  ];
  const { all, visible } = bookUrlsOf(books, 'https://example.com/masyu/index.html?book=intro');
  assert.deepEqual(all, [
    'https://example.com/masyu/data/intro.csv',
    'https://example.com/masyu/data/8x8-beginner.csv',
    'https://example.com/masyu/data/armory.csv',
  ]);
  assert.deepEqual(visible, [
    'https://example.com/masyu/data/intro.csv',
    'https://example.com/masyu/data/8x8-beginner.csv',
  ]);
});
