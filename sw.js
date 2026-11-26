// Opt-in service worker for offline Masyu play.
// Registered only when the user enables "Offline play" in Settings.
const CACHE_PREFIX = 'masyu-';
const APP_CACHE = 'masyu-app-v4';
const BOOK_CACHE = 'masyu-books-v1';

const APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'favicon.svg',
  'apple-touch-icon.png',
  'manifest.webmanifest',
  'data/manifest.json',
  'js/board.js',
  'js/clues.js',
  'js/colormath.js',
  'js/explain.js',
  'js/faceparity.js',
  'js/grace.js',
  'js/hintstep.js',
  'js/imagine.js',
  'js/lineends.js',
  'js/logic.js',
  'js/main.js',
  'js/marks.js',
  'js/offline.js',
  'js/palette_presets.js',
  'js/palettes.js',
  'js/pathcolors.js',
  'js/print.js',
  'js/rating.js',
  'js/rotate.js',
  'js/variants/castlewall.js',
  'js/variants/midloop.js',
  'js/variants/slitherlink.js',
];

const scopeUrl = () => new URL('./', self.registration.scope);
const resolveAsset = (path) => new URL(path, self.registration.scope).href;
const isCacheable = (res) => Boolean(res && res.status === 200 && res.type !== 'opaque');

async function cleanResponse(res) {
  if (!res.redirected) return res;
  const buf = await res.arrayBuffer();
  return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function safePut(cache, key, res) {
  if (!isCacheable(res)) return;
  try {
    await cache.put(key, res);
  } catch { /* ignore storage quota or non-cacheable errors */ }
}

async function precacheAppShell() {
  // Fetch all shell assets before writing so a transient failure never leaves a mixed-version cache
  const fetched = await Promise.all(APP_SHELL.map(async (path) => {
    const url = resolveAsset(path);
    const res = await fetch(new Request(url, { cache: 'reload' }));
    if (!isCacheable(res)) throw new Error(`Failed to cache ${path}: HTTP ${res.status}`);
    return [url, await cleanResponse(res)];
  }));
  const cache = await caches.open(APP_CACHE);
  await Promise.all(fetched.map(([url, res]) => cache.put(url, res)));
  const keep = new Set(fetched.map(([url]) => url));
  const docsPrefix = `${scopeUrl().href}docs/`;
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => !keep.has(req.url) && !req.url.startsWith(docsPrefix))
      .map((req) => cache.delete(req)),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== APP_CACHE && name !== BOOK_CACHE)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

function isAppRootNavigation(url) {
  const basePath = scopeUrl().pathname;
  return url.pathname === basePath || url.pathname === `${basePath}index.html`;
}

function isBookCsv(url) {
  const basePath = scopeUrl().pathname;
  return url.pathname.startsWith(`${basePath}data/`) && url.pathname.endsWith('.csv');
}

async function handleBookRequest(event, request) {
  const cache = await caches.open(BOOK_CACHE);
  const isReload = request.cache === 'reload';
  const cached = isReload ? null : await cache.match(request);
  const networkPromise = fetch(request).then(async (res) => {
    if (isCacheable(res)) {
      if (isReload) await cache.put(request, res.clone());
      else await safePut(cache, request, res.clone());
    }
    return res;
  });
  if (cached) {
    event.waitUntil(networkPromise.catch(() => {}));
    return cached;
  }
  return networkPromise;
}

async function handleNavigation(request, url) {
  const cache = await caches.open(APP_CACHE);
  const indexUrl = resolveAsset('index.html');
  const rootNav = isAppRootNavigation(url);
  try {
    const raw = await fetch(request);
    const res = raw.redirected && isCacheable(raw) ? await cleanResponse(raw) : raw;
    if (isCacheable(res)) {
      await safePut(cache, rootNav ? indexUrl : request, res.clone());
    }
    return res;
  } catch (err) {
    const fallback = rootNav
      ? (await cache.match(indexUrl)) || (await cache.match(resolveAsset('./')))
      : await cache.match(request);
    if (fallback) return fallback;
    throw err;
  }
}

async function handleAsset(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(request);
    if (isCacheable(res)) {
      await safePut(cache, request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(scopeUrl().pathname)) return;

  if (isBookCsv(url)) {
    event.respondWith(handleBookRequest(event, request));
  } else if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request, url));
  } else {
    event.respondWith(handleAsset(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'REFRESH_APP') return;
  const port = event.ports?.[0];
  event.waitUntil(
    precacheAppShell().then(
      () => port?.postMessage({ ok: true }),
      (err) => port?.postMessage({ ok: false, error: err?.message || 'Refresh failed' }),
    ),
  );
});
