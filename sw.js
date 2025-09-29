// Service Worker for Digital Menu (optimized)
const VERSION = 'v2.0';
const STATIC_CACHE = `dm-static-${VERSION}`;
const PAGES_CACHE  = `dm-pages-${VERSION}`;
const IMAGES_CACHE = `dm-images-${VERSION}`;
const ALLOWED_CACHES = new Set([STATIC_CACHE, PAGES_CACHE, IMAGES_CACHE]);

// Assets to precache (relative to SW scope to work under subdirectories)
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './about-us.html',
  './working-hours.html',
  './rating.html',
  './manifest.json'
];

// ---------- Helpers ----------
async function trimCache(cacheName, maxItems = 60) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // حذف الأقدم أولاً (ترتيب الإدراج)
    await cache.delete(keys[0]);
    // كرّر حتى نصل للحد
    return trimCache(cacheName, maxItems);
  }
}

function isHTMLRequest(request) {
  return request.mode === 'navigate' ||
         (request.destination === 'document') ||
         (request.headers.get('accept') || '').includes('text/html');
}

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

// ---------- Install ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(STATIC_ASSETS);
    // فعّل SW الجديد مباشرةً
    await self.skipWaiting();
  })());
});

// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // فعّل Navigation Preload لتحسين أول طلب تنقّل
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }

    // نظّف الكاشات القديمة
    const names = await caches.keys();
    await Promise.all(
      names.map((name) => {
        if (!ALLOWED_CACHES.has(name)) {
          return caches.delete(name);
        }
      })
    );

    // سيطرة فورية على كل العملاء
    await self.clients.claim();
  })());
});

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // اترك غير GET يمرّ للشبكة (POST/PUT/HEAD...)
  if (req.method !== 'GET') return;

  // استراتيجية للصفحات: Network-First + fallback إلى الكاش + offline fallback
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        // استخدم الاستجابة المُحمّلة مسبقًا إن وُجدت
        const preload = await event.preloadResponse;
        if (preload) {
          // تحدّيث الكاش في الخلفية
          caches.open(PAGES_CACHE).then((c) => c.put(req, preload.clone()));
          return preload;
        }

        const netRes = await fetch(req, { cache: 'no-store' });
        // خزّن نسخة من الصفحات ذات الأصل نفسه فقط
        if (netRes.ok && sameOrigin(new URL(req.url))) {
          const cache = await caches.open(PAGES_CACHE);
          cache.put(req, netRes.clone());
        }
        return netRes;
      } catch {
        // أوفلاين: ارجع إلى الكاش أو إلى الصفحة الرئيسية
        const cache = await caches.open(PAGES_CACHE);
        const cached = await cache.match(req) || await caches.match('./index.html');
        if (cached) return cached;
        // كحل أخير، حاول أي تطابق عام
        const any = await caches.match(req);
        if (any) return any;
        // لا يوجد أي شيء
        return new Response('<h1>أنت غير متصل</h1><p>حاول لاحقًا.</p>', {
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
          status: 503,
          statusText: 'Offline'
        });
      }
    })());
    return;
  }

  // الصور: Stale-While-Revalidate مع حد أقصى وعد قبول الاستجابات opaque (cross-origin)
  if (req.destination === 'image') {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGES_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const networkPromise = fetch(req)
        .then(async (res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).then(() => trimCache(IMAGES_CACHE, 60));
          }
          return res;
        })
        .catch(() => cached);
      // أعطِ المستخدم أسرع استجابة متاحة
      return cached || networkPromise;
    })());
    return;
  }

  // الأصول الثابتة (CSS/JS/Font): Stale-While-Revalidate
  if (['style', 'script', 'font'].includes(req.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || networkPromise;
    })());
    return;
  }

  // باقي الطلبات: Cache First ثم الشبكة ثم لا شيء
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // خزّن فقط نفس الأصل واستجابات ناجحة/opaque
      if ((res.ok || res.type === 'opaque') && sameOrigin(new URL(req.url))) {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    }
  })());
});

// ---------- Background sync ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    event.waitUntil(doBackgroundSync());
  }
});

function doBackgroundSync() {
  // Sync any pending data when connection is restored
  return Promise.resolve();
}

// ---------- Push notifications ----------
self.addEventListener('push', (event) => {
  const options = {
    body: event.data ? event.data.text() : 'New update available!',
    icon: './images/icon-192x192.png',
    badge: './images/badge-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      { action: 'explore', title: 'View Menu',  icon: './images/checkmark.png' },
      { action: 'close',   title: 'Close',      icon: './images/xmark.png' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('Digital Menu', options)
  );
});

// ---------- Messages (optional) ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
