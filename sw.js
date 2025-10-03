// Service Worker for Digital Menu (fixed & hardened)
const VERSION = 'v2.5';
const STATIC_CACHE = `dm-static-${VERSION}`;
const PAGES_CACHE  = `dm-pages-${VERSION}`;
const IMAGES_CACHE = `dm-images-${VERSION}`;
const ALLOWED_CACHES = new Set([STATIC_CACHE, PAGES_CACHE, IMAGES_CACHE]);

// ---------- Precache lists ----------
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

// ملاحظة: إن كانت بعض الصور غير موجودة فعليًا على السيرفر فلن يفشل التثبيت؛ سيتم تخطّيها.
const IMAGE_ASSETS = [
  './images/Arabic_Coffee.png',
  './images/Basbousa.png',
  './images/Basbousa_with_Cream.jpg',
  './images/Beef_Burger.jpg',
  './images/Caesar_Salad.jpg',
  './images/Cappuccino.png',
  './images/Cheese_Manakish.png',
  './images/Cheesecake.png',
  './images/Chicken_Biryani.png',
  './images/Chicken_Burger.png',
  './images/Chicken_Kabsa.png',
  './images/Chicken_Shawarma.png',
  './images/Club_Sandwich.jpg',
  './images/Club_Sandwich.png',
  './images/Double_Cheeseburger.png',
  './images/Eggplant_Mutabbal.jpg',
  './images/Falafel.jpg',
  './images/Fattoush_Salad.jpg',
  './images/Fruit_Cocktail.jpg',
  './images/Garlic_Bread.png',
  './images/Grilled_Fish.png',
  './images/Grilled_Salmon.png',
  './images/Lamb_Chops.png',
  './images/Lamb_Mandi.png',
  './images/Lemon_Mint_Juice.png',
  './images/Mansaf.png',
  './images/Mixed_Grill.jpg',
  './images/Olives_Plate.png',
  './images/Pizza_Margherita.png',
  './images/Spinach_Fatayer.png',
  './images/Stuffed_Chicken_with_Rice.jpg',
  './images/crepe1.jpg',
  './images/western3.jpg',
  './images/cake1.jpg',
  './images/arabic_sweets1.jpg',
  './images/fruit1.jpg',
  './images/margherita1.jpg',
  './images/pepperoni1.jpg',
  './images/vegetarian1.jpg',
  './images/orange1.jpg',
  './images/drink1.jpg',
  './images/Turkish_Tea.png',
  './images/restaurant_interior.jpg',
  './images/breakfast2.jpg',
  './images/soup1.jpg',
  './images/salad1.jpg',
  './images/salad2.jpg',
  './images/seafood1.jpg',
  './images/seafood2.jpg',
  './images/sandwich1.jpg',
  './images/grill2.jpg',
  './images/Shish_Tawook.png',
  './images/meat1.jpg',
  './images/hot1.jpg'
];

// ---------- Helpers ----------
async function trimCache(cacheName, maxItems = 60) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxItems) {
    await cache.delete(keys[0]); // احذف الأقدم
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
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(STATIC_ASSETS);

    // precache للصور مع تخطّي غير الموجود
    const imagesCache = await caches.open(IMAGES_CACHE);
    for (const url of IMAGE_ASSETS) {
      try { await imagesCache.add(url); } catch { /* تخطّي */ }
    }

    await self.skipWaiting(); // فعّل SW الجديد فورًا
  })());
});

// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // فعّل Navigation Preload لتحسين أول تحميل
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    // تنظيف الكاشات القديمة
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      if (!ALLOWED_CACHES.has(name)) return caches.delete(name);
    }));
    await self.clients.claim();
  })());
});

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // صفحات: Network-First مع fallback
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) {
          caches.open(PAGES_CACHE).then((c) => c.put(req, preload.clone()));
          return preload;
        }
        const netRes = await fetch(req, { cache: 'no-store' });
        if (netRes.ok && sameOrigin(new URL(req.url))) {
          const cache = await caches.open(PAGES_CACHE);
          cache.put(req, netRes.clone());
        }
        return netRes;
      } catch {
        const cache  = await caches.open(PAGES_CACHE);
        const cached = await cache.match(req) || await caches.match('./index.html');
        if (cached) return cached;
        return new Response('<h1>أنت غير متصل</h1><p>حاول لاحقًا.</p>', {
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
          status: 503, statusText: 'Offline'
        });
      }
    })());
    return;
  }

  // الصور: ضغط WebP وكاش موحّد
  if (req.destination === 'image') {
    event.respondWith(serveCompressedImage(event, req));
    return;
  }

  // CSS/JS/Fonts: Stale-While-Revalidate
  if (['style', 'script', 'font'].includes(req.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || networkPromise;
    })());
    return;
  }

  // باقي الطلبات: Cache-First ثم الشبكة
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
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
  if (event.tag === 'background-sync') event.waitUntil(Promise.resolve());
});

// ---------- Push notifications ----------
self.addEventListener('push', (event) => {
  const options = {
    body: event.data ? event.data.text() : 'New update available!',
    icon: './images/icon-192x192.png',
    badge: './images/badge-72x72.png',
    vibrate: [100, 50, 100],
    data: { dateOfArrival: Date.now(), primaryKey: 1 },
    actions: [
      { action: 'explore', title: 'View Menu', icon: './images/checkmark.png' },
      { action: 'close',   title: 'Close',     icon: './images/xmark.png' }
    ]
  };
  event.waitUntil(self.registration.showNotification('Digital Menu', options));
});

// ---------- Messages ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---------- Image compression pipeline ----------
async function serveCompressedImage(event, req) {
  const url = new URL(req.url);
  const acceptHeader = (req.headers.get('Accept') || '').toLowerCase();
  const supportsWebP = acceptHeader.includes('image/avif') || acceptHeader.includes('image/webp');
  const targetW = parseInt(url.searchParams.get('w') || '0', 10) || 0;

  // مفتاح موحّد للصور: المسار فقط (بدون الاستعلامات) حتى لا تُجزّئ ?w= الكاش
  const canonicalReq = new Request(url.origin + url.pathname, {
    headers: req.headers, mode: req.mode, credentials: req.credentials
  });
  const cache = await caches.open(IMAGES_CACHE);

  // لو في كاش لأي نسخة للصورة (WebP أو الأصل) أعدها فورًا
  const cached = await cache.match(canonicalReq, { ignoreSearch: true });
  if (cached) return cached;

  // اجلب الأصل
  const netRes = await fetch(req).catch(() => null);
  if (!netRes || !(netRes.ok || netRes.type === 'opaque')) {
    const fallback = await cache.match(canonicalReq, { ignoreSearch: true });
    return fallback || Response.error();
  }

  // إن كانت الاستجابة opaque أو أصلاً WebP/AVIF/SVG — خزّن وأعد كما هي
  const ctype = netRes.headers.get('Content-Type') || '';
  if (netRes.type === 'opaque' || /image\/(webp|avif|svg\+xml)/i.test(ctype)) {
    cache.put(canonicalReq, netRes.clone()).then(() => trimCache(IMAGES_CACHE, 60));
    return netRes;
  }

  // إن كان المتصفح يدعم WebP جرّب ضغطها الآن وإرجاع المضغوط فورًا
  if (supportsWebP) {
    try {
      const blob = await netRes.clone().blob();
      if (blob.size >= 8 * 1024) {
        const webpBlob = await encodeToWebP(blob, 0.72, targetW);
        if (webpBlob) {
          const webpRes = new Response(webpBlob, {
            headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Vary': 'Accept, Save-Data'
            }
          });
          await cache.put(canonicalReq, webpRes.clone());
          await trimCache(IMAGES_CACHE, 60);
          return webpRes;
        }
      }
    } catch { /* لو فشل الضغط نكمل بالأصل */ }
  }

  // خزّن الأصل تحت المفتاح الموحّد وأعده الآن
  cache.put(canonicalReq, netRes.clone()).then(() => trimCache(IMAGES_CACHE, 60));

  // اضغط في الخلفية لتحسين الزيارات القادمة
  if (supportsWebP) {
    event.waitUntil((async () => {
      try {
        const blob = await netRes.clone().blob();
        if (blob.size < 8 * 1024) return;
        const webpBlob = await encodeToWebP(blob, 0.72, targetW);
        if (webpBlob) {
          const webpRes = new Response(webpBlob, {
            headers: {
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Vary': 'Accept, Save-Data'
            }
          });
          await cache.put(canonicalReq, webpRes.clone());
          await trimCache(IMAGES_CACHE, 60);
        }
      } catch {}
    })());
  }

  return netRes;
}

async function encodeToWebP(blob, quality = 0.72, targetWidth = 0) {
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

    if (typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: 'image/webp', quality });
    }
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
  } catch {
    return null;
  }
}
