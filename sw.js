// sw.js — Service Worker สำหรับ Catwalk Hotel PWA
// วางไฟล์นี้ที่ root เดียวกับ index.html

self.addEventListener('push', event => {
  if (!event.data) return;
  
  const data = event.data.json();
  
  event.waitUntil(
    self.registration.showNotification(data.title || '🐱 Catwalk Hotel', {
      body: data.body || '',
      icon: 'icon.png',
      badge: 'icon.png',
      tag: data.tag || 'catwalk-push',
      renotify: true,
      requireInteraction: false,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
