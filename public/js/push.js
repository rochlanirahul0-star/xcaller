/**
 * XCaller — notifications (Web Push) glue.
 *
 * Loaded after app.js and calls.js, deliberately separate so the messenger code
 * stays untouched. It does four things:
 *
 *   1. asks for notification permission (from a real tap, which iOS requires)
 *   2. registers this device with the server so messages/calls can be pushed
 *   3. handles taps on a notification: open the chat, or answer the call
 *   4. adds a small "notifications" block to the Profile screen
 *
 * Web Push needs the app installed (Add to Home Screen) on iPhone; on Android it
 * works in the browser as well as installed.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'jarvis.token';
  var asked = false;

  function isAndroidApp() { return /XCallerApp\/|XCaller-Android|JarvisChatApp/i.test(navigator.userAgent); }
  function dismissed() { try { return localStorage.getItem('xcaller.nudge') === 'off'; } catch (e) { return false; } }
  /** The bar lives at the top and takes itself away after 12s: it must never
   *  sit on the message box while someone is typing. */
  function autoHideNudge(bar) {
    setTimeout(function () {
      if (!bar || !bar.parentNode) return;
      bar.style.transition = 'opacity .3s ease';
      bar.style.opacity = '0';
      setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 340);
    }, 12000);
  }

  function dismissNudge() { try { localStorage.setItem('xcaller.nudge', 'off'); } catch (e) {} var n = document.getElementById('xc-nudge'); if (n) n.remove(); }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function toast(msg, kind) { var u = window.UI; if (u && u.toast) u.toast(msg, kind); }
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j; }); });
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent); }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  /* ------------------------------------------------------------- register --- */

  function subscribe() {
    if (!supported() || !token()) return Promise.resolve(null);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return api('api/push/key').then(function (r) {
          if (!r.key) throw new Error('push not configured on the server');
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(r.key) });
        });
      });
    }).then(function (sub) {
      if (!sub) return null;
      return api('api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }).then(function () { return sub; });
    });
  }

  function enableFromGesture() {
    if (!supported() || asked || !token()) return;
    asked = true;
    if (Notification.permission === 'granted') { subscribe().catch(function () {}); return; }
    if (Notification.permission === 'denied') return;
    Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') {
        subscribe().then(function (sub) { if (sub) toast('Notifications are on'); }).catch(function (e) { toast('Could not enable notifications: ' + e.message, 'error'); });
      }
    }).catch(function () {});
  }

  /**
   * A bar at the top of the app while notifications are off.
   * Without it, permission is never asked for and messages arrive silently — which
   * is exactly what happened before this existed.
   */
  /** Inside the app, "blocked" means the phone itself is refusing our notifications. */
  function appNotificationsBlocked() {
    try { return !!(window.XCApp && window.XCApp.notificationsBlocked && window.XCApp.notificationsBlocked()); } catch (e) { return false; }
  }

  function showAppNudge() {
    if (!isAndroidApp() || !appNotificationsBlocked()) return;
    if (dismissed() || !token() || document.getElementById('xc-nudge')) return;
    var bar = document.createElement('div');
    bar.id = 'xc-nudge';
    bar.style.cssText = [
      'position:fixed', 'left:10px', 'right:10px', 'top:calc(8px + env(safe-area-inset-top))', 'bottom:auto', 'z-index:70',
      'display:flex', 'align-items:center', 'gap:10px',
      'background:linear-gradient(135deg,#8a2b2b 0%,#5e1414 100%)', 'color:#fff', 'padding:10px 12px',
      'font:14px/1.35 "Segoe UI",system-ui,sans-serif', 'border-radius:16px',
      'box-shadow:0 12px 32px rgba(11,32,56,.38)', 'pointer-events:none',
    ].join(';');
    var text = document.createElement('span');
    text.style.cssText = 'flex:1';
    text.textContent = '🔕 Notifications are turned off for XCaller — you will miss messages and calls.';
    bar.appendChild(text);
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Turn on';
    go.style.cssText = 'background:#1f7a6d;color:#fff;border:0;border-radius:999px;padding:9px 16px;font-weight:700;cursor:pointer;pointer-events:auto';
    go.addEventListener('click', function () {
      try { if (window.XCApp.openNotificationSettings) window.XCApp.openNotificationSettings(); } catch (e) {}
      setTimeout(function () { if (!appNotificationsBlocked()) { toast('Notifications are on'); dismissNudge(); } }, 1200);
    });
    bar.appendChild(go);
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.style.cssText = 'background:transparent;color:#fff;border:0;font-size:15px;cursor:pointer;pointer-events:auto;padding:4px 6px';
    x.addEventListener('click', dismissNudge);
    bar.appendChild(x);
    document.body.appendChild(bar);
    autoHideNudge(bar);
  }

  function showNudge() {
    if (dismissed() || isAndroidApp()) return;
    if (!supported() || Notification.permission === 'granted') return;
    if (!token() || document.getElementById('xc-nudge')) return;

    var bar = document.createElement('div');
    bar.id = 'xc-nudge';
    bar.style.cssText = [
      'position:fixed', 'left:10px', 'right:10px', 'top:calc(8px + env(safe-area-inset-top))', 'bottom:auto', 'z-index:70',
      'display:flex', 'align-items:center', 'gap:10px',
      'background:linear-gradient(135deg,#123a5e 0%,#0b2038 100%)', 'color:#fff', 'padding:10px 12px',
      'font:14px/1.35 "Segoe UI",system-ui,sans-serif',
      'border-radius:16px', 'box-shadow:0 12px 32px rgba(11,32,56,.38)',
      'pointer-events:none',                     // taps go through to the app underneath
      '',
    ].join(';');

    var text = document.createElement('span');
    text.style.cssText = 'flex:1';
    text.textContent = Notification.permission === 'denied'
      ? 'Notifications are off — turn them on to hear about messages and calls'
      : '🔔 Turn on notifications for messages and calls';
    bar.appendChild(text);

    if (Notification.permission !== 'denied') {
      var go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'Enable';
      go.style.cssText = 'background:#1f7a6d;color:#fff;border:0;border-radius:999px;padding:9px 16px;font-weight:700;cursor:pointer;pointer-events:auto';
      go.addEventListener('click', function () {
        Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') { toast('Notifications were not allowed', 'error'); return; }
          subscribe().then(function () { toast('Notifications are on'); dismissNudge(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
      });
      bar.appendChild(go);
    }

    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.style.cssText = 'background:none;border:0;color:#fff;opacity:.8;font-size:18px;cursor:pointer;pointer-events:auto;padding:4px 6px';
    x.addEventListener('click', dismissNudge);
    bar.appendChild(x);

    document.body.appendChild(bar);
    autoHideNudge(bar);
  }
  setInterval(showNudge, 4000);
  setTimeout(showNudge, 2500);
  // inside the app: is the phone itself blocking our notifications?
  setInterval(showAppNudge, 6000);
  setTimeout(showAppNudge, 3500);

  // A tap is the gesture both Chrome and iOS Safari want before asking.
  ['click', 'touchend'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      setTimeout(enableFromGesture, 0);
    }, { once: false, passive: true });
  });

  // Also quietly (re)register on each start when permission already exists —
  // idempotent server-side, and it rebinds the device to whoever is logged in.
  function boot() {
    if (!supported()) return;
    if (!token()) { setTimeout(boot, 1500); return; }
    if (Notification.permission !== 'granted') return;
    subscribe().then(function (sub) {
      if (sub && isIos() && !isStandalone()) {
        toast('On iPhone, add XCaller to your Home Screen to get notifications', 'error');
      }
    }).catch(function () {});
  }
  setTimeout(boot, 1200);

  /* ---------------------------------------------------------- deep links --- */

  var params = new URLSearchParams(location.search);
  var answerId = params.get('answer');
  var openChat = params.get('open');

  function wireDeepLinks() {
    var N = window.Net;
    if (!N || !N.on) { setTimeout(wireDeepLinks, 500); return; }

    if (answerId) {
      // The ring is in flight: accept as soon as the app knows about the call,
      // or immediately if the call frame has already arrived.
      var tryAccept = function () {
        if (window.Calls && window.Calls.state && !window.Calls.state().callId) {
          window.Calls.accept(answerId);
          return true;
        }
        return false;
      };
      N.on('call.incoming', function (f) {
        if (f && String(f.callId) === String(answerId)) setTimeout(tryAccept, 150);
      });
      setTimeout(tryAccept, 1500);
    }

    if (openChat) {
      var open = function () {
        var rows = document.querySelectorAll('#chatlist > *');
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].dataset.chatId || '') === String(openChat)) { rows[i].click(); return true; }
        }
        return false;
      };
      setTimeout(open, 1200);
      setTimeout(open, 3000);
    }
  }
  wireDeepLinks();

  /* ------------------------------------------- notification tapped in-app --- */

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type !== 'notification') return;
      var data = d.data || {};
      // `action === 'answer'` means the user pressed Answer on the notification. Any other tap
      // (the notification body) must only open the app — auto-answering on a plain tap is how
      // calls were picking themselves up.
      if (data.type === 'call' && data.callId && d.action === 'answer') {
        if (window.Calls && window.Calls.state().callId !== data.callId) window.Calls.accept(data.callId);
      } else if (data.chatId) {
        var rows = document.querySelectorAll('#chatlist > *');
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].dataset.chatId || '') === String(data.chatId)) { rows[i].click(); break; }
        }
      }
    });
  }

  /* ------------------------------------------------- Profile screen block -- */

  var observer = new MutationObserver(function () {
    var title = document.getElementById('modal-title');
    var body = document.getElementById('modal-body');
    var modal = document.getElementById('modal');
    if (!title || !body || !modal || modal.hidden) return;
    if (title.textContent !== 'Profile') return;
    if (body.querySelector('#push-block')) return;

    var block = document.createElement('div');
    block.id = 'push-block';
    block.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.12)';

    var head = document.createElement('div');
    head.textContent = '🔔 Notifications';
    head.style.cssText = 'font-weight:600;margin-bottom:6px';
    block.appendChild(head);

    var status = document.createElement('div');
    status.style.cssText = 'font-size:13px;opacity:.75;margin-bottom:10px';
    function paint() {
      if (!supported()) { status.textContent = 'This browser cannot receive notifications.'; return; }
      if (Notification.permission === 'granted') status.textContent = 'On for this device — messages and calls reach you even when the app is closed.';
      else if (Notification.permission === 'denied') status.textContent = 'Blocked in your browser settings (site settings → notifications) — allow it there, then reopen.';
      else if (isIos() && !isStandalone()) status.textContent = 'On iPhone: tap Share → Add to Home Screen, open the app from the icon, then press Enable.';
      else status.textContent = 'Off — press Enable and allow the prompt.';
    }
    paint();
    block.appendChild(status);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

    var enable = document.createElement('button');
    enable.type = 'button';
    enable.className = 'btn primary';
    enable.textContent = Notification.permission === 'granted' ? 'Re-register device' : 'Enable';
    enable.addEventListener('click', function () {
      enable.disabled = true;
      if (Notification.permission === 'granted') {
        subscribe().then(function () { toast('This device is registered'); paint(); })
          .catch(function (e) { toast(e.message, 'error'); }).then(function () { enable.disabled = false; });
        return;
      }
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { toast('Notifications were not allowed', 'error'); enable.disabled = false; paint(); return; }
        return subscribe().then(function () { toast('Notifications are on'); paint(); })
          .catch(function (e) { toast(e.message, 'error'); });
      }).then(function () { enable.disabled = false; });
    });
    row.appendChild(enable);

    var test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn';
    test.textContent = 'Send a test';
    test.addEventListener('click', function () {
      if (Notification.permission !== 'granted') { toast('Enable notifications first', 'error'); return; }
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.active) reg.active.postMessage({ type: 'test-notification' });
        toast('Test notification sent');
      });
    });
    row.appendChild(test);
    block.appendChild(row);

    // the Android app, downloadable straight from here
    var apps = document.createElement('div');
    apps.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.12);font-size:13px';
    var h = document.createElement('div');
    h.textContent = '📱 Apps';
    h.style.cssText = 'font-weight:600;margin-bottom:6px';
    apps.appendChild(h);
    var a = document.createElement('a');
    a.href = 'XCaller.apk';
    a.textContent = 'Download the Android app (.apk)';
    a.style.cssText = 'display:block;margin-bottom:4px';
    apps.appendChild(a);
    var note = document.createElement('div');
    note.style.cssText = 'opacity:.7';
    note.textContent = isIos()
      ? 'On iPhone: tap Share → Add to Home Screen, then open it from the icon — notifications work from there (iOS 16.4+).'
      : 'On iPhone there is no APK — use Add to Home Screen instead.';
    apps.appendChild(note);
    block.appendChild(apps);

    body.appendChild(block);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

  window.JarvisPush = {
    subscribe: subscribe,
    test: function () { return navigator.serviceWorker.ready.then(function (r) { if (r.active) r.active.postMessage({ type: 'test-notification' }); }); },
    status: function () { return { supported: supported(), permission: supported() ? Notification.permission : 'unsupported', ios: isIos(), standalone: isStandalone() }; },
  };
})();
