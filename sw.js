// Service Worker for Digital Menu (optimized)
const VERSION = 'v2.2';
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

  // الصور: اضغطها إلى WebP (إن كان المتصفح يدعم) مع كاش ذكي
  if (req.destination === 'image') {
    event.respondWith(serveCompressedImage(event, req));
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

// ---------- Image compression helpers ----------
async function serveCompressedImage(event, req) {
  const url = new URL(req.url);
  const accept = req.headers.get('accept') || '';

  // لا نضغط إذا كان المتصفح لا يقبل WebP أو لو كانت الصورة أصلاً WebP/AVIF/SVG/ICO
  if (!/image\/webp/i.test(accept) || /\.(webp|avif|svg|ico)$/i.test(url.pathname)) {
    // SWR كما هو
    const cache = await caches.open(IMAGES_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req)
      .then(async (res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone()).then(() => trimCache(IMAGES_CACHE, 60));
        }
        return res;
      })
      .catch(() => cached);
    return cached || net;
  }

  // مفتاح خاص لنسخة WebP المضغوطة
  const webpKey = new Request(
    url.href + (url.search ? '&' : '?') + 'sw-webp=1',
    { headers: req.headers, mode: req.mode, credentials: req.credentials, cache: 'no-store' }
  );
  const cache = await caches.open(IMAGES_CACHE);

  // إن وُجدت النسخة المضغوطة بالكاش أعرضها فوراً
  const cachedWebp = await cache.match(webpKey, { ignoreSearch: false });
  if (cachedWebp) return cachedWebp;

  // اجلب الأصل سريعاً
  const originalRes = await fetch(req).catch(() => null);
  if (!originalRes || !(originalRes.ok || originalRes.type === 'opaque')) {
    const fallback = await cache.match(req, { ignoreSearch: true });
    return fallback || originalRes || Response.error();
  }

  const contentType = originalRes.headers.get('Content-Type') || '';
  if (originalRes.type === 'opaque' || /image\/(webp|avif|svg\+xml)/i.test(contentType)) {
    cache.put(req, originalRes.clone()).then(() => trimCache(IMAGES_CACHE, 60));
    return originalRes;
  }

  // --- جديد: إن كان Save-Data مفعّل، اضغط الآن وأعد WebP فورًا من أول زيارة
  const saveDataHeader = (req.headers.get('Save-Data') || '').toLowerCase() === 'on';
  
  if (saveDataHeader) {
    try {
      const blob = await originalRes.clone().blob();
      // لا تضغط الأيقونات الصغيرة جدًا لتوفير وقت المعالجة
      if (blob.size >= 8 * 1024) {
        const webpBlob = await encodeToWebP(blob, 0.6);
        if (webpBlob) {
          const response = new Response(webpBlob, {
            headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Vary': 'Accept, Save-Data'
            }
          });
          await cache.put(webpKey, response.clone());
          await trimCache(IMAGES_CACHE, 60);
          return response; // ← أعد المضغوط فورًا
        }
      }
    } catch { /* تجاهل الخطأ وكمّل */ }
  }

  // اضغط في الخلفية لباقي المستخدمين بدون تعطيل أول عرض
  event.waitUntil((async () => {
    try {
      const blob = await originalRes.clone().blob();
      if (blob.size < 8 * 1024) return; // تجاهل الصغير جدًا
      const saveData = saveDataHeader;
      const quality = saveData ? 0.6 : 0.72; // خفّض الجودة عند تفعيل توفير البيانات
      const webpBlob = await encodeToWebP(blob, quality);
      if (webpBlob) {
        const response = new Response(webpBlob, {
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Vary': 'Accept, Save-Data'
          }
        });
        await cache.put(webpKey, response.clone());
        await trimCache(IMAGES_CACHE, 60);
      }
    } catch { /* تجاهل الأخطاء بهدوء */ }
  })());

  // أعرض الأصل الآن (بدون تأخير)
  return originalRes;
}

async function encodeToWebP(blob, quality = 0.72) {
  try {
    // يلزم OffscreenCanvas داخل SW؛ إن لم يتوفر نرجع null لنتخطى الضغط
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctx.drawImage(bitmap, 0, 0);

    if (typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: 'image/webp', quality });
    }
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
  } catch {
    return null;
  }
}
