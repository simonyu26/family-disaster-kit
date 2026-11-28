// 版本號由 index.html 的 APP_VERSION 帶進來（sw.js?v=…），這裡不再寫死（② #29）
const APP_VERSION = (() => {
  const v = new URL(self.location.href).searchParams.get('v') || '';
  return /^v[0-9A-Za-z.\-]{1,20}$/.test(v) ? v : 'dev';
})();
const APP_CACHE = 'disaster-app-' + APP_VERSION;
const TILE_CACHE = 'disaster-map-tiles-v1';


const APP_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // Leaflet 自行託管（② #28，S-07）；預設標記圖示也要預存，離線才看得到
  './vendor/leaflet-1.9.4/leaflet.css',
  './vendor/leaflet-1.9.4/leaflet.js',
  './vendor/leaflet-1.9.4/images/marker-icon.png',
  './vendor/leaflet-1.9.4/images/marker-icon-2x.png',
  './vendor/leaflet-1.9.4/images/marker-shadow.png',
  // QR 碼套件自行託管（② #44，S-07）；預存清單不再有跨網域檔案
  // 平安 QR 第 2 步：qrcodejs 算錯中文長度，換成 qrcode-generator
  './vendor/qrcode-generator-1.4.4/qrcode.js'
];


self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(
      // 同網站檔案繞過瀏覽器 HTTP 快取，避免裝進舊的 index.html（工程顧問）
      APP_ASSETS.map((url) => url.startsWith('http') ? url : new Request(url, { cache: 'reload' }))
    ))
  );
  self.skipWaiting();
});


self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_CACHE && key !== TILE_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});


self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);


  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('router.project-osrm.org') ||
    url.hostname.includes('api.open-meteo.com')
  ) {
    return;
  }


  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((networkRes) => {
            if (networkRes && networkRes.ok) {
              cache.put(event.request, networkRes.clone());
            }
            return networkRes;
          }).catch(() => new Response('', { status: 404 }));
        })
      )
    );
    return;
  }


  const isHtmlNav =
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');


  if (isHtmlNav) {
    event.respondWith(
      fetch(event.request)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(APP_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return networkRes;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }


  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res && res.ok && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return res;
      });
    })
  );
});