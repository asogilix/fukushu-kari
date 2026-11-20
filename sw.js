importScripts('./asset-list.js');

const root = new URL('./', self.location.href);
const prefix = `review-photo-album:${root.pathname}:`;
const cacheName = prefix + self.APP_CACHE_VERSION;
const assets = self.APP_ASSETS.map(path => new URL(path, root).href);
const assetSet = new Set(assets);
const index = new URL('index.html', root).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      for (let index = 0; index < assets.length; index += 16) {
        const batch = assets.slice(index, index + 16).map(url => new Request(url, { cache: 'reload' }));
        await cache.addAll(batch);
      }
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const old = (await caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName);
    await Promise.all(old.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
  if (request.mode === 'navigate' && (url.pathname === root.pathname || url.pathname === new URL(index).pathname)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(index)) ?? fetch(request))());
  } else if (assetSet.has(url.href)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(request)) ?? fetch(request))());
  }
});
