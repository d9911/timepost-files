export {};
interface WorkerEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface WorkerFetchEvent extends WorkerEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  location: Location;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: WorkerEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: WorkerFetchEvent) => void): void;
}
const worker = globalThis as unknown as WorkerScope;
const cacheName = 'timepost-files-shell-__FILES_CACHE_VERSION__';
const shell = [
  '/',
  '/app.js',
  '/direct-upload.js',
  '/preferences.js',
  '/preference-dropdown.js',
  '/popup.js',
  '/media-helpers.js',
  '/media-preview.js',
  '/upload-name.js',

  '/pwa.js',
  '/motion.js',
  '/style.css',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/favicon.svg',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/maskable-512x512.png',
];
worker.addEventListener('install', (event) => {
  // Кэшируем только публичную оболочку. Новая версия ждёт закрытия старых вкладок.
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll(
          shell.map((path) => new Request(path, { credentials: 'omit', cache: 'reload' })),
        ),
      ),
  );
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('timepost-files-shell-') && name !== cacheName)
          await caches.delete(name);
      await worker.clients.claim();
    })(),
  );
});
worker.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  // API, приватные файлы, query и запросы с авторизацией не перехватываются вообще.
  if (
    request.method !== 'GET' ||
    url.origin !== worker.location.origin ||
    url.search ||
    request.headers.has('authorization') ||
    !shell.includes(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      return fetch(request);
    })(),
  );
});
