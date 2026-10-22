/**
 * XCaller — the extras layer.
 *
 * Everything here is additive: it attaches to the message list the messenger
 * already renders and adds the features the survey of other open-source clients
 * said people miss most —
 *
 *   👍  emoji reactions            ↩  reply with a quote
 *   ✏  edit your own message       🗑  delete your own message
 *   📋  copy text                  🎤  voice notes (hold the mic)
 *
 * Messages are identified by the data-id the app already puts on every bubble, and
 * live updates arrive on the same WebSocket through window.Net.
 */
(function () {
  'use strict';

  var EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  var state = { menu: null, chips: {}, recorder: null, chunks: [], held: false };

  function UI() { return window.UI || {}; }
  function toast(m, k) { if (UI().toast) UI().toast(m, k); }
  function meId() { return UI().me ? UI().me.id : null; }
  function net() { return window.Net; }
  function messagesBox() { return document.getElementById('messages'); }

  /* ------------------------------------------------------------------- css -- */

  var css = document.createElement('style');
  css.textContent = [
    '.reactions{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}',
    '.reaction{background:rgba(82,136,193,.20);border:1px solid rgba(82,136,193,.35);border-radius:12px;padding:1px 7px;font-size:12.5px;cursor:pointer;color:inherit;line-height:1.5}',
    '.reaction.mine{background:rgba(82,136,193,.45);border-color:#5288c1}',
    '.reply-quote{border-left:3px solid #5288c1;padding:2px 8px;margin-bottom:5px;font-size:12.5px;opacity:.9;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
    '.reply-quote b{opacity:.95}',
    '.msg-menu{position:fixed;z-index:60;background:#1f2b38;border:1px solid #24323f;border-radius:12px;padding:6px;display:flex;flex-direction:column;gap:2px;box-shadow:0 14px 40px rgba(0,0,0,.5);min-width:172px}',
    '.msg-menu .emojis{display:flex;gap:4px;padding:2px 4px 6px;border-bottom:1px solid #24323f;margin-bottom:4px}',
    '.msg-menu .emojis button{font-size:19px;background:none;border:0;padding:2px 5px;border-radius:8px;cursor:pointer}',
    '.msg-menu .emojis button:active{background:rgba(255,255,255,.12)}',
    '.msg-menu .item{background:none;border:0;text-align:left;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:14.5px;color:inherit}',
    '.msg-menu .item:hover{background:rgba(255,255,255,.07)}',
    '.composer-reply{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#1f2b38;border-top:1px solid #24323f;font-size:13px}',
    '.composer-reply .q{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
    '.composer-reply button{background:none;border:0;color:inherit;font-size:17px;cursor:pointer;opacity:.7}',
    '.mic-btn{border:0;background:none;color:inherit;padding:0 6px;cursor:pointer;font-size:19px}',
    '.mic-btn.rec{color:#e05b5b;animation:pulse 1.1s infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '.rec-strip{display:flex;align-items:center;gap:10px;padding:6px 12px;background:#1f2b38;border-top:1px solid #24323f;font-size:13px}',
    'audio.voice{max-width:230px;height:38px;margin-top:4px}',
    '.edited{font-size:11px;opacity:.6;margin-left:5px}',
  ].join('\n');
  document.head.appendChild(css);

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* -------------------------------------------------------------- reactions */

  function rowById(id) {
    var box = messagesBox();
    if (!box) return null;
    return box.querySelector('.msg[data-id="' + String(id) + '"]');
  }

  function paintReactions(messageId, reactions) {
    state.chips[messageId] = reactions || [];
    var row = rowById(messageId);
    if (!row) return;
    var bubble = row.querySelector('.bubble') || row;
    var box = bubble.querySelector('.reactions');
    var sig = (reactions || []).map(function (r) { return r.emoji + ':' + r.count; }).join(',');
    if (box && box.dataset.sig === sig) return;                  // nothing changed: do not touch the DOM
    if (!reactions || !reactions.length) { if (box && box.parentNode) box.parentNode.removeChild(box); return; }
    if (!box) { box = el('div', 'reactions'); bubble.appendChild(box); }
    box.dataset.sig = sig;
    box.textContent = '';
    var mine = meId();
    reactions.forEach(function (r) {
      var b = el('button', 'reaction' + ((r.users || []).map(String).indexOf(String(mine)) >= 0 ? ' mine' : ''));
      b.type = 'button';
      b.textContent = r.emoji + (r.count > 1 ? ' ' + r.count : '');
      b.title = (r.users || []).length + ' reaction' + ((r.users || []).length === 1 ? '' : 's');
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = (r.users || []).map(String).indexOf(String(mine)) < 0;
        net().send({ t: 'msg.react', messageId: Number(messageId), emoji: r.emoji, on: on });
      });
      box.appendChild(b);
    });
  }

  /** Tags in a sender avatar menu, and gives the mic its own gesture handlers. */
  function decorate() {
    var box = messagesBox();
    if (!box) return;

    // voice notes: turn the file link into a player
    box.querySelectorAll('.msg').forEach(function (row) {
      var link = row.querySelector('a.att-file');
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (!/\.(mp3|m4a|ogg|oga|wav|webm|aac)(\?|$)/i.test(href)) return;
      if (row.querySelector('audio.voice')) return;
      var audio = document.createElement('audio');
      audio.className = 'voice';
      // no native controls: ui2 turns every <audio> into the round play-button
      // player. With controls here too, the bubble showed TWO play bars stacked.
      audio.preload = 'metadata';
      audio.src = href;
      link.parentNode.replaceChild(audio, link);
    });

    // audio that arrived as a "voice" kind but was rendered as a plain file
    box.querySelectorAll('.msg[data-id]').forEach(function (row) {
      if (row.__jcBound) return;
      row.__jcBound = true;
      bindGestures(row);
    });
  }

  function bindGestures(row) {
    var pressTimer = null;
    var longPressed = false;

    var start = function () {
      longPressed = false;
      pressTimer = setTimeout(function () {
        longPressed = true;
        openMenu(row);
      }, 480);
    };
    var cancel = function () { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

    row.addEventListener('touchstart', start, { passive: true });
    row.addEventListener('touchend', cancel);
    row.addEventListener('touchmove', cancel, { passive: true });
    row.addEventListener('mousedown', start);
    row.addEventListener('mouseup', cancel);
    row.addEventListener('mouseleave', cancel);
    row.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      toggleQuickReaction(row);
    });
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      cancel();
      openMenu(row);
    });
  }

  function toggleQuickReaction(row) {
    var id = row.dataset.id;
    if (!id) return;
    var current = state.chips[id] || [];
    var mine = String(meId());
    var hit = current.filter(function (r) { return (r.users || []).map(String).indexOf(mine) >= 0; })[0];
    if (hit) net().send({ t: 'msg.react', messageId: Number(id), emoji: hit.emoji, on: false });
    else net().send({ t: 'msg.react', messageId: Number(id), emoji: '👍', on: true });
  }

  /* ------------------------------------------------------------------- menu */

  function closeMenu() {
    if (state.menu && state.menu.parentNode) state.menu.parentNode.removeChild(state.menu);
    state.menu = null;
  }

  function openMenu(row) {
    closeMenu();
    var id = Number(row.dataset.id);
    if (!id) return;
    var mine = row.dataset.mine === '1';
    var menu = el('div', 'msg-menu');

    var emojiRow = el('div', 'emojis');
    EMOJI.forEach(function (e) {
      var b = el('button', null, e);
      b.type = 'button';
      b.addEventListener('click', function () {
        net().send({ t: 'msg.react', messageId: id, emoji: e, on: true });
        closeMenu();
      });
      emojiRow.appendChild(b);
    });
    menu.appendChild(emojiRow);

    function item(label, fn) {
      var b = el('button', 'item', label);
      b.type = 'button';
      b.addEventListener('click', function () { closeMenu(); fn(); });
      menu.appendChild(b);
    }
    item('↩  Reply', function () { startReply(id, row); });
    item('➡  Forward', function () { if (window.XCForward) window.XCForward(id); else toast('Forwarding is not available yet'); });
    if (mine) item('✏  Edit', function () { editMessage(id, row); });
    if (mine) item('🗑  Delete', function () { deleteMessage(id); });
    var text = row.querySelector('.msg-body');
    if (text && text.textContent) {
      item('📋  Copy', function () {
        var t = text.textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('Copied'); }, function () { toast('Copy failed', 'error'); });
        else toast('Copy is not available in this browser', 'error');
      });
    }

    document.body.appendChild(menu);
    var rect = row.getBoundingClientRect();
    var top = Math.min(rect.bottom - 6, window.innerHeight - menu.offsetHeight - 12);
    var left = Math.min(Math.max(8, rect.left + 12), window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.left = left + 'px';
    state.menu = menu;
  }

  document.addEventListener('click', function (ev) {
    if (state.menu && !state.menu.contains(ev.target)) closeMenu();
  }, true);
  document.addEventListener('scroll', closeMenu, true);

  /* ------------------------------------------------------------------ reply */

  function startReply(id, row) {
    var body = row.querySelector('.msg-body');
    var senderEl = row.querySelector('.sender');
    var titleEl = document.getElementById('chat-title');
    var sender = row.dataset.mine === '1' ? 'You'
      : (senderEl ? senderEl.textContent : (titleEl ? titleEl.textContent : 'them'));
    window.JarvisReply = { id: id, sender: sender, body: body ? body.textContent.slice(0, 120) : '' };
    paintReplyStrip();
    var input = document.getElementById('composer-input');
    if (input) input.focus();
  }

  window.JarvisClearReply = function () {
    window.JarvisReply = null;
    paintReplyStrip();
  };

  function paintReplyStrip() {
    var composer = document.getElementById('composer');
    if (!composer) return;
    var strip = document.getElementById('jc-reply-strip');
    if (!window.JarvisReply) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = el('div', 'composer-reply');
      strip.id = 'jc-reply-strip';
      composer.parentNode.insertBefore(strip, composer);
    }
    strip.textContent = '';
    strip.appendChild(el('span', 'q', '↩ ' + window.JarvisReply.sender + ': ' + window.JarvisReply.body));
    var x = el('button', null, '✕');
    x.type = 'button';
    x.addEventListener('click', window.JarvisClearReply);
    strip.appendChild(x);
  }

  /** Draws the quote block at the top of a bubble when a message replies to another. */
  function paintQuote(row, msg) {
    var bubble = row.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.reply-quote')) return;
    var q = msg.quote || null;
    if (!q) return;
    var box = el('div', 'reply-quote');
    var b = el('b', null, (String(q.id) === String(meId()) ? 'You' : (q.senderName || q.sender || '')) + ': ');
    box.appendChild(b);
    box.appendChild(document.createTextNode(q.body || ''));
    box.addEventListener('click', function () {
      var target = rowById(q.id);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.style.transition = 'background .6s'; target.style.background = 'rgba(82,136,193,.22)'; setTimeout(function () { target.style.background = ''; }, 900); }
    });
    bubble.insertBefore(box, bubble.firstChild);
  }

  /* ------------------------------------------------------------ edit/delete */

  /* ---- inline edit: WhatsApp-style — prefill composer, bar shows context, send = save ---- */
  var EDIT = { active: false, id: null, orig: '' };

  function editBar() {
    var bar = document.getElementById('jc-editbar');
    if (bar) return bar;
    var composer = document.getElementById('composer');
    bar = el('div', 'editbar');
    bar.id = 'jc-editbar';
    bar.innerHTML = '<div class="editbar-main">' +
      '<div class="editbar-label">\u270E Editing message</div>' +
      '<div class="editbar-orig"></div></div>' +
      '<button type="button" class="editbar-x" aria-label="Cancel editing">\u2715</button>';
    bar.querySelector('.editbar-x').addEventListener('click', cancelEdit);
    composer.parentNode.insertBefore(bar, composer);
    return bar;
  }

  function enterEditMode(id, current) {
    cancelEdit();
    EDIT.active = true; EDIT.id = id; EDIT.orig = current;
    var input = document.getElementById('composer-input');
    var bar = editBar();
    bar.querySelector('.editbar-orig').textContent = current;
    input.value = current;
    input.focus();
    var L = input.value.length;
    try { input.setSelectionRange(L, L); } catch (e) {}
    var mic = document.getElementById('jc-mic');
    if (mic) mic.style.display = 'none';                 // recording while editing: no
    if (window.autoGrow) window.autoGrow(input);
  }

  function cancelEdit() {
    EDIT.active = false; EDIT.id = null; EDIT.orig = '';
    var bar = document.getElementById('jc-editbar');
    if (bar) bar.remove();
    var input = document.getElementById('composer-input');
    if (input && !input.value) {
      var mic = document.getElementById('jc-mic');
      if (mic) mic.style.display = '';
    }
  }

  /** Called by the composer's sendMessage() BEFORE a normal send. Returns true if consumed. */
  function submitEdit() {
    if (!EDIT.active) return false;
    var input = document.getElementById('composer-input');
    var next = (input.value || '').trim();
    input.value = '';
    if (window.autoGrow) window.autoGrow(input);
    if (!next) { toast('Message cannot be empty', 'error'); return true; }   // keep editor open
    if (next !== EDIT.orig) net().send({ t: 'msg.edit', messageId: EDIT.id, body: next });
    cancelEdit();
    return true;
  }
  window.JCEdit = { submit: submitEdit, cancel: cancelEdit };

  function editMessage(id, row) {
    var body = row.querySelector('.msg-body');
    var current = body ? body.textContent : '';
    if (!current) return;
    enterEditMode(id, current);
  }

  async function deleteMessage(id) {
    if (!(await XCConfirm('Delete this message for everyone?', { ok: 'Delete', danger: true }))) return;
    net().send({ t: 'msg.delete', messageId: id });
  }

  /* -------------------------------------------------------------- live feed */

  function wire() {
    var n = net();
    if (!n || !n.on) { setTimeout(wire, 400); return; }

    n.on('msg.reaction', function (f) { paintReactions(f.messageId, f.reactions); });

    n.on('msg.edited', function (f) {
      var msg = f.message || {};
      var row = rowById(msg.id);
      if (!row) return;
      var body = row.querySelector('.msg-body');
      if (body) body.textContent = msg.body || '';
      var bubble = row.querySelector('.bubble');
      if (bubble && !bubble.querySelector('.edited')) bubble.appendChild(el('span', 'edited', 'edited'));
    });

    n.on('msg.deleted', function (f) {
      var row = rowById(f.messageId);
      if (!row) return;
      var bubble = row.querySelector('.bubble');
      if (!bubble) return;
      bubble.textContent = '';
      bubble.appendChild(el('div', 'msg-body', 'This message was deleted'));
      row.classList.add('deleted');
    });

    // messages that arrive with a quote, or with reactions already on them
    n.on('msg.new', function () { scheduleDecorate(60); });
    n.on('msg.ack', function () { scheduleDecorate(80); });
  }
  wire();

  /* ----------------------------------------------------- watch the DOM ----- */

  /**
   * Decorating touches the DOM, which the observer would otherwise see as a new
   * change — so it is paused while decorating and de-duplicated in between.
   * (Without this the observer feeds itself and the page never settles.)
   */
  var observer = new MutationObserver(function () { scheduleDecorate(80); });
  var pendingDecorate = null, decorating = false;

  function scheduleDecorate(delay) {
    if (pendingDecorate) clearTimeout(pendingDecorate);
    pendingDecorate = setTimeout(function () { pendingDecorate = null; safeDecorate(); }, delay || 80);
  }

  function safeDecorate() {
    if (decorating) { scheduleDecorate(150); return; }
    decorating = true;
    try { observer.disconnect(); } catch (e) {}
    try {
      decorate();
      var box = messagesBox();
      if (box) {
        box.querySelectorAll('.msg[data-id]').forEach(function (row) {
          var id = row.dataset.id;
          var m = row.__jcMsg;
          if (m && m.reactions && m.reactions.length) state.chips[id] = m.reactions;   // reactions that came with the message
          if (state.chips[id]) paintReactions(id, state.chips[id]);
        });
      }
    } catch (e) { /* a decoration failure must never break the messenger */ }
    try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    decorating = false;
  }

  observer.observe(document.body, { childList: true, subtree: true });
  scheduleDecorate(300);

  /* ---------------------------------------------------------- voice notes -- */

  function micButton() {
    var composer = document.getElementById('composer');
    if (!composer) return null;
    if (document.getElementById('jc-mic')) return document.getElementById('jc-mic');
    var b = el('button', 'mic-btn', '🎤');
    b.type = 'button';
    b.id = 'jc-mic';
    b.title = 'Hold to record a voice note';
    composer.appendChild(b);
    return b;
  }

  /* ---- recording state ---- */
  var R = { stream: null, rec: null, chunks: [], t0: 0, timer: null, ac: null, an: null, tick: null,
            blob: null, level: 0, cancelled: false, sending: false };

  function fmtT(ms) {
    var t = Math.floor(ms / 1000);
    return (t < 600 ? '' : Math.floor(t / 60) + ':') + String(Math.floor((t % 600) / 60)).padStart(2, '0') === '' ? '' : '';
  }
  function fmtDur(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(t / 60), sec = t % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function recStrip() { return document.getElementById('jc-rec'); }

  function buildStrip() {
    var composer = document.getElementById('composer');
    if (!composer || recStrip()) return null;
    var strip = el('div', 'rec-strip');
    strip.id = 'jc-rec';
    strip.innerHTML =
      '<button type="button" class="rec-cancel" aria-label="Cancel recording">\u2715</button>' +
      '<span class="rec-dot" aria-hidden="true"></span>' +
      '<span class="rec-timer" role="timer">00:00</span>' +
      '<canvas class="rec-wave" height="34" aria-hidden="true"></canvas>' +
      '<span class="rec-hint">Release for preview</span>';
    strip.querySelector('.rec-cancel').addEventListener('click', function (e2) {
      e2.stopPropagation(); cancelRecording();
    });
    composer.parentNode.insertBefore(strip, composer);
    var mic = document.getElementById('jc-mic');
    if (mic) mic.classList.add('rec');
    return strip;
  }

  function drawWave() {
    var c = document.querySelector('#jc-rec .rec-wave');
    if (!c || !R.an) return;
    var ctx = c.getContext('2d');
    var w = c.width = c.offsetWidth * (window.devicePixelRatio || 1) || c.width;
    var h = c.height;
    var data = new Uint8Array(R.an.frequencyBinCount);
    R.an.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#e25c5c';
    var bar = Math.max(2, Math.floor(w / 48));
    var step = Math.floor(data.length / 48) || 1;
    for (var i = 0; i < 48; i++) {
      var v = Math.abs(data[i * step] - 128) / 128;      // 0..1 real amplitude
      var bh = Math.max(2, v * (h - 4));
      ctx.fillRect(i * bar, (h - bh) / 2, bar - 1, bh);
    }
    R.tick = requestAnimationFrame(drawWave);
  }

  function startRecording() {
    if (R.rec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording is not supported here', 'error'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (R.cancelled) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      var rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      R.stream = stream; R.rec = rec; R.chunks = []; R.cancelled = false;
      rec.ondataavailable = function (e2) { if (e2.data && e2.data.size) R.chunks.push(e2.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stopMeters();
        var blob = new Blob(R.chunks, { type: rec.mimeType || 'audio/webm' });
        R.rec = null; R.stream = null;
        hideRecStrip();
        if (R.cancelled) { R.chunks = []; return; }
        if (blob.size < 800) { toast('Too short \u2014 hold the mic longer', 'error'); return; }
        R.blob = blob;
        showPreview(blob);
      };
      // real capture confirmed only after .start() succeeds:
      rec.start();
      state.held = true;
      R.t0 = Date.now();
      buildStrip();
      try {
        R.ac = new (window.AudioContext || window.webkitAudioContext)();
        R.an = R.ac.createAnalyser(); R.an.fftSize = 256;
        R.ac.createMediaStreamSource(stream).connect(R.an);
      } catch (e3) { R.an = null; }
      drawWave();
      R.timer = setInterval(function () {
        var t = recStrip() && recStrip().querySelector('.rec-timer');
        if (t) t.textContent = fmtDur(Date.now() - R.t0);
        if (Date.now() - R.t0 > 300000) stopRecording();     // hard cap 5 min
      }, 250);
      if (navigator.vibrate) try { navigator.vibrate(15); } catch (e4) {}
    }).catch(function () {
      toast('Microphone permission is needed to record', 'error');
      state.held = false; R.rec = null; R.stream = null;
      hideRecStrip();
    });
  }

  function stopMeters() {
    if (R.timer) { clearInterval(R.timer); R.timer = null; }
    if (R.tick) { cancelAnimationFrame(R.tick); R.tick = null; }
    if (R.ac) { try { R.ac.close(); } catch (e5) {} R.ac = null; R.an = null; }
  }

  function stopRecording() {
    state.held = false;
    if (R.rec && R.rec.state === 'recording') R.rec.stop();
  }

  function cancelRecording() {
    R.cancelled = true;
    stopRecording();
    R.chunks = []; R.blob = null;
    hideRecStrip();
    hidePreview();
    if (navigator.vibrate) try { navigator.vibrate(8); } catch (e6) {}
  }

  function hideRecStrip() {
    var s2 = recStrip();
    if (s2) s2.remove();
    var mic = document.getElementById('jc-mic');
    if (mic) mic.classList.remove('rec');
  }

  /* ---- preview state: play / delete / send (deliberate send) ---- */
  function showPreview(blob) {
    hidePreview();
    var composer = document.getElementById('composer');
    if (!composer) return;
    var pv = el('div', 'voice-preview');
    pv.id = 'jc-voice-preview';
    var au = el('audio');
    au.src = URL.createObjectURL(blob);
    var play = el('button', 'vp-play');
    play.type = 'button'; play.setAttribute('aria-label', 'Play preview');
    play.innerHTML = '\u25B6';
    play.addEventListener('click', function () {
      if (au.paused) { au.play(); play.innerHTML = '\u23F8'; play.setAttribute('aria-label', 'Pause preview'); }
      else { au.pause(); play.innerHTML = '\u25B6'; play.setAttribute('aria-label', 'Play preview'); }
    });
    au.addEventListener('ended', function () { play.innerHTML = '\u25B6'; });
    var info = el('div', 'vp-info');
    info.appendChild(el('div', 'vp-title', 'Voice message'));
    info.appendChild(el('div', 'vp-dur', fmtDur(blob.durationMs || (R.t0 ? Date.now() - R.t0 : 0)) + ' \u00b7 tap play to listen'));
    var del = el('button', 'vp-del');
    del.type = 'button'; del.setAttribute('aria-label', 'Delete recording');
    del.innerHTML = '\ud83d\udff4\ufe0f';
    del.title = 'Delete';
    del.addEventListener('click', cancelRecording);
    var send = el('button', 'vp-send');
    send.type = 'button'; send.textContent = 'Send';
    send.setAttribute('aria-label', 'Send voice message');
    send.addEventListener('click', function () { if (!R.sending) sendVoice(blob); });
    pv.appendChild(play); pv.appendChild(info); pv.appendChild(del); pv.appendChild(send);
    composer.parentNode.insertBefore(pv, composer);
    var mic = document.getElementById('jc-mic');
    if (mic) { mic.classList.add('rec'); }
  }
  function hidePreview() {
    var pv = document.getElementById('jc-voice-preview');
    if (pv) { var a = pv.querySelector('audio'); if (a) { try { a.pause(); URL.revokeObjectURL(a.src); } catch (e7) {} } pv.remove(); }
    var mic = document.getElementById('jc-mic');
    if (mic && !R.rec) mic.classList.remove('rec');
  }

  function sendVoice(blob) {
    if (R.sending) return;
    R.sending = true;
    var sendBtn = document.querySelector('#jc-voice-preview .vp-send');
    if (sendBtn) { sendBtn.textContent = 'Sending\u2026'; sendBtn.disabled = true; }
    var fd = new FormData();
    var ext = (blob.type.indexOf('mp4') >= 0) ? 'm4a' : 'webm';
    fd.append('file', blob, 'voice-note.' + ext);
    var clientId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    fetch('api/upload', { method: 'POST', headers: authHeader(), body: fd })
      .then(function (r) { return r.json(); })
      .then(function (att) {
        if (!att || !att.path) throw new Error('upload failed');
        var chatId = UI().activeChatId ? UI().activeChatId() : null;
        if (!chatId) throw new Error('no chat open');
        return fetch('api/chats/' + encodeURIComponent(chatId) + '/messages', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
          body: JSON.stringify({ body: '', kind: 'voice', clientId: clientId,
            attachment: { path: att.path, name: att.name, mime: att.mime, size: att.size } }),
        }).then(function (r2) { return r2.json(); });
      })
      .then(function () {
        R.blob = null; R.sending = false;
        hidePreview();
        toast('Voice note sent');
      })
      .catch(function (e8) {
        R.sending = false;                                   // blob kept for retry
        if (sendBtn) { sendBtn.textContent = 'Retry'; sendBtn.disabled = false; }
        toast('Voice note failed: ' + e8.message + ' \u2014 tap Retry', 'error');
      });
  }

  function authHeader() {
    var t = null;
    try { t = localStorage.getItem('jarvis.token'); } catch (e) {}
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  // add the mic to the composer whenever it is (re)rendered, and bind its gesture
  setInterval(function () {
    var mic = micButton();
    if (!mic || mic.__jcBound) return;
    mic.__jcBound = true;
    var down = function (ev) { ev.preventDefault(); if (!state.held) startRecording(); };
    var up = function (ev) { ev.preventDefault(); if (state.held) stopRecording(); };
    mic.addEventListener('mousedown', down);
    mic.addEventListener('mouseup', up);
    mic.addEventListener('mouseleave', up);
    mic.addEventListener('touchstart', down, { passive: false });
    mic.addEventListener('touchend', up, { passive: false });
    mic.addEventListener('touchcancel', up, { passive: false });
    mic.addEventListener('click', function (ev) {
      // a plain tap toggles recording, for desktop use
      ev.preventDefault();
      if (state.held) stopRecording(); else startRecording();
    });
  }, 900);

  // expose a tiny surface for testing
  window.JarvisFeatures = {
    react: function (id, emoji) { net().send({ t: 'msg.react', messageId: Number(id), emoji: emoji, on: true }); },
    reply: function (id) { var row = rowById(id); if (row) startReply(Number(id), row); },
    menu: openMenu,
    reactions: function () { return state.chips; },
  };
})();
