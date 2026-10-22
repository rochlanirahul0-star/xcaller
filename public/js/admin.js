/**
 * XCaller — owner console logic.
 *
 * Everything the superadmin account can do: watch the numbers, search every
 * message on the server (private chats included), read any transcript, block
 * accounts, and follow a live feed. Plain DOM + fetch, no framework.
 */
(function () {
  // XCConfirm fallback (the owner console does not load the chat UI layer):
  // styled dark modal — no browser-native confirm().
  window.XCConfirm = window.XCConfirm || function (msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'xad-mask';
      var card = document.createElement('div');
      card.className = 'xad-card';
      var t = document.createElement('div');
      t.className = 'xad-text';
      t.textContent = msg;
      var row = document.createElement('div');
      row.className = 'xad-row';
      var no = document.createElement('button');
      no.type = 'button'; no.className = 'xad-btn xad-no';
      no.textContent = opts.cancel || 'Cancel';
      var yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'xad-btn xad-yes' + (opts.danger ? ' xad-danger' : '');
      yes.textContent = opts.ok || 'OK';
      no.addEventListener('click', function () { mask.remove(); resolve(false); });
      yes.addEventListener('click', function () { mask.remove(); resolve(true); });
      mask.addEventListener('click', function (e2) { if (e2.target === mask) { mask.remove(); resolve(false); } });
      row.appendChild(no); row.appendChild(yes);
      card.appendChild(t); card.appendChild(row);
      mask.appendChild(card);
      document.body.appendChild(mask);
      yes.focus();
    });
  };
  'use strict';

  var TOKEN_KEY = 'jarvis.admin.token';
  var S = { token: null, me: null, users: [], chats: [], ws: null, live: [] };

  /* ------------------------------------------------------------------ utils */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function esc(s) { return String(s == null ? '' : s); }        // textContent everywhere: never innerHTML with user data
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function when(ms) {
    if (!ms) return '—';
    var d = new Date(Number(ms)), now = Date.now(), diff = (now - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 7 * 86400) return Math.floor(diff / 86400) + ' d ago';
    return d.toLocaleDateString() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function clock(ms) {
    var d = new Date(Number(ms) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function secs(n) {
    n = Number(n) || 0;
    if (n < 60) return n + 's';
    var m = Math.floor(n / 60), s = n % 60;
    if (m < 60) return m + 'm ' + s + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'error' ? ' err' : '');
    t.hidden = false;
    clearTimeout(t.__t);
    t.__t = setTimeout(function () { t.hidden = true; }, 3200);
  }

  /* -------------------------------------------------------------------- api */

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var e = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
            e.code = j.error && j.error.code;
            e.status = r.status;
            throw e;
          }
          return j;
        });
      });
  }

  /* ------------------------------------------------------------------- gate */

  $('#gate-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('#gate-go');
    btn.disabled = true;
    $('#gate-error').hidden = true;
    fetch('api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#gate-user').value.trim(), password: $('#gate-pass').value }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        var j = res.j;
        if (!res.ok) throw new Error((j.error && j.error.message) || 'Sign in failed');
        if (!j.user || j.user.role !== 'admin') throw new Error('That account is not an administrator.');
        S.token = j.token; S.me = j.user;
        try { localStorage.setItem(TOKEN_KEY, j.token); } catch (e) {}
        enter();
      })
      .catch(function (e) {
        $('#gate-error').textContent = e.message;
        $('#gate-error').hidden = false;
        btn.disabled = false;
      });
  });

  $('#logout').addEventListener('click', function () {
    api('api/logout', { method: 'POST' }).catch(function () {});
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (S.ws) { try { S.ws.close(); } catch (e) {} }
    location.reload();
  });

  function enter() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#who-name').textContent = (S.me.displayName || S.me.username) + ' · @' + S.me.username;
    openSocket();
    loadOverview();
    loadUsers();
    loadChats();
    loadCalls();
  }

  var saved = null;
  try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  if (saved) {
    S.token = saved;
    api('api/me')
      .then(function (r) {
        if (!r.user || r.user.role !== 'admin') throw new Error('not admin');
        S.me = r.user; enter();
      })
      .catch(function () {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        S.token = null;
      });
  }

  /* ------------------------------------------------------------------ tabs */

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('on'); });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      $('#panel-' + t.dataset.tab).classList.add('on');
      // keep the numbers honest when you come back to a panel
      if (t.dataset.tab === 'overview') loadOverview();
      if (t.dataset.tab === 'users') loadUsers();
      if (t.dataset.tab === 'chats') loadChats();
      if (t.dataset.tab === 'calls') loadCalls();
      if (t.dataset.tab === 'versions') loadVersions();
    });
  });

  /* -------------------------------------------------------------- overview */

  function card(value, label) {
    var c = el('div', 'card');
    c.appendChild(el('b', null, String(value)));
    c.appendChild(el('span', null, label));
    return c;
  }
  /** 14-day message activity — dependency-free CSS bar chart (Phase 2). */
  function renderActivity(days) {
    var box = $('#activity');
    if (!box) return;
    box.textContent = '';
    if (!days.length) return;
    var max = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));
    var chart = el('div', 'activity-chart');
    days.forEach(function (d) {
      var bar = el('div', 'activity-bar' + (d.n ? '' : ' zero'));
      var h = Math.max(4, Math.round((d.n / max) * 100));
      bar.style.height = h + '%';
      bar.title = d.label + ': ' + d.n + ' messages';
      var fill = el('span', 'activity-fill');
      bar.appendChild(fill);
      bar.appendChild(el('span', 'activity-count', d.n ? String(d.n) : ''));
      chart.appendChild(bar);
      var lab = el('span', 'activity-label', d.label.slice(3));
      chart.appendChild(lab);
    });
    box.appendChild(el('h2', null, 'Messages — last 14 days'));
    box.appendChild(chart);
  }

  function loadOverview() {
    api('api/admin/stats').then(function (r) {
      var s = r.stats, box = $('#stats');
      box.textContent = '';
      box.appendChild(card(s.users, 'accounts'));
      box.appendChild(card(s.onlineNow, 'online right now'));
      box.appendChild(card(s.messages, 'messages')); 
      box.appendChild(card(s.messagesToday, 'messages today'));
      box.appendChild(card(s.directChats, 'direct chats'));
      box.appendChild(card(s.groupChats, 'group chats'));
      box.appendChild(card(s.calls, 'calls placed'));
      box.appendChild(card(s.activeCalls, 'calls in progress'));
      box.appendChild(card(s.admins, 'administrators'));
      box.appendChild(card(s.banned, 'blocked accounts'));
      renderActivity(r.messagesPerDay || []);
    }).catch(function (e) { toast(e.message, 'error'); });
    api('api/admin/audit').then(function (r) {
      var box = $('#audit');
      box.textContent = '';
      var rows = r.audit || [];
      if (!rows.length) { box.appendChild(el('div', 'item', el('div', 'sub', 'No admin actions recorded yet.'))); return; }
      rows.forEach(function (a) {
        var it = el('div', 'item');
        var g = el('div', 'grow');
        g.appendChild(el('div', 'title', a.action + ' → ' + (a.detail || a.target)));
        g.appendChild(el('div', 'sub', 'by @' + (a.adminUsername || ('#' + a.admin_id)) + ' · ' + when(a.at)));
        it.appendChild(g);
        box.appendChild(it);
      });
    }).catch(function (e) { toast(e.message, 'error'); });
    api('api/admin/users').then(function (r) {
      S.users = r.users || [];
      var box = $('#recent');
      box.textContent = '';
      S.users.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 6).forEach(function (u) {
        var it = el('div', 'item');
        var g = el('div', 'grow');
        g.appendChild(el('div', 'title', u.displayName + '  @' + u.username));
        g.appendChild(el('div', 'sub', 'joined ' + when(u.createdAt) + ' · ' + u.messageCount + ' messages · ' + u.chatCount + ' chats'));
        it.appendChild(g);
        if (u.role === 'admin') it.appendChild(el('span', 'pill admin', 'administrator'));
        box.appendChild(it);
      });
      if (!box.children.length) box.appendChild(el('div', 'empty', 'No accounts yet.'));
    }).catch(function () {});
  }

  /* ----------------------------------------------------------------- users */

  $('#users-reload').addEventListener('click', loadUsers);
  $('#user-q').addEventListener('input', paintUsers);
  $('#user-banned-only').addEventListener('change', paintUsers);

  function loadUsers() {
    api('api/admin/users').then(function (r) { S.users = r.users || []; paintUsers(); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function paintUsers() {
    var q = ($('#user-q').value || '').trim().toLowerCase();
    var bannedOnly = $('#user-banned-only').checked;
    var box = $('#users');
    box.textContent = '';
    var list = S.users.filter(function (u) {
      if (bannedOnly && !u.banned) return false;
      if (!q) return true;
      return (u.username + ' ' + u.displayName).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { box.appendChild(el('div', 'empty', 'Nobody matches.')); return; }
    list.forEach(function (u) {
      var it = el('div', 'item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'title', u.displayName + '  @' + u.username + '  #' + u.id));
      g.appendChild(el('div', 'sub', u.messageCount + ' messages · ' + u.chatCount + ' chats · joined ' + when(u.createdAt) + ' · last seen ' + when(u.lastSeen)));
      it.appendChild(g);
      if (u.role === 'admin') it.appendChild(el('span', 'pill admin', 'administrator'));
      if (u.online) it.appendChild(el('span', 'pill online', 'online'));
      if (u.banned) it.appendChild(el('span', 'pill banned', 'blocked'));

      var acts = el('div', 'actions');
      var b = el('button', 'small' + (u.banned ? '' : ' danger'), u.banned ? 'Unblock' : 'Block');
      b.addEventListener('click', function () {
        var ask = u.banned ? 'Unblock @' + u.username + '?' : 'Block @' + u.username + '? They lose access immediately.';
        XCConfirm(ask, { ok: u.banned ? 'Unblock' : 'Block', danger: !u.banned }).then(function (ok2) {
          if (!ok2) return;
          b.disabled = true;
          api('api/admin/users/' + u.id + '/' + (u.banned ? 'unban' : 'ban'), { method: 'POST' })
            .then(function () { u.banned = u.banned ? 0 : 1; paintUsers(); toast((u.banned ? 'Blocked ' : 'Unblocked ') + '@' + u.username); })
            .catch(function (e) { b.disabled = false; toast(e.message, 'error'); });
        });
      });
      acts.appendChild(b);
      if (u.username !== 'admin') {
        var r = el('button', 'small ghost', u.role === 'admin' ? 'Remove admin' : 'Make admin');
        r.addEventListener('click', function () {
          r.disabled = true;
          api('api/admin/users/' + u.id + '/role', { method: 'POST', body: { role: u.role === 'admin' ? 'user' : 'admin' } })
            .then(function (res) { u.role = res.user.role; paintUsers(); toast('Role updated for @' + u.username); })
            .catch(function (e) { r.disabled = false; toast(e.message, 'error'); });
        });
        acts.appendChild(r);
      }
      var ms = el('button', 'small ghost', 'Their messages');
      ms.addEventListener('click', function () {
        switchTab('messages');
        $('#msg-form').dispatchEvent(new Event('submit'));
        $('#messages').textContent = '';
        $('#messages').appendChild(el('div', 'empty', 'Loading…'));
        api('api/admin/messages?userId=' + u.id + '&limit=200').then(function (r) { paintMessages(r.messages || [], '@' + u.username); })
          .catch(function (e) { toast(e.message, 'error'); });
        $('#msg-q').value = '';
      });
      acts.appendChild(ms);
      it.appendChild(acts);
      box.appendChild(it);
    });
  }

  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('on', x.dataset.tab === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (x) { x.classList.toggle('on', x.id === 'panel-' + name); });
  }

  /* ----------------------------------------------------------------- chats */

  $('#chats-reload').addEventListener('click', loadChats);
  $('#chats-direct').addEventListener('change', paintChats);

  function loadChats() {
    api('api/admin/chats').then(function (r) { S.chats = r.chats || []; paintChats(); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function chatLabel(c) {
    if (c.kind === 'group') return c.title || 'Group #' + c.id;
    var names = (c.members || []).map(function (m) { return m.username; });
    return 'Direct · ' + names.join(' ↔ ');
  }

  function paintChats() {
    var directOnly = $('#chats-direct').checked;
    var box = $('#chats');
    box.textContent = '';
    var list = S.chats.filter(function (c) { return !directOnly || c.kind === 'direct'; });
    if (!list.length) { box.appendChild(el('div', 'empty', 'No chats yet.')); return; }
    list.slice().sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); }).forEach(function (c) {
      var it = el('div', 'item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'title', chatLabel(c) + '  (#' + c.id + ')'));
      var last = c.lastMessage;
      g.appendChild(el('div', 'sub', (c.members || []).length + ' members · ' + c.messageCount + ' messages · last activity ' + when(c.lastActivity)
        + (last ? ' — ' + (last.body || ('[' + last.kind + ']')).slice(0, 60) : '')));
      it.appendChild(g);
      it.appendChild(el('span', 'pill ' + (c.kind === 'direct' ? 'direct' : ''), c.kind === 'direct' ? '1-to-1' : 'group'));
      var open = el('button', 'small ghost', 'Open transcript');
      open.addEventListener('click', function () { openTranscript(c.id, chatLabel(c)); });
      it.appendChild(open);
      box.appendChild(it);
    });
  }

  function openTranscript(chatId, label) {
    $('#viewer').hidden = false;
    $('#viewer-title').textContent = label;
    $('#viewer-sub').textContent = 'read-only';
    var body = $('#viewer-body');
    body.textContent = '';
    body.appendChild(el('div', 'empty', 'Loading…'));
    api('api/admin/chats/' + chatId + '/messages?limit=200').then(function (r) {
      var msgs = r.messages || [];
      body.textContent = '';
      if (!msgs.length) { body.appendChild(el('div', 'empty', 'No messages in this chat.')); return; }
      msgs.forEach(function (m) {
        var d = el('div', 'msg' + (m.deleted ? ' deleted' : ''));
        var meta = el('div', 'meta');
        meta.appendChild(el('span', null, '@' + (m.senderUsername || m.senderId)));
        meta.appendChild(el('span', null, new Date(m.createdAt).toLocaleString()));
        if (m.kind !== 'text') meta.appendChild(el('span', null, m.kind));
        d.appendChild(meta);
        d.appendChild(el('div', 'body', m.deleted ? '(deleted)' : (m.body || '')));
        if (m.attachment) {
          var a = el('div', 'att');
          var link = el('a', null, m.attachment.name || m.attachment.path);
          link.href = m.attachment.path;
          link.target = '_blank';
          a.appendChild(link);
          a.appendChild(el('span', null, ' · ' + Math.round((m.attachment.size || 0) / 1024) + ' KB'));
          d.appendChild(a);
        }
        body.appendChild(d);
      });
      body.scrollTop = body.scrollHeight;
    }).catch(function (e) { body.textContent = ''; body.appendChild(el('div', 'empty', e.message)); });
  }
  $('#viewer-close').addEventListener('click', function () { $('#viewer').hidden = true; });

  // A console can sit on a phone with old CSS/JS for days; one tap gets the current page.
  var reloadBtn = $('#reload');
  if (reloadBtn) reloadBtn.addEventListener('click', function () {
    var url = location.pathname + '?r=' + Date.now();
    location.replace(url);
  });

  // If the page ever renders empty, say so instead of showing a blank sheet.
  window.addEventListener('error', function (ev) {
    var v = $('#viewer');
    if (!v || v.hidden) return;
    var body = $('#viewer-body');
    if (body && !body.children.length) body.appendChild(el('div', 'empty', 'Something went wrong loading this transcript — tap Close and try again.'));
  });

  /* -------------------------------------------------------------- messages */

  $('#msg-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('#msg-q').value.trim();
    var user = $('#msg-user').value.trim().replace(/^@/, '');
    var chatId = $('#msg-chat').value.trim();
    var params = ['limit=200'];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (chatId) params.push('chatId=' + encodeURIComponent(chatId));
    var box = $('#messages');
    box.textContent = '';
    box.appendChild(el('div', 'empty', 'Searching…'));
    var done = function (r, label) { paintMessages(r.messages || [], label || ''); };
    if (user) {
      var found = S.users.filter(function (u) { return u.username === user; })[0];
      if (!found) { box.textContent = ''; box.appendChild(el('div', 'empty', 'No account named @' + user)); return; }
      params.push('userId=' + found.id);
      done = function (r) { paintMessages(r.messages || [], '@' + user); };
    }
    api('api/admin/messages?' + params.join('&')).then(done)
      .catch(function (e) { box.textContent = ''; box.appendChild(el('div', 'empty', e.message)); });
  });

  function paintMessages(msgs, label) {
    var box = $('#messages');
    box.textContent = '';
    var head = el('div', 'hint', (label ? label + ' — ' : '') + msgs.length + ' message' + (msgs.length === 1 ? '' : 's'));
    box.appendChild(head);
    if (!msgs.length) { box.appendChild(el('div', 'empty', 'Nothing found.')); return; }
    msgs.forEach(function (m) {
      var it = el('div', 'item');
      var g = el('div', 'grow');
      g.appendChild(el('div', 'title', '@' + m.senderUsername + ' → ' + (m.chatKind === 'group' ? ('group ' + (m.chatTitle || m.chatId)) : ('chat ' + m.chatId))));
      g.appendChild(el('div', 'sub', (m.body || ('[' + m.kind + ']')) + '  ·  ' + new Date(m.createdAt).toLocaleString()));
      it.appendChild(g);
      var open = el('button', 'small ghost', 'Open chat');
      open.addEventListener('click', function () {
        var c = S.chats.filter(function (x) { return x.id === m.chatId; })[0];
        openTranscript(m.chatId, c ? chatLabel(c) : 'Chat #' + m.chatId);
      });
      it.appendChild(open);
      box.appendChild(it);
    });
  }

  /* ----------------------------------------------------------------- calls */

  $('#calls-reload').addEventListener('click', loadCalls);
  function loadCalls() {
    api('api/admin/calls').then(function (r) {
      var box = $('#calls');
      box.textContent = '';
      var calls = r.calls || [];
      if (!calls.length) { box.appendChild(el('div', 'empty', 'No calls yet.')); return; }
      calls.forEach(function (c) {
        var it = el('div', 'item');
        var g = el('div', 'grow');
        g.appendChild(el('div', 'title', (c.kind === 'video' ? 'Video call' : 'Voice call') + ' · chat ' + c.chatId));
        g.appendChild(el('div', 'sub', 'started by @' + (c.starterUsername || c.startedBy) + ' ' + when(c.startedAt)
          + ' · ' + c.participantCount + ' joined: ' + c.participants.map(function (p) { return '@' + p.username; }).join(', ')));
        it.appendChild(g);
        it.appendChild(el('span', 'pill', secs(c.duration)));
        if (c.inProgress) it.appendChild(el('span', 'pill online', 'in progress'));
        box.appendChild(it);
      });
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  /* ------------------------------------------------------------------ live */

  function openSocket() {
    var base = location.pathname.replace(/[^/]*$/, '');
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws?token=' + encodeURIComponent(S.token);
    var ws = new WebSocket(url);
    S.ws = ws;
    ws.addEventListener('open', function () { $('#live-dot').classList.add('on'); pushLive('Connected to the live feed'); });
    ws.addEventListener('close', function () {
      $('#live-dot').classList.remove('on');
      pushLive('Feed disconnected — reconnecting');
      setTimeout(function () { if (S.token) openSocket(); }, 4000);
    });
    ws.addEventListener('message', function (ev) {
      var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === 'admin.message') {
        var chat = f.chat || {};
        pushLive('@' + (f.message.senderUsername || f.message.senderId) + ' in ' + (chat.kind === 'group' ? ('group ' + (chat.title || chat.id)) : ('chat ' + chat.id)) + ': ' + (f.message.body || '[' + f.message.kind + ']'));
      } else if (f.t === 'admin.presence') {
        pushLive('@? user #' + f.userId + (f.online ? ' came online' : ' went offline'));
      } else if (f.t === 'ready') {
        pushLive('Signed in as @' + (f.user && f.user.username));
      }
    });
  }

  /* -------------------------------------------------------------- versions */

  function cmpV(a, b) {
    var pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function loadVersions() {
    Promise.all([api('api/admin/users'), fetch('api/version').then(function (r) { return r.json(); })])
      .then(function (res) { paintVersions(res[0].users || [], res[1]); })
      .catch(function (e) { toast(e.message || 'load failed', 'error'); });
  }

  function paintVersions(users, ver) {
    var cur = (ver && ver.version) || '?';
    $('#ver-current').textContent = 'Current release: ' + cur + (ver && ver.notes ? ' — ' + ver.notes : '');
    var apk = location.origin + ((ver && ver.apk) || '/chat/XCaller.apk');
    $('#ver-apk-link').textContent = apk;
    var box = $('#versions'); box.textContent = '';
    var outdated = 0;
    users.filter(function (u) { return u.role !== 'admin'; })
      .sort(function (a, b) { return cmpV(a.appVersion || '0', b.appVersion || '0'); })
      .forEach(function (u) {
        var v = u.appVersion || '?';
        var old = v !== 'web' && v !== '?' && cmpV(cur, v) > 0;
        if (old) outdated++;
        var it = el('div', 'item');
        var g = el('div', 'grow');
        g.appendChild(el('div', 'title', u.displayName + '  @' + u.username));
        g.appendChild(el('div', 'sub', 'app ' + v + ' (as of ' + when(u.appVersionAt) + ') · last seen ' + when(u.lastSeen)));
        it.appendChild(g);
        it.appendChild(el('span', 'pill' + (old ? ' warn' : ''), old ? 'UPDATE NEEDED' : (v === 'web' || v === '?' ? 'browser/—' : 'up to date')));
        box.appendChild(it);
      });
    $('#ver-announce').disabled = outdated === 0;
    var pill = $('#ver-refresh'); pill.title = outdated ? outdated + ' user(s) behind' : 'everyone current';
  }

  $('#ver-refresh').addEventListener('click', loadVersions);
  $('#ver-copy').addEventListener('click', function () {
    var t = $('#ver-apk-link').textContent;
    var ta = document.createElement('textarea'); ta.value = t;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('APK link copied'); } catch (e) { toast('copy failed — select it manually', 'error'); }
    document.body.removeChild(ta);
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
  });
  $('#ver-announce').addEventListener('click', function () {
    api('api/version').then(function (v) {
      return XCConfirm('Push the mandatory update notice for ' + v.version + ' to every user? Open apps get the modal now; closed apps get a notification on next sync.', {});
    }).then(function (go) {
      if (!go) return;
      return api('api/version').then(function (v) {
        return api('api/admin/announce', { method: 'POST', body: { version: v.version, title: 'XCaller ' + v.version + ' is here', body: v.notes || 'Tap Update in the app to install it.' } })
          .then(function (r) { toast('Noticed ' + (r.told || 0) + ' user(s)'); });
      });
    }).catch(function (e) { toast(e.message || 'failed', 'error'); });
  });

  function pushLive(text) {
    var box = $('#live');
    var it = el('div', 'item');
    var g = el('div', 'grow');
    g.appendChild(el('div', 'sub', text));
    it.appendChild(el('span', 'pill', clock()));
    it.appendChild(g);
    box.insertBefore(it, box.firstChild);
    while (box.children.length > 200) box.removeChild(box.lastChild);
  }
})();
