/* XCaller — service worker (app-shell cache only).
   Rules: never cache the API, the WebSocket, or uploaded files; the shell is
   served stale-while-revalidate so a deploy is picked up on the next load.
   All paths are relative, so the app keeps working at /chat/. */

var VERSION = 'xcaller-shell-v42';
var SHELL = [
  './',
  './index.html',
  './css/app.css',
  './css/corporate.css',
  './css/telegram.css',
  './css/voip.css',
  './css/theme.css',
  './js/app.js',
  './js/calls.js',
  './js/features.js',
  './js/push.js',
  './js/ui2.js',
  './js/version.js',
  './manifest.json',
  './icon-192.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // one failed asset (e.g. a missing calls.js) must not abort the install
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isApiOrWs(url) {
  return url.pathname.indexOf('/api/') !== -1 ||
         url.pathname.indexOf('/ws') !== -1 ||
         url.pathname.indexOf('/uploads/') !== -1 ||
         url.pathname.indexOf('/admin') !== -1;
}

function isShell(url) {
  return url.pathname.indexOf('/chat/') !== -1 &&
         (url.pathname.charAt(url.pathname.length - 1) === '/' ||
          /\.(html|css|js|json|webmanifest|svg|png|ico|woff2?)$/i.test(url.pathname));
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;                 // POST/PUT/DELETE always go to the network

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;  // no third-party (and no CDNs) to cache
  if (isApiOrWs(url)) return;                       // API/WS/uploads: never cached

  // navigations: network first, fall back to the cached shell when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        });
      })
    );
    return;
  }

  if (!isShell(url)) return;

  // shell assets: network first (so an update is never hidden by the cache),
  // cache only as the offline fallback
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        caches.open(VERSION).then(function (cache) { cache.put(req, res.clone()).catch(function () {}); });
      }
      return res;
    }).catch(function () {
      return caches.open(VERSION).then(function (cache) {
        return cache.match(req, { ignoreSearch: true }).then(function (cached) {
          return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        });
      });
    })
  );
});

/* ---------------------------------------------------------------- push ----
   A message or a call arrives when the app is closed or in the background.
   The server sends one of two payloads: { type:'message', ... } or
   { type:'call', callId, kind, ... }. If a window is already visible the app is
   showing the message/ringing screen itself, so we stay silent and avoid
   double-notifying. */

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var isCall = data.type === 'call';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      // let any open page know a push arrived (used for diagnostics/testing)
      list.forEach(function (c) { try { c.postMessage({ type: 'push-received', data: data }); } catch (e) {} });
      var visible = list.some(function (c) { return c.visibilityState === 'visible'; });
      if (visible) return;                      // the open app already showed it
      var options = {
        body: data.body || 'New message',
        tag: data.tag || 'jarvis-chat',
        renotify: true,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        data: data,
        requireInteraction: !!data.requireInteraction,
        vibrate: isCall ? [500, 250, 500, 250, 500] : [120],
      };
      if (isCall) options.actions = [{ action: 'answer', title: 'Answer' }];
      return self.registration.showNotification(data.title || 'XCaller', options);
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  var data = event.notification.data || {};
  var action = event.action;
  event.notification.close();

  var base = new URL('./', self.location.href).href;
  var target = base + (data.type === 'call' && action !== 'dismiss'
    ? ('?answer=' + encodeURIComponent(data.callId || ''))
    : (data.chatId ? ('?open=' + encodeURIComponent(data.chatId)) : ''));

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(base) === 0) {
          try { c.postMessage({ type: 'notification', data: data, action: action }); } catch (e) {}
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* ------------------------------------------------------------------ misc -- */

self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data && event.data.type === 'test-notification') {
    self.registration.showNotification('XCaller', {
      body: 'Notifications work on this device 🎉',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'jarvis-test',
    });
  }
});
