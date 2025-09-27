// Service Worker for Digital Menu
const CACHE_NAME = 'digital-menu-v1.1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js'
];

// Install event - cache resources
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function(cache) {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
});

// Fetch event - serve from cache when possible
self.addEventListener('fetch', function(event) {
  const req = event.request;

  // للصور: stale-while-revalidate
  if (req.destination === 'image' && req.method === 'GET') {
    event.respondWith((async () => {
      const cache = await caches.open('images-v1');
      const cached = await cache.match(req);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          cache.put(req, fresh.clone());
        }
        return cached || fresh;
      } catch (e) {
        return cached || Promise.reject(e);
      }
    })());
    return;
  }

  // باقي الطلبات: cache-first ثم الشبكة
  event.respondWith(
    caches.match(req).then(function(response) {
      if (response) return response;
      return fetch(req).then(function(networkResponse) {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(req, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Background sync for offline functionality
self.addEventListener('sync', function(event) {
    if (event.tag === 'background-sync') {
        event.waitUntil(doBackgroundSync());
    }
});

function doBackgroundSync() {
    // Sync any pending data when connection is restored
    return Promise.resolve();
}

// Push notifications (if needed in future)
self.addEventListener('push', function(event) {
    const options = {
        body: event.data ? event.data.text() : 'New update available!',
        icon: '/images/icon-192x192.png',
        badge: '/images/badge-72x72.png',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'explore',
                title: 'View Menu',
                icon: '/images/checkmark.png'
            },
            {
                action: 'close',
                title: 'Close',
                icon: '/images/xmark.png'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification('Digital Menu', options)
    );
});

