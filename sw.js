// Service Worker for Expense Tracker PWA
const CACHE_NAME = 'expense-tracker-v3';
const STATIC_ASSETS = [
    '/expense-tracker/',
    '/expense-tracker/index.html',
    '/expense-tracker/app.js',
    '/expense-tracker/manifest.json',
    '/expense-tracker/icons/icon-192.png',
    '/expense-tracker/icons/icon-512.png',
];

// External resources to cache
const EXTERNAL_ASSETS = [
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cache local assets
            return cache.addAll(STATIC_ASSETS).catch(err => {
                console.warn('Failed to cache some static assets:', err);
            });
        })
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Google API calls: network only (no caching)
    if (url.hostname.includes('googleapis.com') || url.hostname.includes('accounts.google.com')) {
        return;
    }

    // For app pages and assets: stale-while-revalidate
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                // Update cache with new response
                if (networkResponse.ok) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Network failed, return cached or offline page
                return cachedResponse;
            });

            return cachedResponse || fetchPromise;
        })
    );
});
