const CACHE_NAME = 'retirepilot-shell-v9';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './main.js',
  './sw-register.js',
  './kis-catalog.js',
  './favicon.svg',
  './app-icon.svg',
  './manifest.webmanifest',
];
const SHELL_PATHS = new Set(APP_SHELL.map(path => new URL(path, self.location.href).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith('retirepilot-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only app-shell paths are handled. API and Edge Function responses never enter Cache Storage.
  if (request.method !== 'GET' || url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
