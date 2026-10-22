/*!
 * XCaller UI layer 2 — the WhatsApp-style bits and the Android back button.
 * Pure additive: nothing here is required for the app to work, it only polishes
 * what app.js / calls.js / features.js already render.
 */
(function () {
  'use strict';

  var U = window.UI || {};
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function toast(m, k) { if (U.toast) U.toast(m, k); }

  var IC = {
    mic: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2a3 3 0 013 3v5.6a3 3 0 01-6 0V6.2a3 3 0 013-3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M5.6 11.4a6.4 6.4 0 0012.8 0M12 18v3.2M9.2 21.2h5.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    smile: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.4 14.3a4.6 4.6 0 007.2 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.2" cy="9.8" r="1.15" fill="currentColor"/><circle cx="14.8" cy="9.8" r="1.15" fill="currentColor"/></svg>',
    cam: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.6h3.1L8.5 6.4h7L16.9 8.6H20a1.5 1.5 0 011.5 1.5v7.9A1.5 1.5 0 0120 19.5H4A1.5 1.5 0 012.5 18v-7.9A1.5 1.5 0 014 8.6z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="13.6" r="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>',
    pause: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5h3.2v13H8zM12.8 5.5H16v13h-3.2z" fill="currentColor"/></svg>',
  };

  var EMOJI = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤗', '🤔', '🙌', '👋', '👍', '👎', '🙏', '👏',
    '💪', '🔥', '💯', '🎉', '❤️', '💙', '💚', '😅', '😢', '😭', '😡', '🤯', '😴', '🤝', '✌️', '👌',
    '🤙', '✅', '❌', '⚠️', '⏰', '📌', '📎', '📷', '🎤', '📞', '💬', '🚀', '⭐', '☕', '🍕', '🎵'];

  /* ------------------------------------------------------------ composer -- */

  function buildComposer() {
    var form = $('#composer');
    if (!form) return;
    var input = $('#composer-input');

    // WhatsApp behaviour: mic while the field is empty, send once there is text
    if (input && !input.__xcSwap) {
      input.__xcSwap = true;
      var sync = function () { form.classList.toggle('has-text', !!input.value.trim()); };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      sync();
    }

    // a real microphone icon instead of the emoji
    var mic = $('#jc-mic');
    if (mic && !mic.__xcIcon) { mic.__xcIcon = true; mic.innerHTML = IC.mic; }

    // emoji button (left, exactly like WhatsApp)
    if (! $('#jc-emoji')) {
      var eb = el('button', 'icon-btn');
      eb.type = 'button'; eb.id = 'jc-emoji'; eb.title = 'Emoji';
      eb.setAttribute('aria-label', 'Emoji');
      eb.innerHTML = IC.smile;
      eb.addEventListener('click', function (ev) { ev.preventDefault(); toggleEmoji(eb); });
      form.insertBefore(eb, form.firstChild);
    }

    // camera button: shoot a photo straight into the chat
    if (! $('#composer-camera')) {
      var cam = el('button', 'icon-btn');
      cam.type = 'button'; cam.id = 'composer-camera'; cam.title = 'Camera';
      cam.setAttribute('aria-label', 'Camera');
      cam.innerHTML = IC.cam;
      cam.addEventListener('click', function (ev) {
        ev.preventDefault();
        var fi = $('#file-input');
        if (!fi) return;
        fi.setAttribute('capture', 'environment');
        try { fi.click(); } catch (e) { toast('Camera is not available here', 'error'); }
        setTimeout(function () { fi.removeAttribute('capture'); }, 5000);
      });
      var send = $('#composer-send');
      if (send && send.parentNode) send.parentNode.insertBefore(cam, send); else form.appendChild(cam);
    }
  }

  function toggleEmoji(btn) {
    var pop = $('#jc-emoji-pop');
    if (pop) { pop.remove(); return; }
    pop = el('div');
    pop.id = 'jc-emoji-pop';
    EMOJI.forEach(function (e) {
      var b = el('button', null, e);
      b.type = 'button';
      b.addEventListener('click', function () { insertEmoji(e); });
      pop.appendChild(b);
    });
    document.body.appendChild(pop);
    try {
      var r = btn.getBoundingClientRect();
      pop.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    } catch (e) { /* keep the CSS default */ }
  }

  function insertEmoji(text) {
    var i = $('#composer-input');
    if (!i) return;
    i.value += text;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.focus();
  }

  /* -------------------------------------------------------- back handling -- */

  function chatOpenId() {
    try { return U.activeChatId ? U.activeChatId() : null; } catch (e) { return null; }
  }
  function vis(id) { var n = document.getElementById(id); return !!(n && !n.hidden); }

  /** Close the opened chat (mobile layout shows a back arrow in the header). */
  function leaveChat() {
    var b = $('#back-btn');
    if (b) { b.click(); return true; }
    return false;
  }

  /**
   * The Android shell calls this on the hardware back button. Return true when
   * the page handled it, false when there is nothing left to close (so the app
   * may exit). Also used by the browser's own back gesture via popstate.
   */
  /** Remove an overlay with its exit animation (UI feels alive even when closing). */
  function closeFx(node, anim) {
    if (!node) return true;
    node.style.animation = (anim || 'sheetDown .18s ease forwards');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 180);
    return true;
  }

  window.XCBack = function () {
    var pop = $('#jc-emoji-pop');
    if (pop) { pop.remove(); return true; }
    var menu = $('#jc-menu');
    if (menu) return closeFx(menu);
    var confirm_ = $('#xc-confirm');
    if (confirm_) { var cno = confirm_.querySelector('.xc-btn.ghost'); if (cno) { cno.click(); return true; } return closeFx(confirm_); }
    if (vis('call-screen')) {
      try { window.Calls.leave(); } catch (e) {}
      return true;
    }
    if (vis('incoming')) {
      var d = $('#incoming-decline');
      if (d) d.click();
      return true;
    }
    var calls = $('#jc-calls');
    if (calls) return closeFx(calls, 'fadeOut .16s ease forwards');
    var sheets = ['jc-fwd', 'jc-members', 'jc-invite', 'jc-hide-members', 'jc-usernames', 'jc-diag'];
    for (var i = 0; i < sheets.length; i++) {
      var s = document.getElementById(sheets[i]);
      if (s) return closeFx(s);
    }
    if (vis('profile-modal') || $('#modal-backdrop:not([hidden])')) {
      var x = $('#modal-backdrop:not([hidden]) .modal-x, #modal-backdrop:not([hidden]) #modal-close');
      if (x) { x.click(); return true; }
    }
    if (chatOpenId() != null) return leaveChat();
    return false;
  };

  window.addEventListener('popstate', function () {
    if (chatOpenId() != null) leaveChat();
  });

  // one history SENTINEL, reused for whichever chat is open: the browser's back
  // gesture pops it and closes the chat, and the next chat open re-uses the slot.
  // The old push-per-open piled entries up forever — the APK's back button then
  // burned them one press at a time before it could exit (the "7-8 presses" bug).
  var openSeen = null;
  setInterval(function () {
    var id = chatOpenId();
    if (id != null && id !== openSeen) {
      openSeen = id;
      try {
        if (history.state && history.state.xcChat) history.replaceState({ xcChat: id }, '');
        else history.pushState({ xcChat: id }, '');
      } catch (e) { /* ignore */ }
    } else if (id == null && openSeen != null) {
      openSeen = null;
    }
  }, 500);

  /* ------------------------------------------------------ call fullscreen -- */

  var callWasOpen = false;
  setInterval(function () {
    var open = vis('call-screen');
    if (open === callWasOpen) return;
    callWasOpen = open;
    try { if (window.XCApp && window.XCApp.fullscreen) window.XCApp.fullscreen(open ? 'on' : 'off'); } catch (e) {}
    try {
      if (open && document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {});
      } else if (!open && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    } catch (e) { /* the shell handles it instead */ }
  }, 700);

  /* ------------------------------------------------------- voice messages -- */

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /** Turn the plain audio element into the round WhatsApp-style player. */
  function decorateVoice() {
    // Cleanup first: wrappers the calls engine used to leave behind. When a call
    // ended, only its hidden <audio> was removed — the .voice-note wrapper around
    // it (play button + seekbar) stayed in the page forever, one per call, piling
    // up under the chat box. Any player outside the messages box is a leftover.
    document.querySelectorAll('.voice-note').forEach(function (w) {
      if (!w.closest('#messages') && w.parentNode) w.parentNode.removeChild(w);
    });
    $$('audio').forEach(function (a) {
      if (a.__xcPlayer || a.closest('#jc-emoji-pop')) return;
      // call audio is hidden plumbing: it must never grow a visible player
      if (a.id && a.id.indexOf('call-audio-') === 0) return;
      var row = a.closest('.msg');
      if (row && row.classList.contains('deleted')) { a.remove(); return; }
      a.__xcPlayer = true;
      if (!a.parentNode) return;
      var wrap = el('div', 'voice-note');
      var btn = el('button', 'vn-play');
      btn.type = 'button';
      btn.innerHTML = IC.play;
      var bar = el('div', 'vn-bar');
      var fill = el('div', 'vn-fill');
      bar.appendChild(fill);
      var time = el('span', 'vn-time', '0:00');
      wrap.appendChild(btn);
      wrap.appendChild(bar);
      wrap.appendChild(time);
      a.parentNode.insertBefore(wrap, a);
      wrap.appendChild(a);                       // the element itself stays hidden
      a.removeAttribute('controls');

      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (a.paused) {
          $$('audio').forEach(function (o) { if (o !== a) { try { o.pause(); } catch (e) {} } });
          var p = a.play();
          if (p && p.catch) p.catch(function () { toast('Cannot play this recording', 'error'); });
        } else {
          a.pause();
        }
      });
      a.addEventListener('play', function () { btn.innerHTML = IC.pause; });
      a.addEventListener('pause', function () { btn.innerHTML = IC.play; });
      a.addEventListener('ended', function () { btn.innerHTML = IC.play; fill.style.width = '0%'; time.textContent = fmtTime(a.duration); });
      a.addEventListener('loadedmetadata', function () { time.textContent = fmtTime(a.duration); });
      a.addEventListener('timeupdate', function () {
        var d = a.duration || 0;
        fill.style.width = d ? (a.currentTime / d * 100) + '%' : '0%';
        time.textContent = fmtTime(a.currentTime) + (d ? '' : '');
      });
    });
  }

  /* ------------------------------------------- "sending a file…" (Telegram) -- */

  var announceTimer = null;
  var voiceAnnounced = false;

  function announce(what) {
    try { if (U.activity) U.activity(what); } catch (e) {}
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      try { if (U.activity) U.activity('text'); } catch (e) {}
    }, what === 'voice' ? 30000 : 15000);
  }

  /** A temporary bubble on my own side: "Sending photo.jpg…". */
  function showSending(text) {
    var box = document.getElementById('messages');
    if (!box) return;
    clearSending();
    var row = el('div', 'msg out jc-sending');
    row.id = 'jc-sending';
    var b = el('div', 'bubble', text);
    row.appendChild(b);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }
  function clearSending() {
    var n = document.getElementById('jc-sending');
    if (n) n.remove();
  }

  function watchTransfers() {
    // a file was chosen (paperclip or camera)
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || t.id !== 'file-input' || !t.files || !t.files.length) return;
      var f = t.files[0];
      var what = /^image\//i.test(f.type) ? 'photo' : /^video\//i.test(f.type) ? 'video' : 'file';
      announce(what);
      showSending((what === 'photo' ? 'Sending photo ' : what === 'video' ? 'Sending video ' : 'Sending file ') + (f.name || '') + '…');
    }, true);

    // while a voice note is being recorded
    setInterval(function () {
      var rec = document.getElementById('jc-rec');
      if (rec && !voiceAnnounced) {
        voiceAnnounced = true;
        announce('voice');
        showSending('Recording a voice message…');
      } else if (!rec && voiceAnnounced) {
        voiceAnnounced = false;
        clearSending();
      }
    }, 600);

    // clear the "sending" bubble as soon as my message really lands
    var lastCount = 0;
    setInterval(function () {
      var n = document.querySelectorAll('#messages .msg.out').length;
      if (n > lastCount) clearSending();
      lastCount = n;
    }, 700);
  }

  /* ----------------------------------------------- real delivery receipts -- */

  var netHooked = false;
  function hookNet() {
    var N = window.Net;
    if (netHooked || !N || !N.on || !N.send) return;
    netHooked = true;

    // I am holding a message that just arrived → tell the server it is delivered
    N.on('msg.new', function (f) {
      var m = f && f.message;
      if (!m || !m.chatId) return;
      var me = U.me && U.me.id;
      if (me != null && String(m.senderId) === String(me)) return;   // my own copy
      N.send({ t: 'delivered', chatId: m.chatId, ids: [m.id] });
      if (U.activeChatId && String(U.activeChatId()) === String(m.chatId)) {
        N.send({ t: 'read', chatId: m.chatId });                     // it is on screen
      }
    });

    // the other device confirmed → my ✓ becomes ✓✓
    N.on('msg.delivered', function (f) {
      if (!f || !f.ids) return;
      f.ids.forEach(function (id) { setRowState(id, 'delivered'); });
    });
  }

  function setRowState(id, state) {
    $$('.msg.out').forEach(function (row) {
      var m = row.__jcMsg;
      if (!m || String(m.id) !== String(id)) return;
      var ticks = row.querySelector('.ticks');
      if (!ticks || ticks.dataset.state === 'read') return;
      ticks.dataset.state = state;
      if (state === 'delivered') m.deliveredAt = m.deliveredAt || Date.now();
    });
  }

  /** Rows rendered from stored data may already carry a delivery time. */
  function decorateTicks() {
    $$('.msg.out').forEach(function (row) {
      var m = row.__jcMsg;
      var ticks = row.querySelector('.ticks');
      if (!m || !ticks || ticks.dataset.state === 'read') return;
      if (m.deliveredAt || m.delivered_at) ticks.dataset.state = 'delivered';
    });
  }

  /* ------------------------------------------------------- call history ---- */

  function apiGet(path, token) {
    return fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then(function (r) { return r.json(); });
  }
  function token() { try { return localStorage.getItem('jarvis.token'); } catch (e) { return null; } }

  function callsButton() {
    var head = document.querySelector('#sidebar .pane-head');
    if (!head || document.getElementById('jc-calls-btn')) return;
    var b = el('button', 'icon-btn');
    b.type = 'button'; b.id = 'jc-calls-btn'; b.title = 'Calls'; b.setAttribute('aria-label', 'Calls');
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.5h3.2l1.7 4.2-2.2 1.6a12.5 12.5 0 006.5 6.5l1.6-2.2 4.2 1.7v3.2a1.5 1.5 0 01-1.6 1.5A17.5 17.5 0 013 5.1 1.5 1.5 0 014.5 3.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    b.addEventListener('click', function (ev) { ev.preventDefault(); openCalls(); });
    head.appendChild(b);
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    if (!s) return '';
    var m = Math.floor(s / 60);
    return m ? (m + ' min ' + (s % 60) + 's') : (s + 's');
  }
  function fmtWhen(ts) {
    var d = new Date(ts || Date.now());
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return (sameDay ? 'Today ' : d.toLocaleDateString() + ' ') + hh + ':' + mm;
  }
  function initials(name) {
    var t = String(name || '?').trim();
    return t ? t[0].toUpperCase() : '?';
  }
  /** 'Today' / 'Yesterday' / '2 Oct' — no repeated full dates, no locale ambiguity. */
  function dayLabel(ms) {
    var d = new Date(Number(ms)), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getDate() + ' ' + mon[d.getMonth()] + (d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear());
  }
  function timeShort(ms) {
    var d = new Date(Number(ms));
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  /** Only the missed/outgoing-no-answer rows get red; durations never print for missed calls. */
  function callRowText(c) {
    var kind = c.kind === 'video' ? 'Video' : 'Voice';
    var dur = c.durationMs && c.answered ? ' · ' + fmtDur(c.durationMs) : '';
    if (c.outgoing) return (c.answered ? 'Outgoing ' : 'No answer ') + kind + dur;
    return (c.answered ? 'Incoming ' : 'Missed ') + kind + dur;
  }

  function openCalls() {
    var old = document.getElementById('jc-calls');
    if (old) old.remove();
    var wrap = el('div', 'jc-calls');
    wrap.id = 'jc-calls';
    var head = el('div', 'jc-calls-head');
    head.appendChild(el('div', 'jc-calls-title', 'Calls'));
    var x = el('button', 'icon-btn', '\u2715');
    x.type = 'button';
    x.addEventListener('click', function () { wrap.remove(); });
    head.appendChild(x);
    wrap.appendChild(head);
    var search = el('input', 'jc-call-search');
    search.type = 'search'; search.placeholder = 'Search calls by name\u2026';
    wrap.appendChild(search);
    var list = el('div', 'jc-calls-list');
    list.appendChild(el('div', 'empty', 'Loading call history\u2026'));
    wrap.appendChild(list);
    document.body.appendChild(wrap);

    var allCalls = [];
    function render(filter) {
      var q = String(filter || '').trim().toLowerCase();
      list.textContent = '';
      if (!allCalls.length) { list.appendChild(el('div', 'empty', 'No calls yet. Voice and video calls you make or receive show up here.')); return; }
      var shown = 0, lastDay = null;
      allCalls.forEach(function (c) {
        var name = (c.peer && (c.peer.displayName || c.peer.username)) || c.chatTitle || 'Call';
        if (q && name.toLowerCase().indexOf(q) < 0) return;
        shown++;
        var day = dayLabel(c.startedAt);
        if (day !== lastDay) { lastDay = day; list.appendChild(el('div', 'jc-call-day', day)); }
        var row = el('div', 'jc-call-row' + (c.missed || (c.outgoing && !c.answered) ? ' missed' : ''));
        row.style.animationDelay = (shown < 12 ? shown * 25 : 0) + 'ms';   // cascade on first screenful
        var av = el('span', 'avatar av-40', initials(name));
        if (c.peer && c.peer.avatarColor) av.style.background = c.peer.avatarColor;
        row.appendChild(av);
        var mid = el('div', 'jc-call-mid');
        var title = el('div', 'jc-call-name');
        title.appendChild(el('span', null, name));
        title.appendChild(el('span', 'jc-call-time', timeShort(c.startedAt)));
        var sub = el('div', 'jc-call-sub');
        var ico = el('span', 'jc-call-ic ' + (c.outgoing ? 'out' : 'in') + ((c.outgoing && !c.answered) ? ' bad' : ''));
        ico.textContent = c.outgoing ? '\u2197' : '\u2199';
        sub.appendChild(ico);
        sub.appendChild(el('span', null, callRowText(c)));
        mid.appendChild(title);
        mid.appendChild(sub);
        row.appendChild(mid);
        var call = el('button', 'icon-btn jc-call-again' + (c.kind === 'video' ? ' vid' : ''));
        call.type = 'button'; call.title = c.kind === 'video' ? 'Video call back' : 'Voice call back';
        call.innerHTML = c.kind === 'video'
          ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h10a1 1 0 011 1v8a1 1 0 01-1 1h-10a1 1 0 01-1-1v-8a1 1 0 011-1zM14.5 10l5-3v10l-5-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
          : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.5h3.2l1.7 4.2-2.2 1.6a12.5 12.5 0 006.5 6.5l1.6-2.2 4.2 1.7v3.2a1.5 1.5 0 01-1.6 1.5A17.5 17.5 0 013 5.1 1.5 1.5 0 014.5 3.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        call.addEventListener('click', function (ev) {
          ev.stopPropagation();
          wrap.remove();
          try { window.Calls.start(c.chatId, c.kind === 'video' ? 'video' : 'audio'); } catch (e) { toast('Could not start the call', 'error'); }
        });
        row.appendChild(call);
        row.addEventListener('click', function () {
          wrap.remove();
          var rows = $$('#chatlist .chat-row, #chatlist > *');
          var hit = rows.find(function (r) { return r.dataset && String(r.dataset.chatId) === String(c.chatId); });
          if (hit) hit.click();
        });
        list.appendChild(row);
      });
      if (q && !shown) list.appendChild(el('div', 'empty', 'No calls match that name.'));
    }
    search.addEventListener('input', function () { render(search.value); });

    apiGet('api/calls?limit=120', token()).then(function (r) {
      allCalls = (r && r.calls) || [];
      render('');
    }).catch(function (e) {
      list.textContent = '';
      list.appendChild(el('div', 'empty', 'Could not load the call history.'));
      console.warn('[calls]', e);
    });
  }
  window.XCCalls = openCalls;

  /* ------------------------------------------------------------ updates ---- */

  function runningVersion() {
    var m = navigator.userAgent.match(/XCallerApp\/([0-9.]+)/i);
    if (m) return m[1];
    return window.XC_VERSION || '0';
  }
  function cmpVersion(a, b) {
    var pa = String(a).split('.').map(Number);
    var pb = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }
  function isApp() { return /XCallerApp\//i.test(navigator.userAgent); }

  /** Bullets for a release, with a graceful fallback to the old one-line notes. */
  function whatsNewBullets(v) {
    if (v && Object.prototype.toString.call(v.whatsNew) === '[object Array]' && v.whatsNew.length) {
      return v.whatsNew.map(function (x) { return String(x || '').trim(); }).filter(Boolean);
    }
    if (v && v.notes) {
      return String(v.notes).split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return [];
  }

  /** After an update, say what changed — once per release, on existing installs. */
  function showWhatsNew(v) {
    var current = runningVersion();
    var seen = '';
    try { seen = localStorage.getItem('jarvis.seenVersion') || ''; } catch (e) {}
    if (seen) {
      if (cmpVersion(current, seen) <= 0) return;
    } else {
      var welcomed = false;
      try { welcomed = localStorage.getItem('jarvis.welcomed') === '1'; } catch (e) {}
      // Brand-new install: no changelog. Existing install: show it once.
      if (!welcomed) { try { localStorage.setItem('jarvis.seenVersion', current); } catch (e) {} return; }
    }
    var app = document.getElementById('app');
    if (!app || app.hidden) { setTimeout(function () { try { showWhatsNew(v); } catch (e) {} }, 6000); return; }
    // Never cover a ringing or active call with a changelog.
    var call = document.getElementById('call-screen');
    var ring = document.getElementById('incoming');
    if ((call && !call.hidden) || (ring && !ring.hidden)) {
      setTimeout(function () { try { showWhatsNew(v); } catch (e) {} }, 15000);
      return;
    }
    if (document.getElementById('xc-wn-mask')) return;
    var items = whatsNewBullets(v);
    if (!items.length) { try { localStorage.setItem('jarvis.seenVersion', current); } catch (e) {} return; }

    var mask = el('div', 'xc-wn-mask');
    mask.id = 'xc-wn-mask';
    var card = el('div', 'xc-wn-card');
    card.appendChild(el('div', 'xc-wn-badge', 'XC'));
    card.appendChild(el('div', 'xc-wn-kicker', 'What\u2019s new'));
    card.appendChild(el('div', 'xc-wn-title', 'XCaller ' + current));
    card.appendChild(el('div', 'xc-wn-sub', 'Updated and ready. Your chats and calls are unchanged.'));
    var ul = el('ul', 'xc-wn-list');
    items.forEach(function (t) { ul.appendChild(el('li', null, t)); });
    card.appendChild(ul);
    var go = el('button', 'xc-wn-go', 'Got it');
    go.type = 'button';
    var close = function () {
      try { localStorage.setItem('jarvis.seenVersion', current); } catch (e) {}
      mask.remove();
    };
    go.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    card.appendChild(go);
    mask.appendChild(card);
    document.body.appendChild(mask);
    window.XCWhatsNew = function () { close(); return 'ok'; };
  }

  /** Only the installed app (or a home-screen PWA) is offered the APK download;
   *  a normal browser tab just picks the new build up on its next reload. */
  function offerUpdate() {
    return true;      // everyone gets told about a new version (dismissible)
  }

  /** The pre-3.2 shells cannot download anything by themselves: show the APK link
   *  with a copy button so the user can finish the update in Chrome. */
  function oldShellPanel(card, v, abs) {
    card.textContent = '';
    card.appendChild(el('div', 'xc-upd-ic', '\u2b06'));
    card.appendChild(el('div', 'xc-upd-title', 'Update XCaller ' + v.version));
    card.appendChild(el('div', 'xc-upd-text', 'This version cannot update itself. Open this link in your browser (Chrome), then tap the downloaded file to install:'));
    card.appendChild(el('div', 'xc-upd-link', abs.replace(/^https:\/\//, '')));
    var cp = el('button', 'xc-upd-go', 'Copy link');
    cp.type = 'button';
    cp.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var ta = document.createElement('textarea');
      ta.value = abs; document.body.appendChild(ta); ta.select();
      var okc = false;
      try { okc = document.execCommand('copy'); } catch (e) {}
      if (navigator.clipboard) { try { navigator.clipboard.writeText(abs); okc = true; } catch (e) {} }
      document.body.removeChild(ta);
      cp.textContent = okc ? 'Copied \u2713 \u2014 paste into Chrome' : 'Copy failed \u2014 type the link';
    });
    card.appendChild(cp);
  }

  var FORCE_UPDATE = false;
  function checkUpdate() {
    fetch('api/version').then(function (r) { return r.json(); }).then(function (v) {
      if (!v || !v.version) return;
      var mine = runningVersion();
      if (cmpVersion(v.version, mine) <= 0) {
        try { showWhatsNew(v); } catch (eW) {}
        return;
      }
      if (!FORCE_UPDATE && !offerUpdate()) return;
      try {
        if (/[?&]update=1/.test(location.search)) {
          localStorage.removeItem('jarvis.updateSkipped');   // tapped the update notification: ask again NOW
          history.replaceState(null, '', location.pathname);
        }
      } catch (eS) {}
      if (!FORCE_UPDATE && localStorage.getItem('jarvis.updateSkipped') === v.version) {
        var skippedAt = Number(localStorage.getItem('jarvis.updateSkippedAt') || 0);
        if (Date.now() - skippedAt < 3600000) return;      // ask again in an hour
      }
      if (document.getElementById('jc-update-modal')) return;

      // A full-screen, non-dismissible panel with one big button — the user has
      // to act on the update; a top banner is too easy to ignore or mis-tap.
      var mask = el('div', 'xc-upd-mask');
      mask.id = 'jc-update-modal';
      var card = el('div', 'xc-upd-card');
      card.appendChild(el('div', 'xc-upd-ic', '⬆'));
      card.appendChild(el('div', 'xc-upd-title', 'Update required'));
      card.appendChild(el('div', 'xc-upd-text', 'XCaller ' + v.version + ' is available. What’s new:'));
      var updItems = whatsNewBullets(v);
      if (updItems.length) {
        var updList = el('ul', 'xc-upd-list');
        updItems.forEach(function (t) { updList.appendChild(el('li', null, t)); });
        card.appendChild(updList);
      }
      var big = el('button', 'xc-upd-go', isApp() ? 'Update now' : 'Download update');
      big.type = 'button';
      var go = function () {
        var url = v.apk || '/chat/XCaller.apk';
        var abs = url.indexOf('http') === 0 ? url : (location.origin + url);
        if (isApp() && window.XCApp && window.XCApp.installApk) {
          // 3.2+ shell: native downloader opens the installer by itself
          try { window.XCApp.installApk(abs); } catch (e) { /* fall through */ }
          toast('Downloading XCaller ' + v.version + ' — the installer opens when it finishes');
          big.textContent = 'Downloading\u2026';
        } else if (isApp()) {
          // Old shell (2.6\u20133.1): bridge dead + WebView blocks APK navigations.
          // intent:// is NOT the app origin, so the shell hands it to Android -> browser
          // downloads and installs. If the shell swallows it, the copy-link panel shows.
          var p = url.indexOf('http') === 0 ? new URL(url).pathname : url;
          var it = 'intent://' + location.hostname + ':443' + p +
                   '#Intent;scheme=https;action=android.intent.action.VIEW;type=application/vnd.android.package-archive;end;';
          big.textContent = 'Opening browser\u2026';
          try { window.location.href = it; } catch (e1) {}
          setTimeout(function () {
            var m = document.getElementById('jc-update-modal');
            if (m && document.visibilityState === 'visible' && !m.__handoff) {
              m.__handoff = 1; oldShellPanel(card, v, abs);
            }
          }, 2500);
        } else {
          window.location.href = abs;
        }
      };
      big.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); go(); });
      card.appendChild(big);
      if (FORCE_UPDATE) {
        // no escape at all on a forced release
      } else {
        var later = el('button', 'xc-upd-later', 'Not now — ask again in 1 hour');
        later.type = 'button';
        later.addEventListener('click', function () {
          try { localStorage.setItem('jarvis.updateSkipped', v.version); localStorage.setItem('jarvis.updateSkippedAt', String(Date.now())); } catch (e) {}
          mask.remove();
        });
        card.appendChild(later);
      }
      mask.appendChild(card);
      document.body.appendChild(mask);
      window.XCUpdate = function () {
        try { localStorage.removeItem('jarvis.updateSkipped'); } catch (e) {}
        var m = document.getElementById('jc-update-modal');
        if (m) { var b = m.querySelector('.xc-upd-go'); if (b) b.click(); }
        else { FORCE_UPDATE = true; checkUpdate(); }
        return 'ok';
      };
      window.XCCheckUpdate = function (manual) {
        if (manual) { try { localStorage.removeItem('jarvis.updateSkipped'); } catch (e) {} checkUpdate(); }
      };
      return;

    }).catch(function () { /* offline: try again next time */ });
  }

  /* ------------------------------------------------- chat menu + groups ---- */

  function openChatMenu() {
    var chatId = U.activeChatId && U.activeChatId();
    if (chatId == null) return;
    var old = document.getElementById('jc-menu');
    if (old) old.remove();
    var sheet = el('div', 'jc-menu');
    sheet.id = 'jc-menu';
    var inner = el('div', 'jc-menu-inner');
    sheet.appendChild(inner);
    sheet.addEventListener('click', function (ev) { if (ev.target === sheet) sheet.remove(); });

    apiGet('api/chats', token()).then(function (r) {
      var chat = ((r && r.chats) || []).find(function (c) { return String(c.id) === String(chatId); });
      var isGroup = chat && chat.kind === 'group';
      var item = function (label, fn, danger) {
        var b = el('button', 'jc-menu-item' + (danger ? ' danger' : ''), label);
        b.type = 'button';
        b.addEventListener('click', function () { sheet.remove(); fn(); });
        inner.appendChild(b);
      };
      item(isGroup ? 'Leave group' : 'Delete chat', function () { deleteChat(chatId, isGroup ? 'leave' : 'hide'); }, true);
      if (isGroup) item('Invite by link', function () { XCInviteLink(chatId); });
      if (isGroup) item('Members — add / remove', function () { openMembersPanel(chatId); });
      if (isGroup) item('Delete chat (hide it for me only)', function () { deleteChat(chatId, 'hide'); }, true);
      item('Cancel', function () {});
    }).catch(function () {
      var b = el('button', 'jc-menu-item danger', 'Delete chat');
      b.type = 'button';
      b.addEventListener('click', function () { sheet.remove(); deleteChat(chatId, 'hide'); });
      inner.appendChild(b);
    });
    document.body.appendChild(sheet);
  }

  /** The group owner's shareable link: copy it, send it, or make a fresh one. */
  window.XCInviteLink = function (chatId) {
    var old = document.getElementById('jc-invite');
    if (old) old.remove();
    var sheet = el('div', 'jc-menu');
    sheet.id = 'jc-invite';
    var inner = el('div', 'jc-menu-inner jc-invite-inner');
    var title = el('div', 'jc-invite-title', 'Invite by link');
    var sub = el('div', 'jc-invite-sub', 'Anyone who opens this link creates an account and lands in this group.');
    var box = el('input', 'jc-invite-url');
    box.type = 'text'; box.readOnly = true; box.value = 'Creating link…';
    var row = el('div', 'jc-invite-row');
    var copy = el('button', 'btn primary', 'Copy link');
    var share = el('button', 'btn', 'Share');
    var fresh = el('button', 'btn jc-invite-fresh', 'Create a new link');
    var close = el('button', 'btn', 'Close');
    row.appendChild(copy); row.appendChild(share);
    var row2 = el('div', 'jc-invite-row');
    row2.appendChild(fresh); row2.appendChild(close);
    inner.appendChild(title); inner.appendChild(sub); inner.appendChild(box);
    inner.appendChild(row); inner.appendChild(row2);
    sheet.appendChild(inner);          // <- without this the panel never reached the screen
    sheet.addEventListener('click', function (ev) { if (ev.target === sheet) sheet.remove(); });
    close.addEventListener('click', function () { sheet.remove(); });
    document.body.appendChild(sheet);

    function make(regenerate) {
      box.value = 'Creating link…';
      fetch('api/chats/' + encodeURIComponent(chatId) + '/invite', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token() ? { Authorization: 'Bearer ' + token() } : {}),
        body: JSON.stringify(regenerate ? { fresh: true } : {}),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (!r || !r.url) throw new Error((r && r.message) || 'Could not create the link.');
        box.value = r.url;
        box.dataset.url = r.url;
        sub.textContent = 'Anyone who opens this link creates an account and lands in this group. It stays valid unless you make a new one.';
      }).catch(function (e) { box.value = ''; sub.textContent = e.message || 'Could not create the link.'; });
    }
    copy.addEventListener('click', function () {
      var u = box.dataset.url || box.value;
      try { box.select(); document.execCommand('copy'); } catch (e) { /* fall back below */ }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).catch(function () {});
      toast('Link copied — send it to whoever should join');
    });
    share.addEventListener('click', function () {
      var u = box.dataset.url || box.value;
      if (navigator.share) { navigator.share({ title: 'Join me on XCaller', text: 'Join me on XCaller', url: u }).catch(function () {}); return; }
      try { box.select(); document.execCommand('copy'); } catch (e) { /* ignore */ }
      toast('Link copied — paste it wherever you like');
    });
    fresh.addEventListener('click', function () { make(true); });
    make(false);
  };

  /**
   * Everything that could only be checked by holding the phone: one screen that
   * reports what the device thinks, and one-tap tests for each of it. If a test
   * does not fire, that single row is the bug to look at.
   */
  window.XCDiag = function () {
    var old = document.getElementById('jc-diag');
    if (old) old.remove();
    var sheet = el('div', 'jc-menu');
    sheet.id = 'jc-diag';
    var inner = el('div', 'jc-menu-inner');
    inner.appendChild(el('div', 'jc-menu-title', 'Diagnostics & tests'));

    var inApp = false;
    try { inApp = !!(window.XCApp && window.XCApp.diag); } catch (e) { inApp = false; }

    var report = el('pre', 'jc-diag-report', 'Reading the device…');
    inner.appendChild(report);

    function lines() {
      var out = [];
      var native = null;
      try { if (inApp) native = JSON.parse(window.XCApp.diag() || '{}'); } catch (e) { native = { error: String(e && e.message || e) }; }
      out.push('app        : ' + (window.XC_VERSION || '?') + (inApp ? '  (Android app)' : '  (browser)'));
      out.push('online     : ' + (navigator.onLine ? 'yes' : 'no'));
      out.push('signed in  : ' + (token() ? 'yes' : 'no'));
      try {
        out.push('notify API : ' + (('Notification' in window) ? Notification.permission : 'unsupported'));
      } catch (e) { out.push('notify API : ?'); }
      if (navigator.serviceWorker) {
        out.push('background : ' + (navigator.serviceWorker.controller ? 'service worker active' : 'no service worker'));
      }
      if (native) {
        out.push('');
        out.push('--- from the phone ---');
        Object.keys(native).forEach(function (k) { out.push((k + '        ').slice(0, 11) + ': ' + native[k]); });
      } else {
        out.push('');
        out.push('The device tests need the Android app (this is a browser).');
      }
      return out.join('\n');
    }

    function refresh() { report.textContent = lines(); }
    refresh();
    var timer = setInterval(refresh, 2500);
    sheet.addEventListener('click', function (ev) { if (ev.target === sheet) { clearInterval(timer); sheet.remove(); } });

    function act(label, fn) {
      var b = el('button', 'btn', label);
      b.addEventListener('click', function () {
        try { fn(); } catch (e) { toast('That test failed: ' + (e && e.message ? e.message : 'unknown')); }
      });
      return b;
    }

    var row1 = el('div', 'jc-invite-row');
    row1.appendChild(act('Test notification', function () {
      if (!inApp || !XCApp.testNotify) return toast('This needs the Android app');
      toast(XCApp.testNotify('msg') + ' — check your phone’s notifications');
    }));
    row1.appendChild(act('Test missed call', function () {
      if (!inApp || !XCApp.testNotify) return toast('This needs the Android app');
      toast(XCApp.testNotify('missed') + ' — it should appear as a missed call');
    }));
    inner.appendChild(row1);

    var row2 = el('div', 'jc-invite-row');
    row2.appendChild(act('Test speaker', function () {
      if (!inApp || !XCApp.testSpeaker) return toast('This needs the Android app');
      toast('Audio route: ' + XCApp.testSpeaker());
    }));
    row2.appendChild(act('Check for update', function () {
      if (window.XCCheckUpdate) { window.XCCheckUpdate(true); toast('Checking…'); return; }
      location.reload();
    }));
    // A manual path that always works, even if the banner was dismissed or the version check
    // disagrees with what is installed on this phone.
    row2.appendChild(act('Download update', function () {
      window.location.href = location.origin + '/chat/XCaller.apk';
    }));
    inner.appendChild(row2);

    var row3 = el('div', 'jc-invite-row');
    row3.appendChild(act('Notification settings', function () {
      if (inApp && XCApp.openNotificationSettings) XCApp.openNotificationSettings(); else toast('Android only');
    }));
    row3.appendChild(act('Battery settings', function () {
      if (inApp && XCApp.openBatterySettings) XCApp.openBatterySettings(); else toast('Android only');
    }));
    inner.appendChild(row3);

    var row4 = el('div', 'jc-invite-row');
    row4.appendChild(act('Call report', function () {
      if (!window.Calls || !window.Calls.report) return toast('No call engine loaded');
      window.Calls.report().then(function (r) {
        var out = report.textContent + '\n\n--- call report ---\n' + JSON.stringify(r, null, 1);
        report.textContent = out;
        toast(r.verdict);
      });
    }));
    row4.appendChild(act('Copy report', function () {
      var t = report.textContent;
      try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) {}
      toast('Report copied — send it to me if something looks wrong');
    }));
    var close = el('button', 'btn', 'Close');
    close.addEventListener('click', function () { clearInterval(timer); sheet.remove(); });
    row4.appendChild(close);
    inner.appendChild(row4);

    sheet.appendChild(inner);
    document.body.appendChild(sheet);
  };

  function deleteChat(chatId, mode) {
    return new Promise(function (resolve) {
      var leave = mode === 'leave';
      var sheet = el('div', 'jc-menu');
      sheet.id = 'jc-delchat';
      var inner = el('div', 'jc-menu-inner jc-delchat-inner');
      var h = el('div', 'jc-delchat-title', leave ? 'Leave group?' : 'Delete chat?');
      var p1 = el('div', 'jc-delchat-sub', leave
        ? 'You will be removed and stop receiving messages from this group. Other members keep their history.'
        : 'This chat disappears from your list. Your messages stay on your device\u2019s history only until you delete them — the other person keeps their copy. This cannot be undone.');
      var row = el('div', 'jc-delchat-row');
      var cancel = el('button', 'btn ghost', 'Cancel');
      cancel.type = 'button';
      var del = el('button', 'btn danger', leave ? 'Leave' : 'Delete');
      del.type = 'button';
      row.appendChild(cancel); row.appendChild(del);
      inner.appendChild(h); inner.appendChild(p1); inner.appendChild(row);
      sheet.appendChild(inner);
      document.body.appendChild(sheet);
      function close(v) { sheet.remove(); resolve(v); }
      cancel.addEventListener('click', function () { close(false); });
      del.addEventListener('click', function () { close(true); reallyDelete(chatId, mode); });
      sheet.addEventListener('click', function (ev) { if (ev.target === sheet) close(false); });
    });
  }

  function reallyDelete(chatId, mode) {
    fetch('api/chats/' + encodeURIComponent(chatId) + '/delete', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token() ? { Authorization: 'Bearer ' + token() } : {}),
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out && out.ok === false) throw new Error(out.error || 'failed');
      toast(mode === 'leave' ? 'You left the group' : 'Chat deleted');
      var back = document.getElementById('back-btn');
      if (back) back.click();
      // Refresh the list in place (Phase 2): no full-page flash. Reload is only the
      // fallback if the live refresh hook isn't present.
      if (typeof window.XCReloadChats === 'function') window.XCReloadChats();
      else setTimeout(function () { location.reload(); }, 500);
    }).catch(function () { toast('Could not delete the chat', 'error'); });
  }

  function chatMenuButton() {
    var head = document.querySelector('#chatpane .pane-head');
    if (!head) return;
    if (U.activeChatId && U.activeChatId() != null) {
      if (document.getElementById('jc-chat-menu-btn')) return;
      var b = el('button', 'icon-btn');
      b.type = 'button'; b.id = 'jc-chat-menu-btn'; b.title = 'Chat menu';
      b.setAttribute('aria-label', 'Chat menu');
      b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor"/></svg>';
      b.addEventListener('click', function (ev) { ev.preventDefault(); openChatMenu(); });
      head.appendChild(b);
    } else {
      var old = document.getElementById('jc-chat-menu-btn');
      if (old) old.remove();
    }
  }

  /* ---- groups: add members by typing usernames (never yourself) ---------- */

  var typedNames = [];

  function newGroupHelper() {
    var modal = document.getElementById('modal');
    var title = document.getElementById('modal-title');
    var body = document.getElementById('modal-body');
    if (!modal || modal.hidden || !body || !title) return;
    if (!/new group/i.test(title.textContent || '')) { typedNames = []; return; }
    if (body.querySelector('#jc-typed')) return;

    var wrap = el('div', 'jc-typed');
    wrap.id = 'jc-typed';
    var input = el('input', 'modal-input');
    input.id = 'jc-usernames';
    input.type = 'text';
    input.placeholder = 'Or type usernames, separated by commas';
    var row = el('div', 'jc-typed-row');
    var add = el('button', 'btn', 'Add');
    add.type = 'button';
    var chips = el('div', 'chip-row');
    chips.id = 'jc-typed-chips';
    row.appendChild(input);
    row.appendChild(add);
    wrap.appendChild(row);
    // owner choice: keep the member list private
    var hideWrap = el('label', 'jc-hide-row');
    var hideCb = document.createElement('input');
    hideCb.type = 'checkbox';
    hideCb.id = 'jc-hide-members';
    hideWrap.appendChild(hideCb);
    hideWrap.appendChild(el('span', '', 'Hide the members list from the other members'));
    wrap.appendChild(hideWrap);
    wrap.appendChild(chips);
    body.appendChild(wrap);

    function paint() {
      chips.textContent = '';
      typedNames.forEach(function (n) { chips.appendChild(el('span', 'chip', n)); });
    }
    function addTyped(text) {
      String(text || '').split(/[\s,;]+/).filter(Boolean).forEach(function (raw) {
        var v = raw.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(v)) { toast('“' + raw + '” is not a valid username', 'error'); return; }
        if (typedNames.indexOf(v) === -1) typedNames.push(v);
      });
      paint();
    }
    add.addEventListener('click', function () { addTyped(input.value); input.value = ''; });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); addTyped(input.value); input.value = ''; }
    });

    // Create group: when usernames were typed, we create it ourselves
    body.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!b || !typedNames.length) return;
      if (!/create group|create/i.test(b.textContent || '')) return;
      ev.preventDefault();
      ev.stopPropagation();
      var nameInput = body.querySelector('.modal-input');
      var groupName = nameInput ? nameInput.value.trim() : '';
      b.disabled = true;
      fetch('api/chats', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, token() ? { Authorization: 'Bearer ' + token() } : {}),
        body: JSON.stringify({ title: groupName || 'Group', usernames: typedNames, hideMembers: !!(document.getElementById('jc-hide-members') || {}).checked }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r && r.error) { b.disabled = false; toast(r.error.message || 'Could not create the group', 'error'); return; }
        if (r && r.missing && r.missing.length) toast('Not found: ' + r.missing.join(', '), 'error');
        typedNames = [];
        modal.hidden = true;
        toast('Group created — the members were notified');
        var newId = r && (r.chat ? r.chat.id : r.id);
        setTimeout(function () {
          if (newId) { location.reload(); }
        }, 500);
        if (newId && r && r.chat && r.chat.kind === 'group') {
          // the new group already has its own link — show it while the moment is fresh
          setTimeout(function () { try { window.XCInviteLink(newId); } catch (e) { /* ignore */ } }, 1600);
        }
      }).catch(function () { b.disabled = false; toast('Could not create the group', 'error'); });
    }, true);
  }

  /* ---- "you were added to a group", "chat deleted" ---------------------- */

  var noticesHooked = false;
  function hookNotices() {
    var N = window.Net;
    if (noticesHooked || !N || !N.on) return;
    noticesHooked = true;
    N.on('chat.added', function (f) {
      var who = (f.addedBy && (f.addedBy.displayName || f.addedBy.username)) || 'Someone';
      toast(who + ' added you to “' + ((f.chat && f.chat.title) || f.title || 'a group') + '”');
      if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try { new Notification('Added to a group', { body: who + ' added you to ' + ((f.chat && f.chat.title) || 'a group'), icon: 'icon-192.png' }); } catch (e) {}
      }
    });
    N.on('chat.gone', function () { setTimeout(function () { location.reload(); }, 300); });
    // A call that rang out: say so in the app too (the phone gets a notification).
    N.on('call.missed', function (f) {
      toast('Missed ' + (f && f.kind === 'audio' ? 'voice' : 'video') + ' call' +
            (f && f.fromName ? ' from ' + f.fromName : ''));
    });
    // "a new version is out" — everyone's business, so tell them straight away
    N.on('notice', function (f) {
      var n = f.notice || f;
      toast(n.title || 'A new version of XCaller is available');
      if (String(n.kind || '') === 'update') { FORCE_UPDATE = true; try { checkUpdate(); } catch (e) {} }
    });
  }

  /** Mark edited messages the way Telegram does. */
  function decorateEdited() {
    $$('.msg.out, .msg.in').forEach(function (row) {
      var m = row.__jcMsg;
      if (!m || !m.editedAt) return;
      var meta = row.querySelector('.msg-meta');
      if (!meta || meta.querySelector('.jc-edited')) return;
      var tag = el('span', 'jc-edited', 'edited');
      meta.insertBefore(tag, meta.firstChild);
    });
  }

  /* ------------------------------------------------------------ forwarding -- */

  /** Pick chats (or type usernames) and forward a message + its attachment. */
  window.XCForward = function (messageId) {
    var id = Number(messageId);
    if (!id) return;
    var chosen = {};
    var typed = [];

    var old = document.getElementById('jc-fwd');
    if (old) old.remove();
    var sheet = el('div', 'jc-fwd');
    sheet.id = 'jc-fwd';
    var card = el('div', 'jc-fwd-card');
    sheet.appendChild(card);
    var head = el('div', 'jc-fwd-head');
    head.appendChild(el('div', 'jc-fwd-title', 'Forward to…'));
    var x = el('button', 'icon-btn', '✕');
    x.type = 'button';
    x.addEventListener('click', function () { sheet.remove(); });
    head.appendChild(x);
    card.appendChild(head);

    var nameBox = el('input', 'modal-input');
    nameBox.placeholder = 'Search a chat, or type usernames (a, b)';
    nameBox.type = 'text';
    card.appendChild(nameBox);
    var list = el('div', 'jc-fwd-list');
    card.appendChild(list);
    var go = el('button', 'btn primary', 'Forward');
    go.type = 'button';
    card.appendChild(go);

    function row(chat) {
      var r = el('label', 'jc-fwd-row');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!chosen[chat.id];
      cb.addEventListener('change', function () {
        if (cb.checked) chosen[chat.id] = true; else delete chosen[chat.id];
      });
      r.appendChild(cb);
      var name = chat.kind === 'group'
        ? (chat.title || 'Group') + ' · ' + (chat.memberCount || (chat.members || []).length) + ' members'
        : (function () {
          var other = (chat.members || []).filter(function (m) { return !U.me || String(m.id) !== String(U.me.id); })[0];
          return other ? (other.displayName || other.username) : 'Chat';
        })();
      r.appendChild(el('span', 'jc-fwd-name', name));
      r.addEventListener('click', function (ev) {
        if (ev.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
      });
      return r;
    }

    function paintChats(filter) {
      var box = list;
      box.textContent = '';
      apiGet('api/chats', token()).then(function (r) {
        var chats = ((r && r.chats) || []).filter(function (c) {
          if (!filter) return true;
          var hay = (c.title || '') + ' ' + (c.members || []).map(function (m) { return m.username + ' ' + (m.displayName || ''); }).join(' ');
          return hay.toLowerCase().indexOf(filter) >= 0;
        });
        box.textContent = '';
        if (!chats.length) box.appendChild(el('div', 'empty', 'No chats match. Type a username below and press Add.'));
        chats.forEach(function (c) { box.appendChild(row(c)); });
        paintTyped();
      }).catch(function () {
        box.textContent = '';
        box.appendChild(el('div', 'empty', 'Could not load your chats.'));
      });
    }

    var chipRow = el('div', 'chip-row');
    card.appendChild(chipRow);
    var addName = el('button', 'btn', 'Add username');
    addName.type = 'button';
    addName.addEventListener('click', function () {
      String(nameBox.value || '').split(/[\s,;]+/).filter(Boolean).forEach(function (n) {
        var v = n.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(v)) { toast('“' + n + '” is not a valid username', 'error'); return; }
        if (typed.indexOf(v) === -1) typed.push(v);
      });
      nameBox.value = '';
      paintTyped();
    });
    card.appendChild(addName);

    function paintTyped() {
      chipRow.textContent = '';
      typed.forEach(function (n) { chipRow.appendChild(el('span', 'chip', n)); });
    }

    nameBox.addEventListener('input', function () {
      var v = nameBox.value.trim().toLowerCase();
      if (v.indexOf(',') >= 0 || v.indexOf(' ') >= 0) return;    // that is a username list
      paintChats(v);
    });

    go.addEventListener('click', function () {
      var chatIds = Object.keys(chosen).map(Number);
      if (!chatIds.length && !typed.length) { toast('Pick a chat or add a username'); return; }
      go.disabled = true;
      fetch('api/messages/' + id + '/forward', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token() || '') }),
        body: JSON.stringify({ chatIds: chatIds, usernames: typed }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r && r.error) { go.disabled = false; toast(r.error.message || 'Could not forward', 'error'); return; }
        sheet.remove();
        toast('Forwarded to ' + (r.forwarded || 0) + (r.forwarded === 1 ? ' chat' : ' chats') + (r.missing && r.missing.length ? ' · not found: ' + r.missing.join(', ') : ''));
      }).catch(function () { go.disabled = false; toast('Could not forward', 'error'); });
    });

    document.body.appendChild(sheet);
    paintChats('');
  };

  /** "Forwarded from X" label on forwarded messages. */
  function decorateForwarded() {
    $$('.msg').forEach(function (rowEl) {
      var m = rowEl.__jcMsg;
      if (!m || !m.forwardedFrom) return;
      var body = rowEl.querySelector('.bubble');
      if (!body || body.querySelector('.jc-fwd-tag')) return;
      var tag = el('div', 'jc-fwd-tag', 'Forwarded from ' + m.forwardedFrom);
      body.insertBefore(tag, body.firstChild);
    });
  }

  /* ------------------------------------------------- group owner controls -- */

  function openMembersPanel(chatId) {
    var chat = null;
    var old = document.getElementById('jc-members');
    if (old) old.remove();
    var sheet = el('div', 'jc-menu');
    sheet.id = 'jc-members';
    var inner = el('div', 'jc-menu-inner');
    sheet.appendChild(inner);
    sheet.addEventListener('click', function (ev) { if (ev.target === sheet) sheet.remove(); });
    inner.appendChild(el('div', 'jc-panel-title', 'Members'));

    var listBox = el('div', 'jc-member-list');
    inner.appendChild(listBox);

    // add by username (owner only)
    var addRow = el('div', 'jc-typed-row');
    var addInput = el('input', 'modal-input');
    addInput.placeholder = 'Add by username (a, b)';
    var addBtn = el('button', 'btn', 'Add');
    addBtn.type = 'button';
    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    inner.appendChild(addRow);

    var hideBtn = el('button', 'jc-menu-item', 'Hide the member list from members');
    hideBtn.type = 'button';
    inner.appendChild(hideBtn);

    apiGet('api/chats', token()).then(function (r) {
      chat = ((r && r.chats) || []).find(function (c) { return String(c.id) === String(chatId); });
      var owner = chat && String(chat.ownerId) === String(U.me && U.me.id);
      var mine = (chat && chat.members) || [];
      listBox.textContent = '';
      mine.forEach(function (m) {
        var rowm = el('div', 'jc-member-row');
        rowm.appendChild(el('span', 'jc-fwd-name', (m.displayName || m.username) + (String(m.id) === String(chat.ownerId) ? ' · owner' : '')));
        if (owner && String(m.id) !== String(U.me.id)) {
          var rm = el('button', 'jc-member-x', 'Remove');
          rm.type = 'button';
          rm.addEventListener('click', function () { removeMember(chatId, m.id, m.username); });
          rowm.appendChild(rm);
        }
        listBox.appendChild(rowm);
      });
      if (chat && chat.hideMembers) hideBtn.textContent = 'Show the member list to members again';
      if (!owner) {
        addRow.style.display = 'none';
        hideBtn.style.display = 'none';
      }
    });

    addBtn.addEventListener('click', function () {
      var names = String(addInput.value || '').trim();
      if (!names) return;
      fetch('api/chats/' + chatId + '/members', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token() || '') }),
        body: JSON.stringify({ usernames: names }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r && r.error) { toast(r.error.message || 'Could not add', 'error'); return; }
        toast('Added ' + (r.added || 0) + (r.missing && r.missing.length ? ' · not found: ' + r.missing.join(', ') : ''));
        addInput.value = '';
        sheet.remove();
        openMembersPanel(chatId);
      }).catch(function () { toast('Could not add that person', 'error'); });
    });

    hideBtn.addEventListener('click', function () {
      var hide = !/again/i.test(hideBtn.textContent);
      fetch('api/chats/' + chatId + '/settings', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token() || '') }),
        body: JSON.stringify({ hideMembers: hide }),
      }).then(function (r) { return r.json(); }).then(function () {
        toast(hide ? 'Members list hidden' : 'Members list visible again');
        sheet.remove();
      }).catch(function () { toast('Could not change that setting', 'error'); });
    });

    document.body.appendChild(sheet);
  }

  function removeMember(chatId, userId, username) {
    return XCConfirm('Remove ' + username + ' from this group?', { ok: 'Remove', danger: true }).then(function (ok) { if (ok) reallyRemoveMember(chatId, userId, username); });
  }

  function reallyRemoveMember(chatId, userId, username) {
    fetch('api/chats/' + chatId + '/members/' + userId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + (token() || '') },
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.error) { toast(r.error.message || 'Could not remove', 'error'); return; }
      toast(username + ' was removed');
      var sheet = document.getElementById('jc-members');
      if (sheet) sheet.remove();
      openMembersPanel(chatId);
    }).catch(function () { toast('Could not remove that person', 'error'); });
  }

  /* ------------------------------------------------- modern confirmation ---- */

  /**
   * A proper in-app confirmation instead of the ancient Android/browser box.
   * Usage: XCConfirm('Delete this chat?', { ok: 'Delete', danger: true }).then(ok => …)
   */
  window.XCConfirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var old = document.getElementById('xc-confirm');
      if (old) old.remove();
      var scrim = el('div', 'xc-confirm');
      scrim.id = 'xc-confirm';
      var card = el('div', 'xc-confirm-card');
      if (opts.title) card.appendChild(el('div', 'xc-confirm-title', opts.title));
      card.appendChild(el('div', 'xc-confirm-text', message));
      var row = el('div', 'xc-confirm-actions');
      var no = el('button', 'xc-btn ghost', opts.cancel || 'Cancel');
      no.type = 'button';
      var yes = el('button', 'xc-btn ' + (opts.danger ? 'danger' : 'primary'), opts.ok || 'Yes');
      yes.type = 'button';
      row.appendChild(no);
      row.appendChild(yes);
      card.appendChild(row);
      scrim.appendChild(card);
      var done = function (v) { scrim.remove(); resolve(v); };
      no.addEventListener('click', function () { done(false); });
      yes.addEventListener('click', function () { done(true); });
      scrim.addEventListener('click', function (ev) { if (ev.target === scrim) done(false); });
      document.addEventListener('keydown', function esc(ev) {
        if (!document.getElementById('xc-confirm')) { document.removeEventListener('keydown', esc); return; }
        if (ev.key === 'Escape') { document.removeEventListener('keydown', esc); done(false); }
        if (ev.key === 'Enter') { document.removeEventListener('keydown', esc); done(true); }
      });
      document.body.appendChild(scrim);
      setTimeout(function () { try { yes.focus(); } catch (e) {} }, 30);
    });
  };

  /* ------------------------------------------------------- incoming ring ---- */

  /**
   * Rings for an incoming call: sound, vibration, a notification, and (in the
   * Android app) a native ringing screen so it also rings when the app is not
   * in the foreground.
   */
  var RING = { ctx: null, timer: null, vib: null, notif: null, on: false };

  function ringTone() {
    if (!RING.ctx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try { RING.ctx = new Ctx(); } catch (e) { return null; }
    }
    return RING.ctx;
  }

  /** Two short beeps, then a pause — repeated, the way a ringtone sounds. */
  function ringBeep() {
    var ctx = ringTone();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var t0 = ctx.currentTime;
    [0, 0.5].forEach(function (offset, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 950 : 1180;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.28, t0 + offset + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.42);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.45);
    });
  }

  window.XCRing = {
    start: function (call) {
      if (RING.on) return;
      RING.on = true;
      call = call || {};
      var from = call.from || {};
      var who = from.displayName || from.username || 'Someone';
      var kind = call.kind === 'video' ? 'Video call' : 'Voice call';
      try { ringBeep(); } catch (e) {}
      RING.timer = setInterval(function () { try { ringBeep(); } catch (e) {} }, 2200);
      // vibrate in a loop while it rings
      if (navigator.vibrate) {
        var buzz = function () { try { navigator.vibrate([700, 400, 700, 400]); } catch (e) {} };
        buzz();
        RING.vib = setInterval(buzz, 2300);
      }
      // native ringer (Android app): works even when the app is in the background
      try {
        if (window.XCApp && XCApp.ringCall) XCApp.ringCall(String(call.callId || ''), who, call.kind || 'audio');
      } catch (e) {}
      // and a system notification when the page is not visible
      if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          RING.notif = new Notification(kind + ' from ' + who, {
            body: 'Tap to answer', tag: 'call-' + (call.callId || ''), renotify: true, requireInteraction: true, icon: 'icon-192.png',
          });
          RING.notif.onclick = function () { window.focus(); if (window.Calls) window.Calls.accept(call.callId); };
        } catch (e) {}
      }
    },
    stop: function () {
      if (!RING.on) { return; }
      RING.on = false;
      if (RING.timer) { clearInterval(RING.timer); RING.timer = null; }
      if (RING.vib) { clearInterval(RING.vib); RING.vib = null; }
      if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
      if (RING.notif) { try { RING.notif.close(); } catch (e) {} RING.notif = null; }
      try { if (window.XCApp && XCApp.stopRing) XCApp.stopRing(); } catch (e) {}
    },
    isRinging: function () { return RING.on; },
  };

  /* ------------------------------------------------------------------ loop -- */

  function tick() {
    try { buildComposer(); } catch (e) {}
    try { decorateVoice(); } catch (e) {}
    try { hookNet(); } catch (e) {}
    try { decorateTicks(); } catch (e) {}
    try { callsButton(); } catch (e) {}
    try { watchTransfers(); } catch (e) {}
    try { chatMenuButton(); } catch (e) {}
    try { newGroupHelper(); } catch (e) {}
    try { hookNotices(); } catch (e) {}
    try { decorateEdited(); } catch (e) {}
    try { decorateForwarded(); } catch (e) {}
  }
  setInterval(tick, 800);
  setInterval(function () { try { checkUpdate(); } catch (e) {} }, 20 * 60 * 1000);

  /* -------- shell freshness: converge every open client onto the new UI ------
     A WebView/PWA kept alive in the background can sit on a days-old page —
     that is why devices "don't see any UI changes". The page now compares the
     server's release stamp against the one it was loaded with and reloads
   itself once per release. */
  var SHELL_KEY = 'xc.shell.releasedAt';
  function shellFreshnessCheck() {
    if (!location.pathname.replace(/\/+$/, '').endsWith('/chat') && location.pathname !== '/' &&
        location.pathname.indexOf('/chat/') !== 0 && location.pathname.indexOf('/chat') !== 0) return;
    fetch('api/version').then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !v.releasedAt) return;
      var mine = 0;
      try { mine = Number(localStorage.getItem(SHELL_KEY) || 0); } catch (e) {}
      if (!mine) { try { localStorage.setItem(SHELL_KEY, String(v.releasedAt)); } catch (e) {} return; }
      if (Number(v.releasedAt) > mine) {
        try { localStorage.setItem(SHELL_KEY, String(v.releasedAt)); } catch (e) {}
        location.reload();
      }
    }).catch(function () { /* offline: try again next tick */ });
  }
  setTimeout(shellFreshnessCheck, 15000);
  setInterval(shellFreshnessCheck, 90000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') shellFreshnessCheck();
  });
  setTimeout(function () { try { checkUpdate(); } catch (e) {} }, 4000);
  // Coming back to an open app should surface a new update immediately, not
  // after the 20-minute interval.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') setTimeout(function () { try { checkUpdate(); } catch (e) {} }, 1200);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
})();
