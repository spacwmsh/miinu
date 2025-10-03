// Service Worker for Digital Menu (optimized)
// --- تحديثات رئيسية ---
// 1) دعم صريح لـ AVIF بالإضافة إلى WebP عند التفاوض عبر Accept.
// 2) توحيد مفاتيح الكاش للإصدارات المضغوطة (sw-im=<webp|avif>) واستخدامها نفسها في match+put.
// 3) عتبات حجم أذكى حسب النوع (PNG/JPG) + احترام Save-Data.
// 4) ضغط فوري على أول زيارة للصور الكبيرة، وخلفية للباقي.
// --------------------------------------------
const VERSION = 'v2.4';
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

const MODERN_ACCEPT_RE = /image\/(avif|webp)/i;
const ACCEPTS_AVIF = /image\/avif/i;
const ACCEPTS_WEBP = /image\/webp/i;

function buildVariantKey(url, type /* 'image/avif' | 'image/webp' */) {
  const u = new URL(url);
  const param = type === 'image/avif' ? 'sw-im=avif' : 'sw-im=webp';
  u.search += (u.search ? '&' : '?') + param;
  return new Request(u.href, { cache: 'no-store' });
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

  // الصور: اضغطها إلى WebP/AVIF (حسب دعم المتصفح) مع كاش ذكي
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
  const wParam = parseInt((url.searchParams.get('w') || '0'), 10) || 0;

  // لا نضغط إذا كان المتصفح لا يقبل أي صيغة حديثة أو لو كانت الصورة أصلاً WebP/AVIF/SVG/ICO
  if (!MODERN_ACCEPT_RE.test(accept) || /\.(webp|avif|svg|ico)$/i.test(url.pathname)) {
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

  const cache = await caches.open(IMAGES_CACHE);

  // جرّب أولاً النسخة المفضلة حسب Accept (AVIF ثم WebP)
  const prefersAvif = ACCEPTS_AVIF.test(accept);
  const prefersWebP = ACCEPTS_WEBP.test(accept);

  const avifKey = buildVariantKey(url.href, 'image/avif');
  const webpKey = buildVariantKey(url.href, 'image/webp');

  if (prefersAvif) {
    const hit = await cache.match(avifKey, { ignoreSearch: false });
    if (hit) return hit;
    // لو ما في AVIF، جرّب WebP إن كان مقبولاً
    if (prefersWebP) {
      const hit2 = await cache.match(webpKey, { ignoreSearch: false });
      if (hit2) return hit2;
    }
  } else if (prefersWebP) {
    const hit = await cache.match(webpKey, { ignoreSearch: false });
    if (hit) return hit;
  }

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

  // نوع الصورة الأصلي للمساعدة في تحديد العتبة
  const isPNG = /image\/png/i.test(contentType) || /\.png($|\?)/i.test(url.pathname);
  const isJPG = /image\/jpe?g/i.test(contentType) || /\.(jpe?g)($|\?)/i.test(url.pathname);

  // احترام وضع توفير البيانات
  const saveDataHeader = (req.headers.get('Save-Data') || '').toLowerCase() === 'on';

  // عتبات حجم أذكى
  const baseMin = isPNG ? 30 * 1024 : isJPG ? 60 * 1024 : 80 * 1024;
  const minSize = saveDataHeader ? Math.max(8 * 1024, Math.floor(baseMin * 0.6)) : baseMin;
  const quality = saveDataHeader ? 0.6 : 0.72;

  // سنحاول الضغط الفوري إن كانت الصورة أكبر من العتبة
  try {
    const originalResClone = originalRes.clone();
    const blob = await originalResClone.blob();

    // خزن الأصل للرجوع لاحقاً (حسب نفس الأصل) ثم قرّر الضغط
    cache.put(req, originalRes.clone()).then(() => trimCache(IMAGES_CACHE, 60));

    // تجاهل الأيقونات الصغيرة جداً
    if (blob.size < 8 * 1024) {
      return originalRes;
    }

    // ضغط فوري للصور الكبيرة
    if (blob.size >= minSize) {
      // حاول AVIF أولاً إن كان مفضلاً، ثم WebP؛ أو العكس حسب Accept
      const order = [];
      if (prefersAvif) order.push('image/avif');
      if (prefersWebP) order.push('image/webp');
      // لو كان يقبل الاثنتين لكن فضّلنا دائماً AVIF أولاً
      if (!order.length) order.push('image/webp'); // احتياط

      for (const type of order) {
        const encoded = await encodeToFormat(blob, type, quality, wParam);
        if (encoded) {
          const response = new Response(encoded, {
            headers: {
              'Content-Type': type,
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Vary': 'Accept, Save-Data'
            }
          });
          const variantKey = type === 'image/avif' ? avifKey : webpKey;
          await cache.put(variantKey, response.clone());
          await trimCache(IMAGES_CACHE, 60);
          return response; // ← إرجاع المضغوط من أول مرة
        }
      }
    }

    // لم نضغط الآن؟ اضغط في الخلفية وارجع الأصل فوراً
    event.waitUntil((async () => {
      try {
        const saveData = saveDataHeader;
        const q = saveData ? 0.6 : 0.72;
        const order = [];
        if (prefersAvif) order.push('image/avif');
        if (prefersWebP) order.push('image/webp');
        if (!order.length) order.push('image/webp');

        for (const type of order) {
          const encoded = await encodeToFormat(blob, type, q, wParam);
          if (encoded) {
            const response = new Response(encoded, {
              headers: {
                'Content-Type': type,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Vary': 'Accept, Save-Data'
              }
            });
            const variantKey = type === 'image/avif' ? avifKey : webpKey;
            await cache.put(variantKey, response.clone());
            await trimCache(IMAGES_CACHE, 60);
            break;
          }
        }
      } catch { /* تجاهل الأخطاء بهدوء */ }
    })());

    return originalRes; // أعرض الأصل الآن (بدون تأخير)
  } catch {
    return originalRes;
  }
}

async function encodeToFormat(blob, type /* 'image/webp' | 'image/avif' */, quality = 0.72, targetWidth = 0) {
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;

    const bitmap = await createImageBitmap(blob);

    let outW = bitmap.width;
    let outH = bitmap.height;

    if (targetWidth && bitmap.width > targetWidth) {
      const scale = targetWidth / bitmap.width;
      outW = Math.max(1, Math.round(bitmap.width * scale));
      outH = Math.max(1, Math.round(bitmap.height * scale));
    }

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctx.drawImage(bitmap, 0, 0, outW, outH);

    let outBlob;
    if (typeof canvas.convertToBlob === 'function') {
      outBlob = await canvas.convertToBlob({ type, quality });
    } else {
      outBlob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    }

    // بعض المتصفحات تُرجع PNG إذا لم تدعم النوع المطلوب؛ تأكد من النوع
    if (!outBlob || !outBlob.type || outBlob.type.toLowerCase() !== type) {
      return null;
    }
    return outBlob;
  } catch {
    return null;
  }
}
