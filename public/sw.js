const CACHE_NAME = 'phone-shop-v1';

// الملفات الثابتة اللي هنخزنها عشان تفتح بسرعة حتى لو النت بطيء
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// استراتيجية: جرب الشبكة الأول (عشان البيانات تفضل حديثة)، ولو مفيش نت استخدم النسخة المخزنة
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // استبعاد أي طلبات لا تبدأ بـ http أو https (مثل chrome-extension://)
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // التأكد من نجاح الاستجابة وتوافق البروتوكول قبل عمل clone وتخزين
        if (response.status === 200 && event.request.url.startsWith('http')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
