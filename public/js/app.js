/* ==========================================================================
   XCaller — UI client (vanilla JS, no build step, no CDN, relative URLs)
   Owns: auth, chat list, message rendering, composer, attachments, modals,
         the single WebSocket (window.Net) and the window.UI hooks.
   Server contract: SPEC.md (REST under /chat/api/..., WS at /chat/ws?token=...)
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------- helpers -------------------------------- */

  var TOKEN_KEY = 'jarvis.token';           // only the session token is ever stored
  var USERNAME_RE = /^[a-z0-9_]{3,20}$/;
  var PAGE_LIMIT = 50;
  var GROUP_WINDOW = 5 * 60 * 1000;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  /** Escape ALL user text that is ever placed into an HTML string. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function txt(s) { return String(s == null ? '' : s); }

  /** Directory of the current page, so every URL stays relative to /chat/ . */
  function dirOf(p) {
    p = String(p || location.pathname);
    if (p.charAt(p.length - 1) === '/') return p;
    return p.slice(0, p.lastIndexOf('/') + 1);
  }
  function base() { return dirOf(location.pathname); }

  function ms(t) {                                  // accept seconds or millis
    var n = Number(t);
    if (!isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(t) {
    var d = new Date(ms(t) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function dayKey(t) {
    var d = new Date(ms(t) || Date.now());
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function fmtDay(t) {
    var d = new Date(ms(t) || Date.now());
    var now = new Date();
    var today = dayKey(now.getTime());
    var y = new Date(now.getTime() - 86400000);
    if (dayKey(d.getTime()) === today) return 'Today';
    if (dayKey(d.getTime()) === dayKey(y.getTime())) return 'Yesterday';
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function fmtDur(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), sec = t % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtListTime(t) {
    t = ms(t);
    if (!t) return '';
    var d = new Date(t);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(t);
    var diff = now - d;
    if (diff < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  }
  function isImageMime(m) { return /^image\//i.test(String(m || '')); }
  function initial(name) {
    var s = txt(name).replace(/^@/, '').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }
  var PALETTE = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
  function colorFor(u) {
    var c = u && (u.avatarColor || u.avatar_color);
    if (c) return String(c);
    var s = txt(u && (u.username || u.displayName || u.display_name)).toLowerCase();
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function paintAvatar(node, user, label) {
    if (!node) return;
    node.textContent = initial(label != null ? label : (user && (user.displayName || user.display_name || user.username)));
    node.style.background = user ? colorFor(user) : '#3f5d79';
  }

  function normUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName != null ? u.displayName : (u.display_name != null ? u.display_name : u.username),
      bio: u.bio != null ? u.bio : '',
      avatarColor: u.avatarColor || u.avatar_color || '',
      online: !!u.online,
      lastSeen: Number(u.lastSeen || u.last_seen || 0),
      role: u.role || 'user'
    };
  }

  function normAttachment(m) {
    var a = m.attachment;
    if (!a && (m.attachmentPath || m.attachment_path)) {
      a = {
        path: m.attachmentPath || m.attachment_path,
        name: m.attachmentName || m.attachment_name,
        mime: m.attachmentMime || m.attachment_mime,
        size: m.attachmentSize || m.attachment_size
      };
    }
    if (!a || !a.path) return null;
    return { path: a.path, name: a.name || 'file', mime: a.mime || '', size: a.size || 0 };
  }

  function normMsg(m) {
    if (!m) return null;
    return {
      id: m.id != null ? m.id : null,
      chatId: m.chatId != null ? m.chatId : m.chat_id,
      senderId: m.senderId != null ? m.senderId : m.sender_id,
      body: m.body != null ? String(m.body) : '',
      kind: m.kind || 'text',
      attachment: normAttachment(m),
      createdAt: ms(m.createdAt != null ? m.createdAt : m.created_at) || Date.now(),
      deliveredAt: ms(m.deliveredAt != null ? m.deliveredAt : m.delivered_at),
      editedAt: ms(m.editedAt != null ? m.editedAt : m.edited_at),
      deleted: !!(m.deleted || m.deleted_at),
      clientId: m.clientId || m.client_id || null,
      replyTo: m.replyTo != null ? m.replyTo : (m.reply_to != null ? m.reply_to : null),
      quote: m.quote || null,
      reactions: m.reactions || null,
      state: m.id != null ? 'sent' : 'pending'
    };
  }

  function normChat(c) {
    if (!c) return null;
    var members = (c.members || []).map(normUser).filter(Boolean);
    return {
      id: c.id,
      kind: c.kind || 'direct',
      title: c.title || '',
      members: members,
      lastMessage: normMsg(c.lastMessage || c.last_message),
      unread: Number(c.unread || 0) || 0,
      updatedAt: ms(c.updatedAt != null ? c.updatedAt : c.updated_at) ||
                 ms(c.lastMessage ? (c.lastMessage.createdAt || c.lastMessage.created_at) : 0) || Date.now()
    };
  }

  /* -------------------------------- state --------------------------------- */

  var S = {
    token: null,
    me: null,
    chats: [],
    chatState: new Map(),        // chatId -> { msgs:[], ids:Set, loaded:bool, hasMore:bool, readAt:0 }
    openChatId: null,
    typing: new Map(),           // chatId -> Set(userId)
    typingTimers: new Map(),
    typingWhat: new Map(),       // 'chatId:userId' -> 'file' | 'photo' | 'voice' | 'text'
    myTypingOn: {},              // chatId -> bool
    myTypingWhat: {},            // chatId -> 'text' | 'file' | 'photo' | 'voice'
    myTypingTimer: {},
    myTypingSentAt: {},          // chatId -> last time a typing frame went out
    pendingAttachment: null,     // {path,name,mime,size}
    pendingEls: new Map(),       // clientId -> element
    searchTimer: null,
    searchTerm: '',
    pendingCall: null,
    currentCall: null,
    callTimerId: null,
    callStartedAt: 0
  };

  function cstate(chatId) {
    var st = S.chatState.get(chatId);
    if (!st) {
      st = { msgs: [], ids: new Set(), loaded: false, hasMore: true, readAt: 0, loadingOlder: false };
      S.chatState.set(chatId, st);
    }
    return st;
  }
  function chatById(id) {
    for (var i = 0; i < S.chats.length; i++) if (String(S.chats[i].id) === String(id)) return S.chats[i];
    return null;
  }
  function memberById(chat, id) {
    if (!chat || !chat.members) return null;
    for (var i = 0; i < chat.members.length; i++) if (String(chat.members[i].id) === String(id)) return chat.members[i];
    return null;
  }
  function otherMember(chat) {
    if (!chat || !chat.members || !S.me) return null;
    for (var i = 0; i < chat.members.length; i++) {
      if (String(chat.members[i].id) !== String(S.me.id)) return chat.members[i];
    }
    return chat.members[0] || null;
  }
  function chatTitle(chat) {
    if (!chat) return 'Chat';
    if (chat.kind === 'group') return chat.title || 'Group';
    var o = otherMember(chat);
    return (o && (o.displayName || o.username)) || chat.title || 'Chat';
  }
  function chatPeerUser(chat) {
    if (!chat) return null;
    if (chat.kind === 'group') return null;
    return otherMember(chat);
  }

  /* -------------------------------- api ----------------------------------- */

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
    var body = opts.body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: body,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        if (!res.ok) {
          var err = new Error(
            (data && data.error && (data.error.message || data.error.code)) || ('HTTP ' + res.status)
          );
          err.status = res.status;
          err.code = data && data.error && data.error.code;
          throw err;
        }
        return data;
      });
    });
  }

  /** Uploaded files live under the deployment root, e.g. /chat/uploads/<file>. */
  function attachUrl(p) {
    p = txt(p);
    if (!p) return '';
    if (/^https?:\/\//i.test(p) || p.indexOf('data:') === 0) return p;
    var s = p.replace(/^\.?\//, '');
    var i = s.indexOf('uploads/');
    if (i >= 0) s = s.slice(i);
    else s = 'uploads/' + s.split('/').filter(Boolean).pop();
    return base() + s;
  }

  function errMsg(e) {
    var code = e && e.code;
    switch (code) {
      case 'username_taken': return 'That username is already taken. Please choose another one.';
      case 'reserved_username': return 'That username is reserved. Please choose another one.';
      case 'bad_username': return 'Username must be 3–20 characters: a–z, 0–9 or underscore.';
      case 'bad_password': return 'That password is not accepted (use 6+ characters).';
      case 'bad_credentials': return 'Wrong username or password.';
      case 'forbidden': return 'Not authorised.';
      case 'file_too_large': return 'That file is too large (max 200 MB).';
      default: return (e && e.message) || 'Something went wrong.';
    }
  }

  /* ------------------------------ toast/UI bits ---------------------------- */

  function toast(msg, kind) {
    var box = $('#toast');
    if (!box) return;
    var item = el('div', 'toast-item' + (kind === 'error' ? ' error' : ''), msg);
    box.appendChild(item);
    setTimeout(function () {
      item.style.transition = 'opacity .2s ease';
      item.style.opacity = '0';
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 220);
    }, 2800);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  /* -------------------------------- auth ---------------------------------- */

  /* Telegram-style entry: a device that has never had an account here starts on
     "create account"; a device that has logged in before starts on the log-in
     form with the username already filled in. */
  var INVITE_KEY = 'jarvis.invite';
  /** ?join=TOKEN — someone shared a group link with this device. */
  var INVITE = (function () {
    try {
      var m = location.search.match(/[?&]join=([A-Za-z0-9_-]{4,64})/);
      if (m && m[1]) { sessionStorage.setItem(INVITE_KEY, m[1]); return m[1]; }
      return sessionStorage.getItem(INVITE_KEY) || '';
    } catch (e) { return ''; }
  })();
  function forgetInvite() { try { sessionStorage.removeItem(INVITE_KEY); } catch (e) { /* ignore */ } INVITE = ''; }

  /** The blue strip on the sign-up screen: "you have been invited to …". */
  function showInviteBanner() {
    if (!INVITE) return;
    var box = $('#invite-banner');
    if (!box) return;
    api('api/invite/' + encodeURIComponent(INVITE)).then(function (r) {
      if (!r || !r.valid || r.chatKind !== 'group') { forgetInvite(); return; }
      box.hidden = false;
      $('#invite-title').textContent = 'You are invited to ' + (r.chatTitle || 'a group');
      $('#invite-sub').textContent = (r.inviterName || 'Someone') + ' invited you' +
        (r.memberCount ? ' · ' + r.memberCount + ' member' + (r.memberCount === 1 ? '' : 's') : '') +
        '. Create your account and you will join automatically.';
    }).catch(function () { /* a dead link must never block sign-up */ });
  }

  /** After registering/logging in from a link, walk into the group. */
  function enterInvitedChat(joined) {
    if (!joined || !joined.chatId) { if (INVITE) forgetInvite(); return; }
    forgetInvite();
    var box = $('#invite-banner'); if (box) box.hidden = true;
    toast('You joined ' + (joined.title || 'the group'));
    setTimeout(function () { try { openChat(joined.chatId); } catch (e) { /* list refresh will show it */ } }, 600);
  }

  var KNOWN_KEY = 'jarvis.knownUser';
  function knownUser() { try { return localStorage.getItem(KNOWN_KEY) || ''; } catch (e) { return ''; } }
  function rememberUser(u) { try { if (u) localStorage.setItem(KNOWN_KEY, u); } catch (e) { /* storage blocked */ } }

  function showAuth(which) {
    if (INVITE && !which) which = 'register';       // invited people are new here
    showInviteBanner();
    var auth = $('#auth');
    auth.hidden = false;
    $('#app').hidden = true;
    document.body.classList.remove('chat-open');
    var known = knownUser();
    var toLogin = which === 'login' ? true : (which === 'register' ? false : !!known);
    $('#login-form').hidden = !toLogin;
    $('#register-form').hidden = toLogin;
    if (toLogin && known && $('#login-username') && !$('#login-username').value) {
      $('#login-username').value = known;
      setTimeout(function () { var p = $('#login-password'); if (p) p.focus(); }, 0);
    } else if (!toLogin) {
      setTimeout(function () { var u = $('#reg-username'); if (u) u.focus(); }, 0);
    }
  }
  function showApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
  }

  function busyForm(formId, on) {
    $$('button[type="submit"]', $(formId)).forEach(function (b) { b.disabled = !!on; });
  }

  function setErr(id, msg) {
    var n = $(id);
    if (n) n.textContent = msg || '';
  }

  function doLogin(ev) {
    ev.preventDefault();
    var u = $('#login-username').value.trim().toLowerCase();
    var p = $('#login-password').value;
    setErr('#login-error', '');
    if (!u || !p) { setErr('#login-error', 'Enter your username and password.'); return; }
    busyForm('#login-form', true);
    api('api/login', { method: 'POST', body: { username: u, password: p, invite: INVITE || undefined } })
      .then(function (r) {
        if (!r || !r.token) throw new Error('Malformed response.');
        setToken(r.token);
        rememberUser(u);
        $('#login-password').value = '';
        startSession(r.user);
        enterInvitedChat(r.joined);
      })
      .catch(function (e) { setErr('#login-error', errMsg(e)); })
      .then(function () { busyForm('#login-form', false); });
  }

  function doRegister(ev) {
    ev.preventDefault();
    var u = $('#reg-username').value.trim().toLowerCase();
    var d = $('#reg-display').value.trim();
    var p = $('#reg-password').value;
    setErr('#register-error', '');
    if (!USERNAME_RE.test(u)) {
      setErr('#register-error', 'Username must be 3–20 characters: a–z, 0–9 or underscore.');
      return;
    }
    if (!d) { setErr('#register-error', 'Please enter a display name.'); return; }
    if (p.length < 6) { setErr('#register-error', 'Password must be at least 6 characters.'); return; }
    busyForm('#register-form', true);
    // never let the same username through twice — ask the server first
    api('api/username-check', { method: 'POST', body: { username: u } })
      .then(function (chk) {
        if (chk && chk.available === false) {
          setErr('#register-error', chk.message || 'That username is already taken. Please choose another one.');
          noteUsername('');
          var f = $('#reg-username'); if (f) f.focus();
          busyForm('#register-form', false);
          throw { __handled: true };
        }
        return api('api/register', { method: 'POST', body: { username: u, password: p, displayName: d, invite: INVITE || undefined } });
      })
      .then(function (r) {
        if (!r || !r.token) throw new Error('Malformed response.');
        setToken(r.token);
        rememberUser(u);
        $('#reg-password').value = '';
        startSession(r.user);
        enterInvitedChat(r.joined);
      })
      .catch(function (e) {
        if (e && e.__handled) return;
        setErr('#register-error', errMsg(e));
      })
      .then(function () { busyForm('#register-form', false); });
  }

  /** The little line under the username field: free / taken / invalid. */
  function noteUsername(msg, ok) {
    var n = $('#reg-username-note');
    if (!n) return;
    n.textContent = msg || '';
    n.dataset.state = msg ? (ok ? 'ok' : 'bad') : '';
  }

  function setToken(t) {
    S.token = t;
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage may be blocked */ }
  }
  function clearToken() {
    S.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function logout() {
    api('api/logout', { method: 'POST', body: {} }).catch(function () { /* best effort */ });
    teardown();
    clearToken();
    showAuth('login');
    toast('Logged out');
  }

  function teardown() {
    S.me = null;
    S.chats = [];
    S.chatState.clear();
    S.openChatId = null;
    S.pendingEls.clear();
    if (window.UI) window.UI.me = null;
    $('#chatlist').textContent = '';
    $('#messages').textContent = '';
    $('#chat-title').textContent = 'Select a chat';
    $('#chat-sub').textContent = '';
    hideIncoming();
    closeCallScreen();
    closeModal();
    ws.stop();
  }

  function startSession(user) {
    S.me = normUser(user) || S.me;
    if (window.UI) window.UI.me = S.me;
    paintMe();
    showApp();
    ws.start();
    loadChats().then(function () { applyPendingOpen(); });
  }

  /* Notification deep links: ?open=<chatId> and window.XCOpen(id) from the shell.
     On a cold start the chat list does not exist yet, so the request is parked and
     applied as soon as the chats arrive — previously the shell's click landed on an
     empty list and the tap silently did nothing (the message "disappeared"). */
  var PENDING_OPEN = null;
  function applyPendingOpen() {
    if (PENDING_OPEN == null) return;
    var id = PENDING_OPEN; PENDING_OPEN = null;
    if (document.getElementById('chatlist') && chatById(id)) openChat(id);
  }
  window.XCOpen = function (id) {
    id = String(id || '');
    var rows = document.querySelectorAll('#chatlist [data-chat-id], #chatlist .chat-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset && String(rows[i].dataset.chatId) === id) { rows[i].click(); return 'ok'; }
    }
    if (chatById(id)) { openChat(id); return 'ok'; }
    PENDING_OPEN = id;
    loadChats().then(applyPendingOpen);
    return 'parked';
  };
  (function readOpenParam() {
    try {
      var m = location.search.match(/[?&]open=([0-9]+)/);
      if (m) { PENDING_OPEN = m[1]; history.replaceState(null, '', location.pathname); }
    } catch (e) { /* ignore */ }
  })();

  function paintMe() {
    var u = S.me || {};
    var name = u.displayName || u.username || '…';
    $('#me-name').textContent = name;
    $('#me-username').textContent = (u.username ? '@' + u.username : '@…') + ' · v' + (window.XC_VERSION || '?');
    paintAvatar($('#me-avatar'), u, name);
  }

  /* ------------------------------- window.Net ------------------------------ */

  var subs = new Map();          // type -> Set<fn>
  var outQueue = [];
  var sock = null;
  var wsClosedByUs = false;
  var retry = 0;
  var retryTimer = null;
  /* Realtime green dot: the server counts a user online only while their SCREEN
     is open (or they are on a call). Report show/hide. The native app calls the
     same function from onPause/onResume, which is more reliable than browser
     events inside a WebView that gets frozen in the background. */
  var lastVisibleSent = null;
  window.XCPresenceVisible = function (on) {
    on = !!on;
    if (lastVisibleSent === on) return;
    lastVisibleSent = on;
    if (sock && sock.readyState === 1) {
      try { sock.send(JSON.stringify({ t: 'presence.visibility', on: on })); } catch (e) { /* reconnect resends */ }
    }
  };
  document.addEventListener('visibilitychange', function () {
    window.XCPresenceVisible(document.visibilityState === 'visible');
  });
  /* Android WebView silently drops idle sockets (and freezes timers when the app
     is hidden), so a "connected" socket can be a zombie delivering nothing. A
     15-second ping with a 45-second no-pong watchdog turns that silent stall into
     an immediate reconnect, which is where the message latency came from. */
  var lastPong = 0;
  var hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) return;
    hbTimer = setInterval(function () {
      if (!sock || sock.readyState !== 1) return;
      try { sock.send(JSON.stringify({ t: 'ping' })); } catch (e) { /* onclose follows */ }
      if (Date.now() - lastPong > 45000) {
        try { sock.close(); } catch (e) { /* ignore */ }   // onclose schedules the retry
      }
    }, 15000);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    // Coming back from a sleep: the socket is probably gone. Do not wait for the
    // backoff ladder — reconnect and resync right now.
    if (!sock || sock.readyState !== 1) ws.start();
    else { try { sock.send(JSON.stringify({ t: 'ping' })); } catch (e) { /* ignore */ } }
    if (S.me) { loadChats().then(applyPendingOpen); if (S.openChatId) refreshOpenChat(); }
  });

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + base() + 'ws';
  }

  function netDot(state) {
    var d = $('#net-dot');
    if (!d) return;
    d.className = 'net-dot ' + (state || '');
    d.title = state === 'open' ? 'Connected' : (state === 'closed' ? 'Disconnected' : 'Connecting');
  }

  function flushQueue() {
    if (!sock || sock.readyState !== 1) return;
    var q = outQueue;
    outQueue = [];
    for (var i = 0; i < q.length; i++) {
      try { sock.send(JSON.stringify(q[i])); } catch (e) { outQueue.push(q[i]); }
    }
  }

  var ws = {
    start: function () {
      if (!S.token) return;
      wsClosedByUs = false;
      if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
      var url;
      try { url = wsUrl(); } catch (e) { return; }
      try { sock = new WebSocket(url, ['xc-auth', S.token || '']); } catch (e) { ws.scheduleRetry(); return; }
      netDot('');
      startHeartbeat();

      sock.onopen = function () {
        retry = 0;
        netDot('open');
        lastPong = Date.now();
        try { sock.send(JSON.stringify({ t: 'hello' })); } catch (e) { /* ignore */ }
        // fresh socket starts as "visible" on the server; tell it the truth
        // (a backgrounded WebView that just reconnected must not look online)
        lastVisibleSent = null;
        window.XCPresenceVisible(document.visibilityState === 'visible');
        flushQueue();
        // Re-sync anything that may have moved while we were away.
        if (S.me) {
          loadChats().then(applyPendingOpen);
          if (S.openChatId) sendRead(S.openChatId, true);
        }
      };
      sock.onmessage = function (ev) {
        var frame = null;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        if (frame && frame.t === 'pong') { lastPong = Date.now(); return; }
        if (frame && frame.t) handleFrame(frame);
      };
      sock.onerror = function () { /* onclose follows */ };
      sock.onclose = function () {
        netDot('closed');
        sock = null;
        if (!wsClosedByUs) ws.scheduleRetry();
      };
    },
    scheduleRetry: function () {
      if (wsClosedByUs || !S.token) return;
      // On a call the socket IS the call: signal frames die with it. Retry in well
      // under a second instead of the message backoff ladder, which used to leave
      // both sides staring at a frozen screen until the room was retired.
      var inCall = window.Calls && window.Calls.state && !!window.Calls.state().callId;
      retry = inCall ? 1 : Math.min(retry + 1, 6);
      var wait = inCall ? 350 : Math.min(500 * Math.pow(2, retry - 1), 15000) + Math.floor(Math.random() * 400);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(function () { retryTimer = null; ws.start(); }, wait);
    },
    stop: function () {
      wsClosedByUs = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      retry = 0;
      outQueue = [];
      if (sock) {
        try { sock.close(1000, 'bye'); } catch (e) { /* ignore */ }
        sock = null;
      }
      netDot('');
    }
  };

  /* window.Net — the pub/sub the calls engine depends on. */
  window.Net = {
    send: function (obj) {
      if (!obj || typeof obj !== 'object') return;
      if (sock && sock.readyState === 1) {
        try { sock.send(JSON.stringify(obj)); return; } catch (e) { /* fall through to queue */ }
      }
      if (outQueue.length < 200) outQueue.push(obj);   // queue while opening/offline, replay nothing old
      if (S.token && (!sock || sock.readyState === 3)) ws.start();
    },
    on: function (type, fn) {
      if (typeof fn !== 'function') return function () {};
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return function () { window.Net.off(type, fn); };
    },
    off: function (type, fn) {
      var set = subs.get(type);
      if (set) set.delete(fn);
    },
    isOpen: function () { return !!(sock && sock.readyState === 1); }
  };

  function dispatch(type, frame) {
    var set = subs.get(type);
    if (set) {
      set.forEach(function (fn) {
        try { fn(frame); } catch (e) { /* a bad subscriber must not break the feed */ }
      });
    }
    var all = subs.get('*');
    if (all) {
      all.forEach(function (fn) {
        try { fn(frame); } catch (e) { /* ignore */ }
      });
    }
  }

  /* ---------------------------- frame handling ----------------------------- */

  function handleFrame(frame) {
    // every frame goes to Net subscribers first (the calls engine listens there),
    // then to the UI's own rendering below.
    dispatch(frame.t, frame);
    switch (frame.t) {
      case 'ready':
        if (frame.user) {
          S.me = normUser(frame.user);
          if (window.UI) window.UI.me = S.me;
          paintMe();
        }
        break;
      case 'presence': onFramePresence(frame); break;
      case 'msg.new': onFrameMessage(frame.message); break;
      case 'msg.ack': onFrameAck(frame); break;
      case 'msg.read': onFrameRead(frame); break;
      case 'typing': onFrameTyping(frame); break;
      case 'chat.created': onFrameChatCreated(frame.chat); break;
      case 'call.incoming': onCallIncoming(frame); break;
      case 'call.joined': onCallJoined(frame); break;
      case 'call.left': onCallLeft(frame); break;
      case 'call.ended': onCallEnded(frame); break;
      case 'call.state': onCallState(frame); break;
      case 'call.signal': /* relayed straight to window.Calls via Net.on */ break;
      case 'error': toast(frame.message || frame.code || 'Server error', 'error'); break;
      default: break;
    }
  }

  function onFramePresence(frame) {
    var uid = frame.userId;
    var online = !!frame.online;
    S.chats.forEach(function (c) {
      if (!c.members) return;
      c.members.forEach(function (m) {
        if (String(m.id) !== String(uid)) return;
        m.online = online;
        if (!online && frame.at) m.lastSeen = frame.at;
      });
    });
    if (S.openChatId) {
      var c = chatById(S.openChatId);
      if (c && chatPeerUser(c) && String(chatPeerUser(c).id) === String(uid)) paintChatSub();
    }
    renderChatList();
  }

  function onFrameMessage(raw) {
    var msg = normMsg(raw);
    if (!msg) return;
    var chatId = msg.chatId;
    var st = chatId != null ? cstate(chatId) : null;
    var chat = chatById(chatId);

    if (st) {
      if (st.ids.has(msg.id)) return;                       // already have it (e.g. POST echo)
      if (msg.clientId && S.pendingEls.has(msg.clientId)) { reconcile(msg.clientId, msg); return; }
      // our own REST-sent message came back as msg.new before the POST response: fold it
      // into the optimistic bubble instead of showing the message twice.
      if (S.me && String(msg.senderId) === String(S.me.id)) {
        var pend = findPendingMatch(st, msg);
        if (pend) { reconcile(pend.clientId, msg); st.ids.add(msg.id); return; }
      }
      st.ids.add(msg.id);
      st.msgs.push(msg);
      if (String(chatId) === String(S.openChatId)) appendMessageNode(msg, true);
    }
    if (chat) {
      chat.lastMessage = msg;
      chat.updatedAt = msg.createdAt;
      if (String(chatId) !== String(S.openChatId)) chat.unread = (chat.unread || 0) + 1;
    } else {
      loadChats();
      return;
    }
    sortChats();
    renderChatList();
  }

  function onFrameAck(frame) {
    var cid = frame.clientId || frame.client_id;
    if (!cid) return;
    var msg = normMsg(frame.message);
    if (msg) {
      if (msg.chatId == null) msg.chatId = S.openChatId;
      var st = msg.chatId != null ? cstate(msg.chatId) : null;
      if (st) st.ids.add(msg.id);
      reconcile(cid, msg);
      var chat = chatById(msg.chatId);
      if (chat) { chat.lastMessage = msg; chat.updatedAt = msg.createdAt; sortChats(); renderChatList(); }
    } else {
      var pe = S.pendingEls.get(cid);
      if (pe) clearPendingState(pe);
    }
  }

  function findPendingMatch(st, msg) {
    for (var i = st.msgs.length - 1; i >= 0; i--) {
      var m = st.msgs[i];
      if (!m || m.state !== 'pending' || !m.clientId) continue;
      if (String(m.senderId) !== String(msg.senderId)) continue;
      if ((m.body || '') !== (msg.body || '')) continue;
      var a = m.attachment ? m.attachment.path : null;
      var b = msg.attachment ? msg.attachment.path : null;
      if (a !== b) continue;
      if (Math.abs((m.createdAt || 0) - (msg.createdAt || 0)) > 120000) continue;
      return m;
    }
    return null;
  }

  function reconcile(clientId, msg) {
    var node = S.pendingEls.get(clientId);
    S.pendingEls.delete(clientId);
    if (!node) {
      // ack for a message we no longer show (chat switched) — nothing to do
      return;
    }
    if (node.parentNode) {
      node.classList.remove('pending');
      node.dataset.id = msg.id == null ? '' : String(msg.id);
      node.dataset.ts = String(msg.createdAt || Date.now());
      node.dataset.clientId = '';
      var bubble = node.querySelector('.bubble');
      var meta = node.querySelector('.msg-meta');
      if (bubble) fillBubble(bubble, msg, meta);
      if (meta) {
        var t = meta.querySelector('.time');
        if (t) t.textContent = fmtTime(msg.createdAt);
        var ticks = meta.querySelector('.ticks');
        if (ticks) ticks.dataset.state = isRead(msg) ? 'read' : 'sent';
      }
    }
    var st = msg.chatId != null ? cstate(msg.chatId) : null;
    if (st) {
      for (var i = 0; i < st.msgs.length; i++) {
        if (st.msgs[i].clientId === clientId) {
          st.msgs[i] = msg;
          break;
        }
      }
    }
  }

  function clearPendingState(node) {
    node.classList.remove('pending');
    node.classList.add('failed');
    var ticks = node.querySelector('.ticks');
    if (ticks) ticks.dataset.state = 'failed';
  }

  function onFrameRead(frame) {
    var chatId = frame.chatId;
    if (String(chatId) === String(S.openChatId)) markRead(chatId, frame.userId, ms(frame.at) || Date.now());
  }

  function onFrameTyping(frame) {
    var chatId = frame.chatId;
    var uid = frame.userId;
    if (S.me && String(uid) === String(S.me.id)) return;
    var set = S.typing.get(chatId);
    if (!set) { set = new Set(); S.typing.set(chatId, set); }
    if (frame.on) {
      set.add(uid);
      S.typingWhat.set(chatId + ':' + uid, frame.what || 'text');
    } else {
      set.delete(uid);
      S.typingWhat.delete(chatId + ':' + uid);
    }

    var key = chatId + ':' + uid;
    if (S.typingTimers.has(key)) clearTimeout(S.typingTimers.get(key));
    if (frame.on) {
      S.typingTimers.set(key, setTimeout(function () {
        var s = S.typing.get(chatId);
        if (s) s.delete(uid);
        S.typingTimers.delete(key);
        if (String(chatId) === String(S.openChatId)) paintChatSub();
      }, 5000));
    }
    if (String(chatId) === String(S.openChatId)) paintChatSub();
  }

  function onFrameChatCreated(raw) {
    var chat = normChat(raw);
    if (!chat) return;
    var existing = chatById(chat.id);
    if (existing) {
      existing.kind = chat.kind; existing.title = chat.title;
      existing.members = chat.members.length ? chat.members : existing.members;
      existing.updatedAt = chat.updatedAt;
    } else {
      S.chats.push(chat);
    }
    sortChats();
    renderChatList();
  }

  /* ------------------------------- REST: chats ------------------------------ */

  function sortChats() {
    S.chats.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function loadChats() {
    return api('api/chats').then(function (r) {
      var list = (r && r.chats) || [];
      S.chats = list.map(normChat).filter(Boolean);
      sortChats();
      renderChatList();
    }).catch(function (e) {
      if (e && e.status === 401) hardLogout();
      else toast(errMsg(e), 'error');
    });
  }
  window.XCReloadChats = loadChats;

  function renderChatList() {
    var box = $('#chatlist');
    if (!box) return;
    box.textContent = '';
    var term = S.searchTerm.trim().toLowerCase();

    var chats = S.chats.filter(function (c) {
      if (!term) return true;
      return chatTitle(c).toLowerCase().indexOf(term) >= 0;
    });

    if (!chats.length && !term) {
      var empty = el('div', 'chatlist-empty');
      empty.appendChild(el('div', 'ce-title', 'No chats yet'));
      empty.appendChild(el('div', 'ce-sub', 'Find a person by their username and say hello — or start a group.'));
      var cta = el('button', 'btn primary', 'Find a person');
      cta.type = 'button';
      cta.addEventListener('click', function () { openNewChat(); });
      empty.appendChild(cta);
      box.appendChild(empty);
    }
    chats.forEach(function (c) { box.appendChild(chatRow(c)); });
  }

  /** Sidebar search: filters chats locally and looks people up on the server (debounced). */
  function runSearch(term) {
    S.searchTerm = term;
    renderChatList();
    var res = $('#search-results');
    if (!res) return;
    if (!term) { res.hidden = true; res.textContent = ''; return; }
    res.hidden = false;
    peopleList(term, res, startDirect);
  }

  function chatRow(chat) {
    var row = el('div', 'chat-row' + (String(chat.id) === String(S.openChatId) ? ' active' : ''));
    row.dataset.chatId = chat.id;
    row.setAttribute('role', 'listitem');

    var wrap = el('div', 'avatar-wrap');
    var av = el('span', 'avatar av-54');
    var peer = chatPeerUser(chat);
    paintAvatar(av, peer || { avatarColor: '' }, chatTitle(chat));
    wrap.appendChild(av);
    if (peer && peer.online) wrap.appendChild(el('span', 'avatar-dot'));
    row.appendChild(wrap);

    var main = el('div', 'chat-main');
    var line1 = el('div', 'chat-line');
    line1.appendChild(el('div', 'chat-title', chatTitle(chat)));
    line1.appendChild(el('div', 'chat-time', fmtListTime(chat.updatedAt)));
    main.appendChild(line1);

    var line2 = el('div', 'chat-line');
    var prev = el('div', 'chat-preview');
    var lm = chat.lastMessage;
    if (lm) {
      if (lm.kind === 'system') {
        // system events (missed call, joins) never take a "You: " prefix
        prev.appendChild(document.createTextNode(lm.body || ''));
      } else if (lm.senderId && S.me && String(lm.senderId) === String(S.me.id)) {
        prev.appendChild(el('span', 'who', chat.kind === 'group' ? 'You: ' : 'You: '));
      } else if (chat.kind === 'group' && lm.senderId) {
        var m = memberById(chat, lm.senderId);
        if (m) prev.appendChild(el('span', 'who', (m.displayName || m.username) + ': '));
      }
      var body = lm.body || (lm.attachment ? (isImageMime(lm.attachment.mime) ? '📷 Photo' : '📎 ' + lm.attachment.name) : '');
      prev.appendChild(document.createTextNode(body));
    } else {
      prev.textContent = chat.kind === 'group' ? 'Group created' : 'No messages yet';
    }
    line2.appendChild(prev);
    if (chat.unread > 0) {
      line2.appendChild(el('span', 'badge', chat.unread > 99 ? '99+' : String(chat.unread)));
    }
    main.appendChild(line2);
    row.appendChild(main);

    row.addEventListener('click', function () { openChat(chat.id); });
    return row;
  }

  function bumpChatLocal(chatId, msg) {
    var c = chatById(chatId);
    if (!c) { loadChats(); return; }
    c.lastMessage = msg;
    c.updatedAt = msg.createdAt;
    sortChats();
    renderChatList();
  }

  /* ----------------------------- open/read chat ----------------------------- */

  function openChat(chatId) {
    var chat = chatById(chatId);
    if (!chat) return;
    S.openChatId = chatId;
    document.body.classList.add('chat-open');
    $('#chat-title').textContent = chatTitle(chat);
    paintAvatar($('#chat-avatar'), chatPeerUser(chat) || { avatarColor: '' }, chatTitle(chat));
    paintChatSub();
    var box = $('#messages');
    var st = cstate(chatId);
    S.pendingEls.clear();

    // Keep whatever we already have cached until the fresh copy actually arrives.
    // Clearing first meant a failed fetch left the chat empty — messages visible in
    // the notification but gone from the thread, with no way to re-read them.
    if (!st.loaded) { box.textContent = ''; st.msgs = []; st.ids = new Set(); st.hasMore = true; }
    else renderAll(st, chatId);

    if (chat.unread) { chat.unread = 0; }
    renderChatList();

    loadMessages(chatId, null).then(function () {
      if (String(chatId) === String(S.openChatId)) {
        renderAll(st, chatId);
        box.scrollTop = box.scrollHeight;
      }
    });
    sendRead(chatId);
    if (window.matchMedia('(min-width: 820px)').matches) {
      setTimeout(function () { var i = $('#composer-input'); if (i) i.focus(); }, 0);
    }
  }

  /** Pull any messages that arrived while the socket was dead (sleep, zombie WS). */
  function refreshOpenChat() {
    if (!S.openChatId) return;
    var st = cstate(S.openChatId);
    loadMessages(S.openChatId, null).then(function () {
      if (String(S.openChatId) !== '') renderAll(st, S.openChatId);
    });
  }

  function loadMessages(chatId, before) {
    var st = cstate(chatId);
    var url = 'api/chats/' + encodeURIComponent(chatId) + '/messages?limit=' + PAGE_LIMIT;
    if (before != null && before !== '') url += '&before=' + encodeURIComponent(before);
    return api(url).then(function (r) {
      var list = ((r && r.messages) || []).map(normMsg).filter(Boolean);
      list.sort(function (a, b) { return (a.createdAt - b.createdAt) || (a.id - b.id); });
      var added = 0;
      list.forEach(function (m) {
        if (m.id != null && st.ids.has(m.id)) return;
        if (m.id != null) st.ids.add(m.id);
        st.msgs.push(m);
        added++;
      });
      st.loaded = true;
      if (list.length < PAGE_LIMIT) st.hasMore = false;
      if (!added) st.hasMore = false;
      st.msgs.sort(function (a, b) { return (a.createdAt - b.createdAt) || ((a.id || 0) - (b.id || 0)); });
      return added;
    }).catch(function (e) {
      if (e && e.status === 401) hardLogout();
      else toast(errMsg(e), 'error');
      return 0;
    });
  }

  /** Load older messages with ?before= (oldest visible message id) and keep the view steady. */
  function loadOlder() {
    var chatId = S.openChatId;
    if (!chatId) return;
    var st = cstate(chatId);
    if (st.loadingOlder || !st.hasMore) return;
    var first = null;
    for (var i = 0; i < st.msgs.length; i++) {
      if (st.msgs[i].id != null) { first = st.msgs[i]; break; }
    }
    if (!first) return;
    st.loadingOlder = true;
    var box = $('#messages');
    var prevHeight = box.scrollHeight;
    var prevTop = box.scrollTop;
    var marker = el('div', 'loading-top', 'Loading…');
    box.insertBefore(marker, box.firstChild);

    loadMessages(chatId, first.id).then(function (added) {
      if (marker.parentNode) marker.parentNode.removeChild(marker);
      st.loadingOlder = false;
      if (!added) { st.hasMore = false; return; }
      renderAll(st, chatId);
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    });
  }

  function sendRead(chatId, wsOnly) {
    if (window.Net.isOpen()) {
      window.Net.send({ t: 'read', chatId: Number(chatId) || chatId });
    } else if (!wsOnly) {
      api('api/chats/' + encodeURIComponent(chatId) + '/read', { method: 'POST', body: {} })
        .catch(function () { /* not fatal */ });
    }
  }

  /* ------------------------------ rendering ------------------------------- */

  /** Two ticks only mean something when the other device really got the message. */
  function isDelivered(msg) {
    var at = ms(msg.deliveredAt != null ? msg.deliveredAt : msg.delivered_at);
    return !!at;
  }

  function isRead(msg) {
    if (!msg) return false;
    if (msg.state === 'pending') return false;
    var st = S.chatState.get(msg.chatId);
    if (st && st.readAt && msg.createdAt && msg.createdAt <= st.readAt) return true;
    var explicit = ms(msg.readAt != null ? msg.readAt : msg.read_at);
    return !!(explicit && msg.createdAt && msg.createdAt <= explicit);
  }

  function markRead(chatId, userId, at) {
    if (S.me && String(userId) === String(S.me.id)) return;
    var st = cstate(chatId);
    st.readAt = Math.max(st.readAt || 0, at || Date.now());
    if (String(chatId) !== String(S.openChatId)) return;
    $$('#messages .msg[data-mine="1"]').forEach(function (row) {
      var ts = Number(row.dataset.ts || 0);
      var ticks = row.querySelector('.ticks');
      if (ticks && ts && ts <= st.readAt) ticks.dataset.state = 'read';
    });
  }

  function dayDividerNode(t) { return el('div', 'day-divider', fmtDay(t)); }

  function renderAll(st, chatId) {
    var box = $('#messages');
    box.textContent = '';
    S.pendingEls.clear();
    var lastDay = '';
    for (var i = 0; i < st.msgs.length; i++) {
      var m = st.msgs[i];
      var dk = dayKey(m.createdAt);
      if (dk !== lastDay) { box.appendChild(dayDividerNode(m.createdAt)); lastDay = dk; }
      var prev = st.msgs[i - 1];
      var next = st.msgs[i + 1];
      var grouped = !!(prev && String(prev.senderId) === String(m.senderId) &&
                       m.createdAt - prev.createdAt < GROUP_WINDOW && dayKey(prev.createdAt) === dk);
      var tail = !(next && String(next.senderId) === String(m.senderId) &&
                   next.createdAt - m.createdAt < GROUP_WINDOW && dayKey(next.createdAt) === dk);
      var node = buildRow(m, { grouped: grouped, tail: tail, chat: chatById(chatId) });
      box.appendChild(node);
      if (m.clientId && m.state === 'pending') S.pendingEls.set(m.clientId, node);
    }
  }

  function appendMessageNode(msg, scroll) {
    var box = $('#messages');
    if (!box) return;
    var st = cstate(msg.chatId);
    var prev = st.msgs.length >= 2 ? st.msgs[st.msgs.length - 2] : null;
    var grouped = !!(prev && String(prev.senderId) === String(msg.senderId) &&
                     msg.createdAt - prev.createdAt < GROUP_WINDOW &&
                     dayKey(prev.createdAt) === dayKey(msg.createdAt));
    if (!prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt)) {
      box.appendChild(dayDividerNode(msg.createdAt));
      grouped = false;
    }
    if (grouped) {
      var rows = $$('#messages .msg');
      var lastRow = rows[rows.length - 1];
      if (lastRow) {
        lastRow.classList.add('grouped-next');
        var lb = lastRow.querySelector('.bubble');
        if (lb) lb.classList.remove('tail');
      }
    }
    var node = buildRow(msg, { grouped: grouped, tail: true, chat: chatById(msg.chatId) });
    box.appendChild(node);
    if (msg.clientId && msg.state === 'pending') S.pendingEls.set(msg.clientId, node);
    if (scroll) {
      var near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
      if (near || (S.me && String(msg.senderId) === String(S.me.id))) box.scrollTop = box.scrollHeight;
    }
  }

  function buildRow(msg, opts) {
    opts = opts || {};
    var mine = !!(S.me && String(msg.senderId) === String(S.me.id));
    var row = el('div', 'msg ' + (mine ? 'out' : 'in') + (opts.grouped ? ' grouped' : '') +
      (msg.state === 'pending' ? ' pending' : '') + (msg.deleted ? ' deleted' : ''));
    row.dataset.id = msg.id == null ? '' : String(msg.id);
    row.dataset.clientId = msg.clientId || '';
    row.dataset.ts = String(msg.createdAt || '');
    row.dataset.senderId = msg.senderId == null ? '' : String(msg.senderId);
    row.dataset.mine = mine ? '1' : '0';
    row.__jcMsg = msg;                       // the extras layer reads quotes/reactions from here

    if (!mine) {
      var avWrap = el('div', 'msg-avatar');
      if (!opts.grouped) {
        var sender = opts.chat ? memberById(opts.chat, msg.senderId) : null;
        var av = el('span', 'avatar av-32');
        paintAvatar(av, sender || { avatarColor: '' }, sender ? (sender.displayName || sender.username) : '?');
        avWrap.appendChild(av);
      }
      row.appendChild(avWrap);
    }

    var bubble = el('div', 'bubble' + (opts.tail === false ? '' : ' tail'));
    var meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'time', fmtTime(msg.createdAt)));
    if (mine) {
      var ticks = el('span', 'ticks');
      ticks.dataset.state = msg.state === 'pending' ? 'pending'
        : (isRead(msg) ? 'read' : (isDelivered(msg) ? 'delivered' : 'sent'));
      ticks.appendChild(el('span', 'tick', '✓'));
      ticks.appendChild(el('span', 'tick', '✓'));
      meta.appendChild(ticks);
    }
    fillBubble(bubble, msg, meta, opts.chat);
    row.appendChild(bubble);
    return row;
  }

  // http(s) and www links always; plus bare domains whose ending is a real one
  // (so "telegram.org" is tappable but "photo.png" and "v1.2" are left alone).
  // http(s) and www links always; plus bare domains whose ending is a real one, so
  // "telegram.org" is tappable while "photo.png" or "v1.2" are left as plain text.
  var URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|org|net|info|biz|io|ai|app|dev|me|co|in|uk|us|de|fr|nl|ru|tv|live|link|site|online|shop|store|blog|xyz|gov|edu|to|cc|gg|fyi|so|chat)(?:\/[^\s<>"']*)?)(?![a-z0-9])/gi;

  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /**
   * Turn links inside a message into real taps, keeping everything else plain text.
   * The scan runs on the raw text and each piece is escaped as it is written, so a
   * message can never inject markup and a link can never swallow the text after it.
   */
  function linkify(text) {
    var out = '';
    var last = 0;
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      // an e-mail address is not a link ("someone@example.com")
      if (m.index > 0 && text.charAt(m.index - 1) === '@') {
        out += escapeHtml(m[0]);
        last = m.index + m[0].length;
        continue;
      }
      var tail = '';
      var url = m[0].replace(/[.,;:!?)\]]+$/, function (t) { tail = t; return ''; });
      if (!url) { out += escapeHtml(m[0]); last = m.index + m[0].length; continue; }
      // a typed link may have no scheme at all — give it one, or the phone would
      // treat "telegram.org" as a page inside the app instead of the website
      var href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'http://' + url;
      out += '<a class="msg-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>' + escapeHtml(tail);
      last = m.index + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  function fillBubble(bubble, msg, meta, chat) {
    bubble.textContent = '';
    if (msg.kind === 'system') {                      // "you joined…", "missed call"
      var isCall = /missed (voice|video) call/i.test(msg.body || '');
      if (isCall) {
        // call events render as neutral outlined event rows — never as chat bubbles:
        // no tail, no delivery ticks, no out/in bubble. Event time = msg time (secondary).
        var video = /video/i.test(msg.body);
        var rowEv = el('div', 'call-event-row');
        var card = el('div', 'call-event');
        card.setAttribute('role', 'status');
        card.setAttribute('aria-label', (msg.body || 'Missed call') + ', ' + fmtListTime(msg.createdAt || Date.now()));
        card.innerHTML = '<span class="call-ev-ic" aria-hidden="true">' +
          (video
            ? '<svg class="ic" viewBox="0 0 24 24"><path fill="currentColor" d="M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm14 3.5 4-2.5v10l-4-2.5v-5Z"/></svg>'
            : '<svg class="ic" viewBox="0 0 24 24"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1l-2.22 2.2Z"/></svg>') +
          '</span>';
        var main = el('div', 'call-ev-main');
        main.appendChild(el('div', 'call-ev-label', msg.body || 'Missed call'));
        main.appendChild(el('div', 'call-ev-time', fmtListTime(msg.createdAt || Date.now())));
        card.appendChild(main);
        // Call back: real action, only in an open chat context
        var cb = el('button', 'call-ev-cb');
        cb.type = 'button';
        cb.setAttribute('aria-label', 'Call back with ' + (video ? 'video' : 'voice') + ' call');
        cb.textContent = 'Call back';
        cb.addEventListener('click', function (ev2) {
          ev2.stopPropagation();
          if (typeof engineCall === 'function' && S.openChatId) {
            engineCall('start', [S.openChatId, video ? 'video' : 'audio'], 'Calling');
          }
        });
        card.appendChild(cb);
        rowEv.appendChild(card);
        bubble.appendChild(rowEv);
        bubble.classList.add('call-event-msg');       // kills bubble chrome (bg/tail/meta/ticks)
        return;
      }
      var line = el('div', 'msg-system', msg.body || '');
      bubble.appendChild(line);
      if (meta) bubble.appendChild(meta);
      return;
    }
    // sender name in groups
    var mine = !!(S.me && String(msg.senderId) === String(S.me.id));
    // quoted reply: a one-line pointer to the message being answered
    if (msg.quote) {
      var q = el('div', 'reply-quote');
      q.appendChild(el('b', null, (String(msg.quote.id) === String(msg.senderId) ? 'You' : (msg.quote.senderName || msg.quote.sender || 'someone')) + ': '));
      q.appendChild(document.createTextNode(msg.quote.body || ''));
      q.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var target = document.querySelector('.msg[data-id="' + msg.quote.id + '"]');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      bubble.appendChild(q);
    }
    if (!mine && chat && chat.kind === 'group') {
      var sender = memberById(chat, msg.senderId);
      if (sender) bubble.appendChild(el('span', 'sender', sender.displayName || sender.username));
    }
    // attachment — a deleted message's file/voice/photo never renders again
    if (msg.attachment && !msg.deleted) {
      var url = attachUrl(msg.attachment.path);
      if (isImageMime(msg.attachment.mime)) {
        var img = el('img', 'att-img');
        img.alt = msg.attachment.name || 'image';
        img.loading = 'lazy';
        img.src = url;
        img.addEventListener('click', function () {
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        });
        bubble.appendChild(img);
      } else if (msg.kind === 'voice' || /^audio\//i.test(msg.attachment.mime || '')) {
        // voice message player: play/pause, real seek bar, duration
        var vp = el('div', 'vm-player');
        var pbtn = el('button', 'vm-play');
        pbtn.type = 'button'; pbtn.setAttribute('aria-label', 'Play voice message');
        pbtn.textContent = '\u25B6';
        var wave = el('canvas', 'vm-wave');
        wave.height = 26;
        var dur = el('span', 'vm-dur', '\u2013\u2013:\u2013\u2013');
        vp.appendChild(pbtn); vp.appendChild(wave); vp.appendChild(dur);
        bubble.appendChild(vp);
        var audio = new Audio(); audio.preload = 'metadata'; audio.src = url;
        var drawn = false;
        function paintWave(pct, bars) {
          var c = wave, ctx = c.getContext('2d');
          var w = c.width = c.offsetWidth * (window.devicePixelRatio || 1) || c.width, h = c.height;
          ctx.clearRect(0, 0, w, h);
          var bar = Math.max(2, Math.floor(w / 36));
          for (var i2 = 0; i2 < 36; i2++) {
            var seedv = 0.25 + 0.75 * Math.abs(Math.sin(i2 * 2.7 + (msg.id || 0)));   // stable pseudo-wave
            var bh2 = Math.max(2, seedv * (h - 4));
            ctx.fillStyle = (i2 / 36) <= pct ? '#ffffff' : 'rgba(255,255,255,.35)';
            ctx.fillRect(i2 * bar, (h - bh2) / 2, bar - 1, bh2);
          }
          drawn = true;
        }
        audio.addEventListener('loadedmetadata', function () {
          dur.textContent = fmtDur(audio.duration * 1000);
          if (!drawn) paintWave(0);
        });
        audio.addEventListener('timeupdate', function () {
          if (audio.duration) paintWave(audio.currentTime / audio.duration);
        });
        audio.addEventListener('ended', function () { pbtn.textContent = '\u25B6'; paintWave(0); });
        pbtn.addEventListener('click', function () {
          if (audio.paused) {
            document.querySelectorAll('audio').forEach(function (x) { try { x.pause(); } catch (e9) {} });   // one at a time
            document.querySelectorAll('.vm-play').forEach(function (b2) { b2.textContent = '\u25B6'; });
            audio.play(); pbtn.textContent = '\u23F8'; pbtn.setAttribute('aria-label', 'Pause voice message');
          } else { audio.pause(); pbtn.textContent = '\u25B6'; pbtn.setAttribute('aria-label', 'Play voice message'); }
        });
        wave.addEventListener('click', function (e3) {
          if (!audio.duration) return;
          var r2 = wave.getBoundingClientRect();
          audio.currentTime = ((e3.clientX - r2.left) / r2.width) * audio.duration;
        });
      } else {
        var a = el('a', 'att-file');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        var ic = el('span', 'att-file-ic', (msg.attachment.name || 'f').split('.').pop().slice(0, 4).toUpperCase());
        a.appendChild(ic);
        var mid = el('div', 'att-file-main');
        mid.appendChild(el('div', 'att-file-name', msg.attachment.name || 'file'));
        mid.appendChild(el('div', 'att-file-size', fmtSize(msg.attachment.size)));
        a.appendChild(mid);
        bubble.appendChild(a);
      }
    }
    if (msg.deleted) {
      bubble.appendChild(el('div', 'msg-body', 'This message was deleted'));
    } else if (msg.body) {
      var bodyNode = el('div', 'msg-body');
      if (URL_RE.test(msg.body)) bodyNode.innerHTML = linkify(msg.body);   // escaped inside linkify
      else bodyNode.textContent = msg.body;
      URL_RE.lastIndex = 0;
      bubble.appendChild(bodyNode);
    } else if (!msg.attachment) {
      bubble.appendChild(el('div', 'msg-body', ''));
    }
    if (meta) bubble.appendChild(meta);
  }

  /* ------------------------------ chat header ------------------------------ */

  function paintChatSub() {
    var sub = $('#chat-sub');
    if (!sub) return;
    var chatId = S.openChatId;
    if (!chatId) { sub.textContent = ''; sub.classList.remove('typing'); return; }
    var chat = chatById(chatId);
    if (!chat) { sub.textContent = ''; return; }
    var typed = S.typing.get(chatId);
    if (typed && typed.size) {
      var names = [];
      var what = 'text';
      typed.forEach(function (uid) {
        var m = memberById(chat, uid);
        names.push(m ? (m.displayName || m.username) : 'Someone');
        var w = S.typingWhat.get(chatId + ':' + uid);
        if (w && w !== 'text') what = w;          // an activity beats plain "typing"
      });
      var verb = what === 'file' ? 'sending a file…'
        : what === 'photo' ? 'sending a photo…'
          : what === 'video' ? 'sending a video…'
            : what === 'voice' ? 'recording a voice message…'
              : 'typing';
      sub.textContent = (chat.kind === 'group' ? names.join(', ') + ' ' + verb : verb);
      // The old dots were a CSS `content` animation, which several browsers (the
      // Android WebView first among them) never animated — three frozen dots.
      // Real spans animate everywhere.
      if (what === 'text') {
        for (var i = 0; i < 3; i++) sub.appendChild(el('span', 't-dot', '·'));
      }
      sub.classList.add('typing');
      return;
    }
    sub.classList.remove('typing');
    if (chat.kind === 'group') {
      var online = chat.members.filter(function (m) { return m.online; }).length;
      sub.textContent = chat.members.length + ' members' + (online ? ' · ' + online + ' online' : '');
    } else {
      var p = chatPeerUser(chat);
      if (!p) { sub.textContent = ''; return; }
      sub.textContent = p.online ? 'online' : lastSeenText(p);
    }
  }

  /** 'last seen today at 14:05' style text from a member's lastSeen ts. */
  function lastSeenText(m) {
    var ts = m.lastSeen || 0;
    if (!ts) return '@' + (m.username || '');
    var d = new Date(ts), n = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === n.toDateString()) return 'last seen ' + hm;
    var y = new Date(n.getTime() - 864e5);
    if (d.toDateString() === y.toDateString()) return 'yesterday ' + hm;
    return 'last seen ' + ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  /* Keep presence text fresh: re-paint the subtitle + list once a minute. */
  setInterval(function () {
    try {
      if (S.openChatId) paintChatSub();
      if (!document.hidden && !S.openChatId) renderChatList();
    } catch (e) {}
  }, 60000);

  /* ------------------------------ composer -------------------------------- */

  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }

  /* ---- attachment options sheet: gallery / camera / document ---- */
  function openAttachSheet(ev) {
    if (ev) ev.preventDefault();
    var old = document.getElementById('jc-attach');
    if (old) { old.remove(); return; }
    var sheet = el('div', 'jc-menu');
    sheet.id = 'jc-attach';
    var inner = el('div', 'jc-menu-inner jc-attach-inner');
    inner.appendChild(el('div', 'jc-attach-title', 'Attach'));
    var grid = el('div', 'jc-attach-grid');
    function opt(icon, label, accept, capture) {
      var b = el('button', 'jc-attach-opt');
      b.type = 'button';
      b.appendChild(el('div', 'jc-attach-ic', icon));
      b.appendChild(el('div', 'jc-attach-label', label));
      b.addEventListener('click', function () {
        sheet.remove();
        var fi = document.getElementById('file-input');
        fi.value = '';
        if (accept !== null) fi.setAttribute('accept', accept); else fi.removeAttribute('accept');
        if (capture) fi.setAttribute('capture', capture); else fi.removeAttribute('capture');
        fi.click();
      });
      grid.appendChild(b);
    }
    opt('\ud83d\uddbc\ufe0f', 'Gallery', 'image/*', null);
    opt('\ud83d\udcf7', 'Camera', 'image/*', 'environment');
    opt('\ud83d\udcc4', 'Document', null, null);
    inner.appendChild(grid);
    sheet.appendChild(inner);
    document.body.appendChild(sheet);
    sheet.addEventListener('click', function (e2) { if (e2.target === sheet) sheet.remove(); });
  }

  function sendMessage() {
    // inline edit mode: the composer send acts as "save edit"
    try { if (window.JCEdit && window.JCEdit.submit && window.JCEdit.submit()) return; } catch (eEd) {}
    var input = $('#composer-input');
    var body = input.value.replace(/\s+$/, '');
    var att = S.pendingAttachment;
    if (!body && !att) return;
    if (!S.openChatId || !S.me) return;
    if (att && !att.ready) { toast('Still uploading the file…'); return; }

    var chatId = S.openChatId;
    input.value = '';
    autoGrow(input);
    clearAttachment();
    stopTyping(chatId);

    var clientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var optimistic = {
      id: null, chatId: chatId, senderId: S.me.id, body: body,
      kind: att ? (isImageMime(att.mime) ? 'image' : 'file') : 'text',
      attachment: att || null,
      createdAt: Date.now(), clientId: clientId, state: 'pending'
    };
    var st = cstate(chatId);
    st.msgs.push(optimistic);
    if (String(chatId) === String(S.openChatId)) appendMessageNode(optimistic, true);
    bumpChatLocal(chatId, optimistic);

    var chat = chatById(chatId);
    var replyTo = (window.JarvisReply && window.JarvisReply.id) ? window.JarvisReply.id : null;
    if (!att && window.Net.isOpen()) {
      window.Net.send({ t: 'msg.send', chatId: Number(chatId) || chatId, body: body, kind: 'text', clientId: clientId, replyTo: replyTo });
      if (window.JarvisClearReply) window.JarvisClearReply();
      return;
    }
    // attachments (and sends while the socket is down) go over REST; the server broadcasts msg.new
    var payload = { body: body, kind: optimistic.kind, clientId: clientId, replyTo: replyTo };
    if (att) payload.attachment = { path: att.path, name: att.name, mime: att.mime, size: att.size };
    if (window.JarvisClearReply) window.JarvisClearReply();
    api('api/chats/' + encodeURIComponent(chatId) + '/messages', { method: 'POST', body: payload })
      .then(function (r) {
        var m = normMsg(r && r.message);
        if (m) {
          if (m.chatId == null) m.chatId = chatId;
          cstate(m.chatId).ids.add(m.id);
          reconcile(clientId, m);
        }
      })
      .catch(function (e) {
        var pe = S.pendingEls.get(clientId);
        if (pe) { S.pendingEls.delete(clientId); clearPendingState(pe); }
        toast(errMsg(e), 'error');
        if (chat) { /* keep the bubble marked failed */ }
      });
  }

  function startTyping(chatId, what) {
    var w = what || 'text';
    var now = Date.now();
    // re-send at most every 2s so the other side's 5s expiry never blinks
    if (!S.myTypingOn[chatId] || S.myTypingWhat[chatId] !== w || !S.myTypingSentAt[chatId] || (now - S.myTypingSentAt[chatId]) > 2000) {
      S.myTypingOn[chatId] = true;
      S.myTypingWhat[chatId] = w;
      S.myTypingSentAt[chatId] = now;
      window.Net.send({ t: 'typing', chatId: Number(chatId) || chatId, on: true, what: w });
    }
    if (S.myTypingTimer[chatId]) clearTimeout(S.myTypingTimer[chatId]);
    S.myTypingTimer[chatId] = setTimeout(function () { stopTyping(chatId); }, w !== 'text' ? 12000 : 2500);
  }
  function stopTyping(chatId) {
    if (S.myTypingTimer[chatId]) { clearTimeout(S.myTypingTimer[chatId]); S.myTypingTimer[chatId] = null; }
    if (S.myTypingOn[chatId]) {
      S.myTypingOn[chatId] = false;
      window.Net.send({ t: 'typing', chatId: Number(chatId) || chatId, on: false });
    }
  }

  /* ----------------------------- attachments ------------------------------- */

  function clearAttachment() {
    if (S.pendingAttachment && S.pendingAttachment.objUrl) {
      try { URL.revokeObjectURL(S.pendingAttachment.objUrl); } catch (e) {}
    }
    S.pendingAttachment = null;
    var prev = $('#attach-preview');
    if (prev) prev.hidden = true;
    var thumb = $('#attach-thumb');
    if (thumb) thumb.hidden = true;
    var img = $('#attach-thumb-img');
    if (img) img.removeAttribute('src');
    var ic = $('#attach-file-ic');
    if (ic) ic.hidden = true;
    var fi = $('#file-input');
    if (fi) fi.value = '';
  }

  /** Pre-send preview, WhatsApp-style: photos show the actual picture, files show
   *  an icon with name + size — nothing is invisible until "send" any more. */
  function paintAttachPreview(att, uploading) {
    var prev = $('#attach-preview');
    if (!prev) return;
    var nameEl = prev.querySelector('.attach-preview-name');
    var sizeEl = prev.querySelector('.attach-preview-size');
    var thumb = $('#attach-thumb');
    var img = $('#attach-thumb-img');
    var ic = $('#attach-file-ic');
    var isImage = !!(att && att.mime && isImageMime(att.mime));
    if (nameEl) nameEl.textContent = (uploading ? 'Uploading ' : '') + (att.name || 'file') + (uploading ? '…' : '');
    if (sizeEl) sizeEl.textContent = uploading ? '' : fmtSize(att.size);
    if (thumb && img && ic) {
      if (isImage && att.objUrl) {
        img.src = att.objUrl;
        thumb.hidden = false;
        ic.hidden = true;
      } else {
        thumb.hidden = true;
        img.removeAttribute('src');
        ic.hidden = false;
      }
    }
    prev.hidden = false;
  }

  function pickFile(file) {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) { toast('That file is too large (max 200 MB).', 'error'); return; }
    var att = {
      ready: false,
      name: file.name,
      mime: file.type,
      size: file.size,
      objUrl: null,
    };
    try { if (isImageMime(att.mime)) att.objUrl = URL.createObjectURL(file); } catch (e) {}
    S.pendingAttachment = att;
    paintAttachPreview(att, true);

    var fd = new FormData();
    fd.append('file', file);
    api('api/upload', { method: 'POST', body: fd })
      .then(function (r) {
        if (!r || !r.path) throw new Error('Upload failed.');
        // the user may have removed it while the upload was in flight
        if (S.pendingAttachment !== att) { try { if (att.objUrl) URL.revokeObjectURL(att.objUrl); } catch (e) {} return; }
        S.pendingAttachment = {
          ready: true,
          path: r.path,
          name: r.name || file.name,
          mime: r.mime || file.type,
          size: r.size || file.size,
          objUrl: att.objUrl,
        };
        paintAttachPreview(S.pendingAttachment, false);
      })
      .catch(function (e) {
        if (S.pendingAttachment === att) clearAttachment();
        else { try { if (att.objUrl) URL.revokeObjectURL(att.objUrl); } catch (e2) {} }
        toast(errMsg(e), 'error');
      });
  }

  /* --------------------------------- modal -------------------------------- */

  function openModal(title, build) {
    var body = $('#modal-body');
    $('#modal-title').textContent = title;
    body.textContent = '';
    var modal = $('#modal');
    modal.hidden = false;
    if (build) build(body);
    return body;
  }
  function closeModal() {
    var modal = $('#modal');
    if (modal) modal.hidden = true;
    var body = $('#modal-body');
    if (body) body.textContent = '';
  }

  function userPickerRow(user, input) {
    var row = el('label', 'picker-row');
    row.dataset.userId = user.id;
    input.type = 'checkbox';
    input.value = String(user.id);
    row.appendChild(input);
    var wrap = el('div', 'avatar-wrap');
    var av = el('span', 'avatar av-48');
    paintAvatar(av, user);
    wrap.appendChild(av);
    if (user.online) wrap.appendChild(el('span', 'avatar-dot'));
    row.appendChild(wrap);
    var nm = el('div', 'picker-name');
    nm.appendChild(el('b', null, user.displayName || user.username));
    nm.appendChild(el('small', null, '@' + user.username));
    row.appendChild(nm);
    return row;
  }

  /** Simple people list: a click on a row calls onPick(user). Used by search + new chat. */
  function peopleList(q, into, onPick) {
    if (!into) return;
    into.textContent = '';
    if (!q || q.length < 2) {          // privacy: never list everyone
      into.appendChild(el('div', 'empty', 'Type a username or a name (2+ characters) — the full user list is never shown.'));
      return;
    }
    into.appendChild(el('div', 'empty', 'Searching…'));
    api('api/users?q=' + encodeURIComponent(q)).then(function (r) {
      var users = ((r && r.users) || []).map(normUser).filter(function (u) {
        return !S.me || String(u.id) !== String(S.me.id);
      });
      into.textContent = '';
      if (!users.length) { into.appendChild(el('div', 'empty', 'No one found with that username or name.')); return; }
      users.forEach(function (u) {
        var row = el('div', 'picker-row');
        var wrap = el('div', 'avatar-wrap');
        var av = el('span', 'avatar av-48');
        paintAvatar(av, u);
        wrap.appendChild(av);
        if (u.online) wrap.appendChild(el('span', 'avatar-dot'));
        row.appendChild(wrap);
        var nm = el('div', 'picker-name');
        nm.appendChild(el('b', null, u.displayName || u.username));
        nm.appendChild(el('small', null, '@' + u.username));
        row.appendChild(nm);
        row.addEventListener('click', function () { onPick(u); });
        into.appendChild(row);
      });
    }).catch(function (e) {
      into.textContent = '';
      into.appendChild(el('div', 'empty', errMsg(e)));
    });
  }

  function openNewChat() {
    openModal('New chat', function (body) {
      var search = el('input', 'modal-input');
      search.type = 'search';
      search.placeholder = 'Search people';
      search.autocomplete = 'off';
      body.appendChild(search);
      var list = el('div', 'modal-list');
      body.appendChild(list);
      var timer = null;
      function run() { peopleList(search.value.trim(), list, startDirect); }
      search.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, 220);
      });
      run();
      setTimeout(function () { search.focus(); }, 50);
    });
  }

  function startDirect(user) {
    closeModal();
    api('api/chats', { method: 'POST', body: { memberIds: [user.id] } }).then(function (r) {
      var chat = normChat((r && (r.chat || r)) || null);
      if (chat && chat.id != null) {
        if (!chatById(chat.id)) S.chats.push(chat);
        sortChats();
        renderChatList();
        openChat(chat.id);
      } else {
        loadChats();
      }
    }).catch(function (e) { toast(errMsg(e), 'error'); });
  }

  function openNewGroup() {
    var picked = new Map();
    openModal('New group', function (body) {
      var nameInput = el('input', 'modal-input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Group name';
      body.appendChild(nameInput);
      var chips = el('div', 'chip-row');
      body.appendChild(chips);
      var search = el('input', 'modal-input');
      search.type = 'search';
      search.placeholder = 'Add members';
      search.autocomplete = 'off';
      body.appendChild(search);
      var list = el('div', 'modal-list');
      body.appendChild(list);

      function paintChips() {
        chips.textContent = '';
        picked.forEach(function (u) {
          chips.appendChild(el('span', 'chip', u.displayName || u.username));
        });
      }
      function render(q) {
        list.textContent = '';
        if (!q || q.length < 2) {        // privacy: no default listing
          list.appendChild(el('div', 'empty', 'Type a username or a name (2+ characters) to add members.'));
          return;
        }
        list.appendChild(el('div', 'empty', 'Searching…'));
        api('api/users?q=' + encodeURIComponent(q)).then(function (r) {
          var users = ((r && r.users) || []).map(normUser).filter(function (u) {
            return !S.me || String(u.id) !== String(S.me.id);
          });
          list.textContent = '';
          if (!users.length) { list.appendChild(el('div', 'empty', 'No one found with that username or name.')); return; }
          users.forEach(function (u) {
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = picked.has(String(u.id));
            var row = userPickerRow(u, cb);
            row.addEventListener('click', function (ev) {
              if (ev.target !== cb) { cb.checked = !cb.checked; ev.preventDefault(); }
              if (cb.checked) picked.set(String(u.id), u); else picked.delete(String(u.id));
              paintChips();
              cb.checked = picked.has(String(u.id));
            });
            list.appendChild(row);
          });
        }).catch(function (e) {
          list.textContent = '';
          list.appendChild(el('div', 'empty', errMsg(e)));
        });
      }
      var timer = null;
      search.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { render(search.value.trim()); }, 220);
      });
      render('');

      var actions = el('div', 'modal-actions');
      var create = el('button', 'btn primary', 'Create group');
      create.type = 'button';
      var hint = el('div', 'modal-hint', 'Pick 2+ people for a group. One person and no group name creates a direct chat.');
      actions.appendChild(hint);
      function refreshHint() {
        hint.textContent = (picked.size === 1 && !nameInput.value.trim())
          ? 'One person and no group name → this will be a direct chat, not a group.'
          : 'Pick 2+ people for a group. One person and no group name creates a direct chat.';
      }
      nameInput.addEventListener('input', refreshHint);
      create.addEventListener('click', function () {
        var ids = Array.from(picked.keys()).map(function (k) { return Number(k); });
        if (!ids.length) { toast('Pick at least one member.'); return; }
        if (ids.length === 1 && !nameInput.value.trim()) { toast('Add a group name, or use New chat for a direct conversation.'); return; }
        create.disabled = true;
        var title = nameInput.value.trim();
        api('api/chats', { method: 'POST', body: { memberIds: ids, title: title } }).then(function (r) {
          closeModal();
          var chat = normChat((r && (r.chat || r)) || null);
          if (chat && chat.id != null) {
            if (!chatById(chat.id)) S.chats.push(chat);
            sortChats();
            renderChatList();
            openChat(chat.id);
          } else {
            loadChats();
          }
        }).catch(function (e) {
          create.disabled = false;
          toast(errMsg(e), 'error');
        });
      });
      actions.appendChild(create);
      body.appendChild(actions);
    });
  }

  function openProfile() {
    var u = S.me || {};
    openModal('Profile', function (body) {
      var head = el('div', 'check-row');
      var av = el('span', 'avatar av-54');
      paintAvatar(av, u);
      head.appendChild(av);
      var info = el('label');
      info.appendChild(el('b', null, u.displayName || u.username || ''));
      info.appendChild(el('small', null, ' @' + txt(u.username)));
      head.appendChild(info);
      body.appendChild(head);

      body.appendChild(el('div', 'field-label', 'Display name'));
      var nameInput = el('input', 'modal-input');
      nameInput.type = 'text';
      nameInput.value = u.displayName || '';
      body.appendChild(nameInput);

      body.appendChild(el('div', 'field-label', 'Bio'));
      var bioInput = el('input', 'modal-input');
      bioInput.type = 'text';
      bioInput.value = u.bio || '';
      bioInput.placeholder = 'A short line about you';
      body.appendChild(bioInput);

      var actions = el('div', 'modal-actions');
      var save = el('button', 'btn primary', 'Save');
      save.type = 'button';
      save.addEventListener('click', function () {
        save.disabled = true;
        api('api/me', { method: 'POST', body: { displayName: nameInput.value.trim(), bio: bioInput.value.trim() } })
          .then(function (r) {
            if (r && r.user) {
              S.me = normUser(r.user);
              if (window.UI) window.UI.me = S.me;
              paintMe();
              renderChatList();
            }
            closeModal();
            toast('Profile saved');
          })
          .catch(function (e) { save.disabled = false; toast(errMsg(e), 'error'); });
      });
      actions.appendChild(save);
      body.appendChild(actions);

      // In the app: the two phone switches that stop Android/MIUI from freezing
      // background delivery. Without them notifications stop when the app is idle.
      if (window.XCApp) {
        var diag = el('button', 'btn', 'Diagnostics & tests');
        diag.addEventListener('click', function () { try { window.XCDiag(); } catch (e) { toast('Could not open diagnostics'); } });
        var keep = el('button', 'btn', 'Keep notifications on');
        keep.type = 'button';
        keep.style.marginTop = '12px';
        keep.style.width = '100%';
        keep.addEventListener('click', function () {
          keep.disabled = true;
          toast('Turn on “Allow background activity / Autostart” for XCaller');
          try { if (window.XCApp.openAutostartSettings) window.XCApp.openAutostartSettings(); } catch (e) {}
          setTimeout(function () {
            try { if (window.XCApp.openBatterySettings) window.XCApp.openBatterySettings(); } catch (e) {}
          }, 1200);
          setTimeout(function () { keep.disabled = false; }, 4000);
        });
        body.appendChild(keep);
      }

      var out = el('button', 'btn danger', 'Log out');
      out.type = 'button';
      out.style.marginTop = '12px';
      out.style.width = '100%';
      out.addEventListener('click', function () { closeModal(); logout(); });
      body.appendChild(out);
    });
  }

  /* ---------------------------- calls: UI hooks ---------------------------- */

  function callIdOf(c) { return c && (c.callId || c.call_id || c.id); }

  function showIncoming(call) {
    if (!call) return;
    S.pendingCall = call;
    var from = normUser(call.from) || {};
    var name = from.displayName || from.username || 'Someone';
    $('#incoming-name').textContent = name;
    var kind = call.kind === 'video' ? 'Incoming video call' : 'Incoming voice call';
    if (call.chatId && chatById(call.chatId) && chatById(call.chatId).kind === 'group') {
      kind = 'Incoming call · ' + chatTitle(chatById(call.chatId));
    }
    $('#incoming-kind').textContent = kind;
    var av = $('#incoming-avatar');
    paintAvatar(av, from, name);
    av.dataset.initial = initial(name);
    $('#incoming').hidden = false;
  }

  function hideIncoming() {
    var n = $('#incoming');
    if (n) n.hidden = true;
    S.pendingCall = null;
  }

  function tileId(userId) { return 'tile-' + String(userId); }
  function tileFor(userId) { return document.getElementById(tileId(userId)); }
  function videoFor(userId) {
    var t = tileFor(userId);
    return t ? t.querySelector('video') : null;
  }

  function buildTile(userId, user) {
    var tile = el('div', 'call-tile');
    tile.id = tileId(userId);
    tile.dataset.userId = String(userId);

    var video = document.createElement('video');
    video.className = 'tile-video';
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    if (S.me && String(userId) === String(S.me.id)) video.muted = true;
    tile.appendChild(video);

    var av = el('span', 'avatar tile-avatar', initial(user && (user.displayName || user.username)));
    paintAvatar(av, user || { avatarColor: '' });
    tile.appendChild(av);

    var label = el('div', 'tile-label', (user && (user.displayName || user.username)) || 'Guest');
    tile.appendChild(label);
    tile.appendChild(el('div', 'tile-flags', ''));
    return tile;
  }

  /**
   * Additive on purpose: existing <video> elements are never rebuilt, because the
   * calls engine attaches MediaStreams to them.
   */
  function setParticipants(list) {
    var box = $('#call-tiles');
    if (!box) return;
    list = list || [];
    var ids = list.map(function (u) { return String(u && (u.userId != null ? u.userId : (u.id != null ? u.id : u))); });
    ids.forEach(function (id, i) {
      var user = (typeof list[i] === 'object' && list[i]) ? normUser(list[i].user || list[i]) : null;
      if (user && user.id == null) user = { id: id, displayName: list[i].displayName, username: list[i].username, avatarColor: list[i].avatarColor, online: true };
      var tile = tileFor(id);
      if (!tile) {
        tile = buildTile(id, user);
        box.appendChild(tile);
      } else if (user) {
        var lb = tile.querySelector('.tile-label');
        if (lb) lb.textContent = user.displayName || user.username || 'Guest';
        var av = tile.querySelector('.tile-avatar');
        if (av) paintAvatar(av, user);
      }
    });
    // drop tiles for people who left
    $$('.call-tile', box).forEach(function (t) {
      if (ids.indexOf(String(t.dataset.userId)) < 0 && t.parentNode) t.parentNode.removeChild(t);
    });
    // keep the call header honest once we know who the peer is
    if (S.currentCall) paintCallHeader(S.currentCall);
    // WhatsApp-style 1-to-1: the peer fills the whole stage and your video sits
    // in a corner picture-in-picture. (The old inline 'repeat(2,1fr)' overrode
    // the .duo CSS rule, which is exactly why tiles showed half/half stacked.)
    var n = $$('.call-tile', box).length;
    box.classList.toggle('single', n <= 1);
    if (n <= 2) { box.classList.add('duo'); box.style.gridTemplateColumns = '1fr'; }
    else { box.classList.remove('duo'); box.style.gridTemplateColumns = 'repeat(2, 1fr)'; }
    if (S.me) {
      var myTile = tileFor(S.me.id);
      // voice-only 1:1: no self PiP — one calm avatar on stage, nothing competing
      var voiceOnly = S.currentCall && S.currentCall.kind !== 'video' && n <= 2;
      if (myTile) {
        myTile.classList.add('self');
        myTile.classList.toggle('self-hidden', !!voiceOnly);
      }
    }
    // remember who is on the call so the "add person" picker never offers an existing member
    if (S.currentCall) S.currentCall.participants = list.slice();
  }

  function setCallState(state) {
    state = state || {};
    var mute = $('#call-mute');
    var cam = $('#call-cam');
    if (mute) mute.classList.toggle('off', !!state.muted);
    if (cam) cam.classList.toggle('off', !state.camera);   // 'off' state = camera is OFF
    // reflect local state on my own tile
    if (S.me) {
      var mine = tileFor(S.me.id);
      if (mine) {
        var f = mine.querySelector('.tile-flags');
        if (f) f.textContent = state.muted ? '🔇' : '';
        mine.classList.toggle('audio-only', !!(S.currentCall && S.currentCall.kind !== 'video' && state.camera === false));
      }
    }
  }

  function stopCallTimer() {
    if (S.callTimerId) { clearInterval(S.callTimerId); S.callTimerId = null; }
  }
  function paintCallTimer() {
    var t = $('#call-timer');
    if (!t) return;
    var secs = Math.max(0, Math.floor((Date.now() - S.callStartedAt) / 1000));
    var m = Math.floor(secs / 60), s = secs % 60;
    var h = Math.floor(m / 60);
    t.textContent = (h ? pad2(h) + ':' : '') + pad2(h ? m % 60 : m) + ':' + pad2(s);
  }

  function openCallScreen(call) {
    try { if (window.Calls && window.Calls.showSpeakerButton) setTimeout(window.Calls.showSpeakerButton, 0); } catch (e) {}
    call = call || {};
    var screen = $('#call-screen');
    if (!screen) return;
    // The same call can reach openCallScreen twice (local start + the server's
    // call.started echo). Rebuilding the tiles re-attaches MediaStreams to fresh
    // <video> elements — a visible flash at the start of every call. Only wipe
    // when it is really a different (or new) call.
    var sameCall = !screen.hidden && S.currentCall && callIdOf(S.currentCall) != null &&
      String(callIdOf(S.currentCall)) === String(callIdOf(call));
    S.currentCall = call;
    if (!sameCall) $('#call-tiles').textContent = '';
    S.callStartedAt = (sameCall && S.callStartedAt) ? S.callStartedAt : (ms(call.startedAt) || Date.now());
    stopCallTimer();
    // No clock until somebody actually picks up: show "Calling…" instead.
    paintCallStatus('calling');
    paintCallHeader(call);
    screen.hidden = false;
    hideIncoming();
    setParticipants(call.participants || []);
    setCallState({ muted: false, camera: call.kind === 'video' });
  }

  /** Header shows WHO you are talking to, not the word "Call".
   *  Peer = the other participant; falls back to the chat title. */
  function paintCallHeader(call) {
    var t = $('#call-title');
    if (!t) return;
    var peer = null;
    (call.participants || []).forEach(function (p) {
      var id = p && (p.userId != null ? p.userId : (p.id != null ? p.id : p));
      if (id != null && S.me && String(id) !== String(S.me.id)) {
        var pu = p.user || p;
        peer = { userId: id, displayName: pu.displayName || pu.name || '', username: pu.username || '', avatarColor: pu.avatarColor || '' };
      }
    });
    if (peer && !peer.displayName && !peer.username) peer = null;   // fall through to chat lookup
    if (!peer || !(peer.displayName || peer.username)) {
      var chat = S.chats ? S.chats.find(function (c2) { return String(c2.id) === String(call.chatId); }) : null;
      if (chat) {
        // direct chats carry the peer in .members; title is often blank for them
        var mem = (chat.members || []).filter(function (m3) { return S.me && String(m3.id) !== String(S.me.id); });
        var m2 = mem[0];
        peer = m2 ? { displayName: m2.displayName || m2.username || (chat.kind === 'group' ? chat.title : ''), username: m2.username || '', avatarColor: m2.avatarColor || '' }
                  : { displayName: chat.title || 'Call', username: '' };
      }
    }
    var name = peer.displayName || peer.username || 'Call';
    t.textContent = name;
    t.title = peer.username ? '@' + peer.username : '';
    // voice vs video kind badge lives in the status line until connected
  }

  /** The line under the name: Calling… / Ringing… / connected (clock). */
  function paintCallStatus(kind) {
    var t = $('#call-timer');
    var s = $('#call-status');
    if (!s) {
      var head = document.querySelector('#call-screen .call-head') || document.querySelector('#call-screen');
      if (head) { s = el('div', 'call-status'); s.id = 'call-status'; head.appendChild(s); }
    }
    if (kind === 'connected') {
      if (s) { s.hidden = true; s.textContent = ''; }
      if (t) t.style.display = '';
      return;
    }
    if (t) { t.style.display = 'none'; t.textContent = '00:00'; }
    if (s) {
      s.hidden = false;
      s.textContent = kind === 'ringing' ? 'Ringing…'
        : kind === 'reconnecting' ? 'Reconnecting…'
        : kind === 'connected-once' ? 'Connected'
        : 'Calling…';
      s.dataset.state = kind;
    }
  }

  function closeCallScreen() {
    var screen = $('#call-screen');
    if (screen) screen.hidden = true;
    stopCallTimer();
    var box = $('#call-tiles');
    if (box) box.textContent = '';
    S.currentCall = null;
    setCallState({ muted: false, camera: false });
  }

  function callEngine() {
    return (window.Calls && typeof window.Calls === 'object') ? window.Calls : null;
  }
  function engineCall(method, args, label) {
    var c = callEngine();
    if (!c || typeof c[method] !== 'function') {
      toast((label || 'Calling') + ' is unavailable in this build.', 'error');
      return null;
    }
    try { return c[method].apply(c, args || []); }
    catch (e) { toast('Call failed: ' + (e && e.message ? e.message : 'unknown error'), 'error'); return null; }
  }

  function onCallIncoming(frame) {
    showIncoming(frame);
  }
  function onCallJoined(frame) {
    if (!S.currentCall || String(callIdOf(S.currentCall)) !== String(frame.callId)) return;
    if (frame.user && !S.currentCall.participants) S.currentCall.participants = [];
    if (frame.participants && frame.participants.length) setParticipants(frame.participants);
  }
  function onCallLeft(frame) {
    if (!S.currentCall || String(callIdOf(S.currentCall)) !== String(frame.callId)) return;
    if (frame.participants) setParticipants(frame.participants);
    else {
      var t = tileFor(frame.userId);
      if (t && t.parentNode) t.parentNode.removeChild(t);
    }
    // 1:1: the peer declining/leaving ends the call for me too — never hang alone
    var box2 = $('#call-tiles');
    var others = box2 ? $$('.call-tile', box2).filter(function (x) {
      return String(x.dataset.userId) !== String(S.me && S.me.id);
    }).length : 0;
    if (others === 0) {
      engineCall('leave', [], 'Leaving');
      closeCallScreen();
      toast(frame.reason === 'declined' ? 'Call declined' : 'Call ended');
    }
  }
  function onCallEnded(frame) {
    if (S.currentCall && String(callIdOf(S.currentCall)) !== String(frame.callId)) return;
    closeCallScreen();
    hideIncoming();
    toast(frame.reason === 'declined' ? 'Call declined' : 'Call ended');
  }
  function onCallState(frame) {
    if (S.me && String(frame.userId) === String(S.me.id)) {
      setCallState({ muted: !!frame.muted, camera: !!frame.camera });
      return;
    }
    var t = tileFor(frame.userId);
    if (t) {
      var f = t.querySelector('.tile-flags');
      if (f) f.textContent = frame.muted ? '🔇' : '';
      t.classList.toggle('sharing', !!frame.sharing);   // peer is sharing a screen
      var vid = t.querySelector('video');
      if (vid) vid.classList.toggle('src-screen', !!frame.sharing);   // contain, not cover
    }
  }

  function openAddPeople() {
    var current = {};
    if (S.currentCall && S.currentCall.participants) {
      S.currentCall.participants.forEach(function (p) {
        var id = p && (p.userId != null ? p.userId : (p.id != null ? p.id : p));
        if (id != null) current[String(id)] = true;
      });
    }
    if (S.me) current[String(S.me.id)] = true;

    var picked = new Map();
    openModal('Add people to this call', function (body) {
      var search = el('input', 'modal-input');
      search.type = 'search';
      search.placeholder = 'Search by username or name';
      search.autocomplete = 'off';
      body.appendChild(search);
      var list = el('div', 'modal-list');
      list.appendChild(el('div', 'empty', 'Type a username or a name to search. The full user list is never shown.'));
      body.appendChild(list);

      function render(q) {
        list.textContent = '';
        if (!q) {                                  // privacy: no listing everyone
          list.appendChild(el('div', 'empty', 'Type a username or a name to search. The full user list is never shown.'));
          return;
        }
        list.appendChild(el('div', 'empty', 'Searching…'));
        api('api/users?q=' + encodeURIComponent(q)).then(function (r) {
          var users = ((r && r.users) || []).map(normUser).filter(function (u) { return !current[String(u.id)]; });
          list.textContent = '';
          if ((r && r.needQuery) || q.length < 2) { list.appendChild(el('div', 'empty', 'Keep typing — at least 2 characters.')); return; }
          if (!users.length) { list.appendChild(el('div', 'empty', 'Nobody found with that username or name.')); return; }
          users.forEach(function (u) {
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = picked.has(String(u.id));
            var row = userPickerRow(u, cb);
            row.addEventListener('click', function (ev) {
              if (ev.target !== cb) { cb.checked = !cb.checked; ev.preventDefault(); }
              if (cb.checked) picked.set(String(u.id), u); else picked.delete(String(u.id));
            });
            list.appendChild(row);
          });
        }).catch(function (e) {
          list.textContent = '';
          list.appendChild(el('div', 'empty', errMsg(e)));
        });
      }
      var timer = null;
      search.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { render(search.value.trim()); }, 220);
      });
      render('');

      var actions = el('div', 'modal-actions');
      var add = el('button', 'btn primary', 'Add to call');
      add.type = 'button';
      add.addEventListener('click', function () {
        var ids = Array.from(picked.keys()).map(function (k) { return Number(k); });
        if (!ids.length) { toast('Pick at least one person.'); return; }
        closeModal();
        engineCall('addPeople', [ids], 'Adding people');
      });
      actions.appendChild(add);
      body.appendChild(actions);
    });
  }

  /* -------------------------------- wiring -------------------------------- */

  function hardLogout() {
    teardown();
    clearToken();
    showAuth('login');
    setErr('#login-error', 'Your session expired — please log in again.');
  }

  function wire() {
    // auth
    $('#login-form').addEventListener('submit', doLogin);
    $('#register-form').addEventListener('submit', doRegister);
    $('#show-register').addEventListener('click', function () {
      showAuth('register');
      setTimeout(function () { $('#reg-username').focus(); }, 0);
    });
    $('#show-login').addEventListener('click', function () { showAuth('login'); });

    // live "is this username free?" while the new user types it
    var unameTimer = null;
    var uname = $('#reg-username');
    if (uname) {
      uname.addEventListener('input', function () {
        var v = uname.value.trim().toLowerCase();
        noteUsername('');
        if (unameTimer) clearTimeout(unameTimer);
        if (!USERNAME_RE.test(v)) {
          if (v) noteUsername('3–20 characters: a–z, 0–9 or underscore', false);
          return;
        }
        unameTimer = setTimeout(function () {
          api('api/username-check', { method: 'POST', body: { username: v } })
            .then(function (r) {
              if (uname.value.trim().toLowerCase() !== v) return;   // typing moved on
              if (r && r.available) noteUsername('“' + v + '” is free', true);
              else noteUsername((r && r.message) || 'That username is taken — choose another one.', false);
            })
            .catch(function () { /* the submit check still protects us */ });
        }, 400);
      });
    }

    // header / sidebar
    $('#profile-btn').addEventListener('click', openProfile);
    $('#new-chat').addEventListener('click', openNewChat);
    $('#new-group').addEventListener('click', openNewGroup);
    $('#back-btn').addEventListener('click', function () {
      document.body.classList.remove('chat-open');
      S.openChatId = null;
      renderChatList();
      paintChatSub();
      $('#chat-title').textContent = 'Select a chat';
    });
    $('#chat-search').addEventListener('input', function (ev) {
      var v = ev.target.value;
      if (S.searchTimer) clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(function () { runSearch(v.trim()); }, 220);
      S.searchTerm = v;          // filter the list immediately, query people after the pause
      renderChatList();
    });

    // composer
    var form = $('#composer');
    var input = $('#composer-input');
    form.addEventListener('submit', function (ev) { ev.preventDefault(); sendMessage(); });
    input.addEventListener('input', function () {
      autoGrow(input);
      if (S.openChatId) startTyping(S.openChatId);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var desktop = window.matchMedia('(min-width: 820px)').matches;
      if (desktop && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
    });
    $('#composer-attach').addEventListener('click', function (ev) { openAttachSheet(ev); });
    $('#file-input').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) pickFile(f);
    });
    $('#attach-cancel').addEventListener('click', clearAttachment);

    // messages: paginate with ?before=
    $('#messages').addEventListener('scroll', function () {
      var box = $('#messages');
      if (box.scrollTop <= 40) loadOlder();
    });

    // modal
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (ev) {
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-modal-close')) closeModal();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeModal(); hideIncoming(); }
    });

    // calls
    $('#callbtn-audio').addEventListener('click', function () {
      if (!S.openChatId) { toast('Open a chat first.'); return; }
      engineCall('start', [S.openChatId, 'audio'], 'Calling');
    });
    $('#callbtn-video').addEventListener('click', function () {
      if (!S.openChatId) { toast('Open a chat first.'); return; }
      engineCall('start', [S.openChatId, 'video'], 'Calling');
    });
    $('#incoming-accept').addEventListener('click', function () {
      var c = S.pendingCall;
      if (!c) { hideIncoming(); return; }
      engineCall('accept', [callIdOf(c)], 'Answering');
      hideIncoming();
    });
    $('#incoming-decline').addEventListener('click', function () {
      var c = S.pendingCall;
      if (c) engineCall('decline', [callIdOf(c)], 'Declining');
      hideIncoming();
    });
    $('#call-end').addEventListener('click', function () {
      engineCall('leave', [], 'Hanging up');
      closeCallScreen();
    });
    $('#call-mute').addEventListener('click', function () { engineCall('toggleMute', [], 'Mute'); });
    $('#call-cam').addEventListener('click', function () { engineCall('toggleCamera', [], 'Camera'); });
    $('#call-speaker').addEventListener('click', function () { engineCall('toggleSpeaker', [], 'Speaker'); });
    $('#call-add').addEventListener('click', openAddPeople);

    // last seen / hidden tab niceties
    window.addEventListener('focus', function () {
      if (S.token && !window.Net.isOpen()) ws.start();
      if (S.token && S.openChatId) sendRead(S.openChatId);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.token && !window.Net.isOpen()) ws.start();
    });
    window.addEventListener('online', function () { if (S.token) ws.start(); });
  }

  /* --------------------------------- boot --------------------------------- */

  function boot() {
    wire();
    S.token = readToken();
    if (!S.token) {
      // First-ever visit: show the welcome/onboarding screen (Phase 1).
      // Returning visitors (flag set, or arriving via invite) skip straight to auth.
      var seen = false;
      try { seen = localStorage.getItem('jarvis.welcomed') === '1'; } catch (e) { /* storage blocked */ }
      var w = $('#welcome');
      if (w && !seen && !INVITE) {
        w.hidden = false;
        $('#welcome-start').addEventListener('click', function () {
          try { localStorage.setItem('jarvis.welcomed', '1'); localStorage.setItem('jarvis.seenVersion', window.XC_VERSION || '0'); } catch (e) {}
          w.hidden = true;
          showAuth('register');
        });
        $('#welcome-signin').addEventListener('click', function () {
          try { localStorage.setItem('jarvis.welcomed', '1'); localStorage.setItem('jarvis.seenVersion', window.XC_VERSION || '0'); } catch (e) {}
          w.hidden = true;
          showAuth('login');
        });
        return;
      }
      showAuth();
      return;
    }
    // A saved session means "logged in, always" — we never drop it on our own.
    resumeSession();
  }

  /**
   * Prove a saved login and keep trying if the network is down. The token is
   * only thrown away when the server says the session is really gone (401) —
   * never because of a timeout, an offline phone or a restarting server.
   */
  function resumeSession() {
    var tries = 0;
    var connectingShown = false;
    var attempt = function () {
      api('api/me').then(function (r) {
        if (!r || !r.user) throw new Error('Malformed response.');
        startSession(r.user);
        // Already signed in on this device and an invite link was opened: join now.
        if (INVITE) {
          api('api/invite/' + encodeURIComponent(INVITE) + '/accept', { method: 'POST', body: {} })
            .then(function (res) { enterInvitedChat(res && res.joined); })
            .catch(function () { forgetInvite(); });
        }
      }).catch(function (e) {
        if (e && e.status === 401) {          // the session was ended (logout elsewhere / removed)
          clearToken();
          showAuth('login');
          setErr('#login-error', 'That session was ended — please log in again.');
          return;
        }
        tries++;
        if (!connectingShown) {
          connectingShown = true;
          toast('Reconnecting — you are still logged in…');
        }
        setTimeout(attempt, Math.min(15000, 1000 * tries));   // keep trying, forever
      });
    };
    attempt();
  }

  // window.UI — the hooks the calls engine calls into.
  window.UI = {
    me: null,
    toast: toast,
    showIncoming: showIncoming,
    hideIncoming: hideIncoming,
    openCallScreen: openCallScreen,
    closeCallScreen: closeCallScreen,
    setParticipants: setParticipants,
    setCallState: setCallState,
    // call timing: the clock starts when the other side really picks up
    startCallTimer: function (from) {
      if (S.callTimerId) return;          // already connected — don't reset the clock
      S.callStartedAt = ms(from) || Date.now();
      stopCallTimer();
      paintCallStatus('connected');
      paintCallTimer();
      S.callTimerId = setInterval(paintCallTimer, 1000);
    },
    stopCallTimer: function () { stopCallTimer(); },
    /** 'calling' (nobody reachable) or 'ringing' (their phone is really ringing). */
    setCallStatus: function (kind) { paintCallStatus(kind); },
    /** Tell the other side what I am doing: 'text', 'file', 'photo', 'voice'. */
    activity: function (what) {
      var id = S.openChatId;
      if (!id) return;
      if (!what || what === 'text') { startTyping(id, 'text'); return; }
      startTyping(id, what);
    },
    setCallRinging: function (on) {
      var screen = $('#call-screen');
      if (screen) screen.classList.toggle('ringing', !!on);
      if (on) { stopCallTimer(); paintCallStatus('calling'); }
    },
    // extras the engine can lean on if useful (not required by the spec)
    tileFor: tileFor,
    videoFor: videoFor,
    isCallScreenOpen: function () { return !$('#call-screen').hidden; },
    currentCall: function () { return S.currentCall; },
    activeChatId: function () { return S.openChatId; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if ('serviceWorker' in navigator && navigator.serviceWorker && navigator.serviceWorker.register && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // When a NEW UI build is deployed, activate it and silently reload the open app.
        // Without this, the WebView can sit on the old page for days and updates look dead.
        if (reg.waiting) reloadOnce('waiting-sw');
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) reloadOnce('updatefound');
          });
        });
      }).catch(function () { /* offline shell is a bonus */ });
    });
  }
  function reloadOnce(why) {
    try {
      var last = Number(localStorage.getItem('jarvis.autoreload') || 0);
      if (Date.now() - last < 90000) return;             // at most one auto-reload per 90 s
      localStorage.setItem('jarvis.autoreload', String(Date.now()));
    } catch (e) { return; }
    location.reload();
  }
  if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return; reloaded = true; reloadOnce('controllerchange');
    });
  }
})();
