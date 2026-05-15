/**
 * service-worker.js — Bingo for Happy Trip PWA
 *
 * 전략:
 *  - 앱 셸(HTML/CSS/JS): Cache First → 오프라인에서도 즉시 로드
 *  - API 요청 (/api/*): Network First → 항상 최신 데이터, 실패 시 캐시
 *  - 폰트(Google Fonts): Cache First + 장기 캐시
 */

const CACHE_NAME = 'bingo-trip-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Fredoka+One&family=Nunito:wght@400;500;600;700&display=swap',
];

// ── Install: 정적 자원 사전 캐시 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: 이전 캐시 정리 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: 요청 인터셉트 ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API 요청: Network First
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 정적 자원 / 페이지: Cache First
  event.respondWith(cacheFirst(request));
});

// Cache First: 캐시 있으면 캐시, 없으면 네트워크 후 캐시에 저장
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 오프라인 + 캐시 없음: index.html 폴백
    return caches.match('/index.html');
  }
}

// Network First: 네트워크 우선, 실패 시 캐시
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'Offline' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
