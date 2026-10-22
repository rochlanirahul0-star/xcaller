/**
 * XCaller — calls engine (WebRTC).
 *
 * 1:1 calls and conference calls, mesh topology: every participant holds one
 * RTCPeerConnection per other participant, and the server relays SDP/ICE through
 * the single WebSocket the UI owns (window.Net). Nothing here talks to the DOM
 * directly except to hang media onto the tiles the UI already built.
 *
 * Glare rule: for any pair, the participant with the smaller user id makes the
 * offer. Deterministic, so both sides never offer at the same time.
 *
 * Exposes window.Calls = { start, accept, decline, leave, addPeople,
 *                          toggleMute, toggleCamera, toggleScreenShare, state }.
 */
(function () {
  'use strict';

  var FALLBACK_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  var C = {
    callId: null,
    chatId: null,
    kind: 'audio',
    pending: null,        // the ringing call, before accept
    localStream: null,
    cameraTrack: null,    // the real camera track (so we can come back from screen share)
    screenStream: null,
    pcs: {},              // userId → RTCPeerConnection
    remoteStreams: {},    // userId → MediaStream
    iceServers: FALLBACK_ICE,
    muted: false,
    speaker: false,        // false = earpiece, true = loudspeaker (Android only)
    camera: false,
    sharing: false,
    attachTimer: null,
    ringTimeout: null,
    ringing: {},          // callId → the incoming frame, so accept(id) works from the shell
  };

  function UI() { return window.UI || null; }
  function toast(msg, kind) { var u = UI(); if (u && u.toast) u.toast(msg, kind); }
  function meId() { var u = UI(); return u && u.me ? u.me.id : null; }
  function net() { return window.Net || null; }
  function send(frame) { var n = net(); if (n && n.isOpen && n.isOpen()) { n.send(frame); return true; } return false; }

  /* ------------------------------------------------------------- ice servers */

  var iceLoaded = false;
  /** Only ask for TURN credentials when there is a session. Called at boot when
   *  already signed in, and again when a call starts (covers a fresh login). */
  function loadIceServers() {
    if (iceLoaded) return;
    var h = authHeaders();
    if (!h.Authorization) return;
    iceLoaded = true;
    fetch('api/turn-credentials', { headers: h })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.iceServers && j.iceServers.length) C.iceServers = j.iceServers; })
      .catch(function () { iceLoaded = false; /* keep the public STUN fallback */ });
  }
  loadIceServers();

  function authHeaders() {
    try { var t = window.localStorage.getItem('jarvis.token'); return t ? { Authorization: 'Bearer ' + t } : {}; }
    catch (e) { return {}; }
  }

  /* ------------------------------------------------------------------ media */

  /**
   * High quality by design:
   *   video → up to 1080p30, motion hint, encoder told to keep resolution
   *   audio → 48 kHz speech, echo/noise handling, Opus pushed to 128 kbps
   */
  function getMedia(kind) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser cannot use the microphone/camera.'));
    }
    var audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
      latency: 0.01,
    };
    var constraints = kind === 'video'
      ? {
        audio: audio,
        video: {
          facingMode: 'user',
          width: { ideal: 1920, min: 640 },
          height: { ideal: 1080, min: 480 },
          frameRate: { ideal: 30, max: 60 },
          aspectRatio: { ideal: 16 / 9 },
        },
      }
      : { audio: audio, video: false };
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      C.localStream = stream;
      C.cameraTrack = stream.getVideoTracks()[0] || null;
      if (C.cameraTrack) {
        try { C.cameraTrack.contentHint = 'motion'; } catch (e) {}
        C.camera = true;
      }
      var at = stream.getAudioTracks()[0];
      if (at) { try { at.contentHint = 'speech'; } catch (e) {} }
      return stream;
    });
  }

  /** Give the senders the bitrate budget that HD/HQ actually needs. */
  function tuneSenders(pc) {
    if (!pc || !pc.getSenders) return;
    pc.getSenders().forEach(function (sender) {
      if (!sender.track) return;
      try {
        var p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (sender.track.kind === 'video') {
          p.degradationPreference = 'maintain-resolution';
          p.encodings[0].maxBitrate = 5_000_000;       // ~1080p HD on a good link
          p.encodings[0].maxFramerate = 30;
          p.encodings[0].scaleResolutionDownBy = 1;
          if ('networkPriority' in p.encodings[0]) p.encodings[0].networkPriority = 'high';
        } else {
          p.encodings[0].maxBitrate = 128_000;         // Opus, high quality voice
          if ('networkPriority' in p.encodings[0]) p.encodings[0].networkPriority = 'high';
        }
        sender.setParameters(p);
      } catch (e) { /* not all browsers accept every knob */ }
    });
  }

  /**
   * Opus parameters live in the SDP. Ask for full-band stereo-capable 48 kHz audio
   * with in-band FEC, which is what makes a voice call sound like a phone call
   * rather than a walkie-talkie.
   */
  function tuneSdp(desc) {
    if (!desc || !desc.sdp) return desc;
    var sdp = desc.sdp;
    var m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
    if (m) {
      var pt = m[1];
      var wanted = 'maxaveragebitrate=128000;stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0;maxplaybackrate=48000;sprop-maxcapturerate=48000';
      if (new RegExp('a=fmtp:' + pt + ' ').test(sdp)) {
        sdp = sdp.replace(new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)'), 'a=fmtp:' + pt + ' $1;' + wanted);
      } else {
        sdp = sdp.replace(new RegExp('(a=rtpmap:' + pt + ' opus/48000[^\\r\\n]*\\r?\\n)'), '$1a=fmtp:' + pt + ' ' + wanted + '\r\n');
      }
    }
    return { type: desc.type, sdp: sdp };
  }

  function stopStream(s) {
    if (!s) return;
    s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  }

  /* ------------------------------------------------------------------- tiles */

  /** Hang streams on the UI's <video> tiles; tiles can appear later, so poll. */
  function attachStreams() {
    var u = UI();
    if (!u) return;
    var me = meId();
    if (me != null && C.localStream && u.videoFor) {
      var mine = u.videoFor(me);
      if (mine) {
        if (mine.srcObject !== C.localStream) { mine.srcObject = C.localStream; safePlay(mine); }
        mine.classList.toggle('mirror', !C.sharing);   // flipped by CSS; screen share is never flipped
        markTile(mine, screenLive() || (C.localStream.getVideoTracks().length > 0 && C.camera), true);
      }
    }
    Object.keys(C.remoteStreams).forEach(function (id) {
      var stream = C.remoteStreams[id];
      // audio first: a voice call must be audible whether or not a tile exists for the peer
      if (stream) ensureRemoteAudio(id, stream);
      if (!u.videoFor) return;
      var v = u.videoFor(id);
      if (v && stream && v.srcObject !== stream) { v.srcObject = stream; safePlay(v); }
      if (v) {
        var live = stream ? stream.getVideoTracks().some(function (t) { return t.readyState === 'live' && t.enabled; }) : false;
        markTile(v, !!live, false);
      }
    });
  }

  function screenLive() { return !!(C.screenStream && C.screenStream.getVideoTracks().length); }

  /**
   * Remote audio gets its own <audio> element per peer, independent of the video tiles.
   * The tiles are presentation: they get rebuilt, contain no video track on a voice call,
   * and have been styled into nothing at various points in this app's life. If the only
   * place a remote stream is attached is a tile, a voice call can end up with no audible
   * output at all. This element is the guarantee that a call can be heard.
   */
  function ensureRemoteAudio(peerId, stream) {
    if (!stream) return null;
    if (!stream.getAudioTracks || !stream.getAudioTracks().length) return null;
    var id = 'call-audio-' + String(peerId);
    var a = document.getElementById(id);
    if (!a) {
      var host = document.getElementById('call-screen') || document.body;
      a = document.createElement('audio');
      a.id = id;
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      host.appendChild(a);
    }
    if (a.srcObject !== stream) { a.srcObject = stream; safePlay(a); }
    else if (a.paused) safePlay(a);
    return a;
  }

  function dropRemoteAudio(peerId) {
    var a = document.getElementById('call-audio-' + String(peerId));
    if (a) { try { a.srcObject = null; } catch (e) {} if (a.parentNode) a.parentNode.removeChild(a); }
  }

  function dropAllRemoteAudio() {
    Array.prototype.slice.call(document.querySelectorAll('audio[id^="call-audio-"]')).forEach(function (a) {
      try { a.srcObject = null; } catch (e) {}
      if (a.parentNode) a.parentNode.removeChild(a);
    });
  }

  /**
   * Tell the stylesheet what this tile really is: mine (corner preview), and
   * whether it has live video (so the avatar/label get out of the way).
   */
  function markTile(videoEl, hasVideo, isSelf) {
    var tile = videoEl.closest ? videoEl.closest('.call-tile') : null;
    if (!tile) return;
    tile.classList.toggle('has-video', !!hasVideo);
    if (isSelf) tile.classList.add('self'); else tile.classList.remove('self');
    var box = document.getElementById('call-tiles');
    if (box) {                                   // 1-to-1 = one column so the peer fills the stage
      var n = box.querySelectorAll('.call-tile').length;
      box.classList.toggle('duo', n > 0 && n <= 2);
    }
    watchFrames(videoEl, tile);
  }

  /**
   * A video element with a track but no pictures is a black rectangle — that is
   * the ugly "oval and arrow" box. Watch for real frames and fall back to the
   * avatar whenever nothing is arriving.
   *
   * The old 2.5s stale window strobed the avatar over live video on every
   * bandwidth dip (the "shutter" glitch): video decoders pause well past 2.5s
   * during jitter. Now a tile only counts as stale after 7s with no frames AND
   * no decoding activity (totalVideoFrames not moving), so a live call never
   * flickers — only a genuinely dead surface falls back to the avatar.
   */
  function watchFrames(v, tile) {
    if (!v || v.__xcWatching) return;
    v.__xcWatching = true;
    var last = 0;
    var frames = -1;
    if (typeof v.requestVideoFrameCallback === 'function') {
      var step = function () { last = Date.now(); tile.classList.remove('no-frames'); v.requestVideoFrameCallback(step); };
      try { v.requestVideoFrameCallback(step); } catch (e) {}
    }
    setInterval(function () {
      if (!C.callId || !document.body.contains(v)) return;
      var decoded = null;
      try { if (v.getVideoPlaybackQuality) decoded = v.getVideoPlaybackQuality().totalVideoFrames; } catch (e) {}
      var proof = decoded != null ? decoded : ((v.videoWidth > 0 && !v.paused) ? Date.now() : 0);
      if (proof > frames) { frames = proof; last = Date.now(); }
      var stale = !last || (Date.now() - last) > 7000;
      tile.classList.toggle('no-frames', stale);
    }, 1200);
  }
  function startAttachLoop() {
    stopAttachLoop();
    attachStreams();
    C.attachTimer = setInterval(attachStreams, 400);
  }
  function stopAttachLoop() { if (C.attachTimer) { clearInterval(C.attachTimer); C.attachTimer = null; } }
  function safePlay(v) { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }

  /* ------------------------------------------------------------ connections */

  function newPeer(peerId) {
    var pc = new RTCPeerConnection({ iceServers: C.iceServers, iceCandidatePoolSize: 4 });

    if (C.localStream) {
      C.localStream.getTracks().forEach(function (t) {
        try { pc.addTrack(t, C.localStream); } catch (e) {}
      });
    }
    tuneSenders(pc);                                   // HD video / HQ audio budget
    var rs = new MediaStream();
    C.remoteStreams[peerId] = rs;

    pc.onicecandidate = function (e) {
      if (e.candidate) send({ t: 'call.signal', callId: C.callId, to: Number(peerId), data: { candidate: e.candidate } });
    };
    pc.ontrack = function (e) {
      (e.streams[0] ? e.streams[0].getTracks() : [e.track]).forEach(function (t) {
        if (!rs.getTracks().some(function (x) { return x.id === t.id; })) rs.addTrack(t);
      });
      ensureRemoteAudio(peerId, rs);
      attachStreams();
    };
    pc.onconnectionstatechange = function () {
      var ui = UI();
      if (pc.connectionState === 'connected') {
        // media actually flowing (not just signaling): start the clock once
        if (ui && ui.startCallTimer) ui.startCallTimer();
      } else if (pc.connectionState === 'disconnected') {
        if (ui && ui.setCallStatus) ui.setCallStatus('reconnecting');
      } else if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
        if (ui && ui.setCallStatus) ui.setCallStatus('reconnecting');
      }
    };
    C.pcs[peerId] = pc;
    return pc;
  }

  function closePeer(peerId) {
    var pc = C.pcs[peerId];
    if (pc) { try { pc.close(); } catch (e) {} delete C.pcs[peerId]; }
    delete C.remoteStreams[peerId];
    dropRemoteAudio(peerId);
  }
  function closeAllPeers() { Object.keys(C.pcs).forEach(closePeer); C.remoteStreams = {}; dropAllRemoteAudio(); }

  /** I offer when my id is smaller — same rule on both sides, so no glare. */
  function iInitiate(peerId) {
    var me = meId();
    return me != null && String(me) < String(peerId);
  }

  /** Send a fresh offer for one peer (used after adding a track, e.g. camera on). */
  function negotiate(peerId) {
    var pc = C.pcs[peerId];
    if (!pc) return;
    pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: C.kind === 'video' })
      .then(function (offer) { return pc.setLocalDescription(tuneSdp(offer)); })
      .then(function () { send({ t: 'call.signal', callId: C.callId, to: Number(peerId), data: { sdp: pc.localDescription } }); })
      .catch(function (e) { console.warn('[calls] renegotiation failed', e); });
  }

  function callPeer(peerId) {
    if (C.pcs[peerId]) return C.pcs[peerId];
    var pc = newPeer(peerId);
    if (iInitiate(peerId)) {
      pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: C.kind === 'video' })
        .then(function (offer) { return pc.setLocalDescription(tuneSdp(offer)); })
        .then(function () { send({ t: 'call.signal', callId: C.callId, to: Number(peerId), data: { sdp: pc.localDescription } }); })
        .catch(function (e) { toast('Could not reach that person: ' + e.message, 'error'); });
    }
    return pc;
  }

  function handleSignal(frame) {
    var from = Number(frame.from);
    var data = frame.data || {};

    // the other side added a track and I am the one who offers
    if (data.needOffer) {
      if (!C.pcs[from]) callPeer(from); else negotiate(from);
      return;
    }

    var pc = C.pcs[from] || callPeer(from);

    if (data.sdp) {
      var desc = data.sdp;
      pc.setRemoteDescription(new RTCSessionDescription(desc)).then(function () {
        if (desc.type === 'offer') {
          return pc.createAnswer()
            .then(function (a) { return pc.setLocalDescription(tuneSdp(a)); })
            .then(function () { send({ t: 'call.signal', callId: C.callId, to: from, data: { sdp: pc.localDescription } }); });
        }
        return null;
      }).catch(function (e) { console.error('[calls] sdp', e); });
      return;
    }
    if (data.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () { /* late/duplicate ICE is normal */ });
    }
  }

  /* ------------------------------------------------------------------ frames */

  function onFrame(type, handler) { var n = net(); if (n && n.on) n.on(type, handler); }

  // ringing
  onFrame('call.incoming', function (f) {
    C.pending = f;
    C.ringing[f.callId] = f;                                        // so accept(id) works even cold
    if (f.invited && C.callId && C.callId === f.callId) {           // added mid-call
      joinPeerSet(f.participants);
      return;
    }
    if (C.callId) return;                                          // already on a call
    var u = UI();
    if (u && u.showIncoming) u.showIncoming(f);
    if (window.XCRing) window.XCRing.start(f);                      // ringtone + vibration
    if (C.ringTimeout) clearTimeout(C.ringTimeout);
    C.ringTimeout = setTimeout(function () { if (!C.callId && C.pending) { C.pending = null; var uu = UI(); if (uu && uu.hideIncoming) uu.hideIncoming(); if (window.XCRing) window.XCRing.stop(); } }, 60000);
  });

  // "Calling…" while nobody is reachable, "Ringing…" once their phone gets it
  onFrame('call.status', function (f) {
    if (!C.callId || f.callId !== C.callId) return;
    C.statuses = C.statuses || {};
    if (f.userId) C.statuses[f.userId] = f.status;
    var ringing = Object.keys(C.statuses).some(function (k) { return C.statuses[k] === 'ringing'; });
    var u = UI();
    if (u && u.setCallStatus && !C.timerRunning) u.setCallStatus(ringing ? 'ringing' : 'calling');
  });

  onFrame('call.started', function (f) {
    C.callId = f.callId; C.chatId = f.chatId; C.kind = f.kind || C.kind;
    var u = UI();
    if (u && u.openCallScreen) u.openCallScreen({ callId: f.callId, chatId: f.chatId, kind: C.kind, participants: f.participants || [], startedAt: Date.now() });
    if (u && u.setParticipants) u.setParticipants(f.participants && f.participants.length ? f.participants : [{ userId: meId(), username: (u.me || {}).username, displayName: (u.me || {}).displayName }]);
    // nobody has picked up yet: show the calling animation, not a running clock
    if (u && u.setCallRinging) u.setCallRinging(!(f.participants && f.participants.length > 1));
    startAttachLoop();
  });

  onFrame('call.joined', function (f) {
    if (!C.callId || f.callId !== C.callId) return;
    if (window.XCRing) window.XCRing.stop();
    if (f.participants) joinPeerSet(f.participants);
    attachStreams();
    // the moment somebody else is in: stop ringing and start the clock
    var u = UI();
    if (f.participants && f.participants.length > 1) {
      if (u && u.setCallRinging) u.setCallRinging(false);
      if (u && u.startCallTimer && !C.timerRunning) { C.timerRunning = true; u.startCallTimer(); toast('Call connected'); }
    }
  });

  onFrame('call.invited', function (f) {
    if (C.callId && f.callId === C.callId) toast('Invitation sent');
  });

  onFrame('call.left', function (f) {
    if (!C.callId || f.callId !== C.callId) return;
    closePeer(f.userId);
    if (f.participants && UI() && UI().setParticipants) UI().setParticipants(f.participants);
  });

  onFrame('call.ended', function (f) {
    if (C.callId && f.callId !== C.callId) return;
    teardown();
    var u = UI();
    if (u) {
      if (u.closeCallScreen) u.closeCallScreen();
      if (u.hideIncoming) u.hideIncoming();
      if (u.toast) u.toast(f.reason === 'declined' ? 'Call declined' : 'Call ended');
    }
  });

  onFrame('call.state', function (f) {
    if (!C.callId || f.callId !== C.callId) return;
    if (String(f.userId) === String(meId())) return;
    var u = UI();
    if (u && u.setParticipants) u.setParticipants(u.currentCall && u.currentCall() ? u.currentCall().participants : null);
  });

  onFrame('call.signal', handleSignal);

  /** Add/keep a peer for every other participant in the room. */
  function joinPeerSet(participants) {
    if (!participants) return;
    participants.forEach(function (p) {
      var id = p && (p.userId != null ? p.userId : p.id);
      if (id == null || String(id) === String(meId())) return;
      if (!C.pcs[id]) callPeer(id);
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  function start(chatId, kind) {
    if (!chatId) { toast('Open a chat first', 'error'); return null; }
    loadIceServers();
    if (C.callId) { toast('You are already on a call', 'error'); return null; }
    C.kind = kind === 'video' ? 'video' : 'audio';
    C.timerRunning = false;
    var u = UI();
    if (u && u.openCallScreen) u.openCallScreen({ chatId: chatId, kind: C.kind, startedAt: Date.now(), participants: [] });
    if (u && u.setCallRinging) u.setCallRinging(true);          // "calling…" until they pick up
    return getMedia(C.kind).then(function () {
      startAttachLoop();
      showSpeakerButton();
      defaultCallAudio();
      if (u && u.setParticipants) u.setParticipants([{ userId: meId(), username: (u.me || {}).username, displayName: (u.me || {}).displayName }]);
      if (!send({ t: 'call.start', chatId: Number(chatId), kind: C.kind })) {
        toast('Not connected — message the chat first so the socket is live', 'error');
      }
    }).catch(function (e) {
      teardown();
      if (u && u.closeCallScreen) u.closeCallScreen();
      toast(e && e.name === 'NotAllowedError' ? 'Microphone/camera permission was refused.' : ('Call failed: ' + (e && e.message)), 'error');
    });
  }

  function accept(callId) {
    loadIceServers();
    if (window.XCRing) window.XCRing.stop();
    var id = callId || (C.pending && C.pending.callId);
    // The Android shell can answer by id (notification action, cold start), where there may be
    // no pending frame in memory yet — fall back to the ringing calls we stashed on arrival.
    var p = C.ringing[id] || C.pending || {};
    C.callId = id;
    C.chatId = p.chatId;
    C.kind = p.kind || 'audio';
    C.timerRunning = true;                                      // answering counts as picked up
    var u = UI();
    if (u && u.hideIncoming) u.hideIncoming();
    if (u && u.openCallScreen) u.openCallScreen({ callId: id, chatId: C.chatId, kind: C.kind, participants: (p.participants || []), startedAt: Date.now() });
    if (u && u.setCallRinging) u.setCallRinging(false);
    if (u && u.startCallTimer) u.startCallTimer();
    C.pending = null;
    if (C.ringTimeout) { clearTimeout(C.ringTimeout); C.ringTimeout = null; }
    return getMedia(C.kind).then(function () {
      startAttachLoop();
      showSpeakerButton();
      defaultCallAudio();
      send({ t: 'call.accept', callId: id });
      if (u && u.setParticipants) u.setParticipants([{ userId: meId(), username: (u.me || {}).username, displayName: (u.me || {}).displayName }]);
    }).catch(function (e) {
      toast('Microphone/camera permission was refused — cannot join.', 'error');
      send({ t: 'call.decline', callId: id });
      teardown();
      if (u && u.closeCallScreen) u.closeCallScreen();
    });
  }

  function decline(callId) {
    if (window.XCRing) window.XCRing.stop();
    var id = callId || (C.pending && C.pending.callId);
    if (id) send({ t: 'call.decline', callId: id });
    C.pending = null;
    var u = UI();
    if (u && u.hideIncoming) u.hideIncoming();
  }

  function leave() {
    if (C.callId) send({ t: 'call.leave', callId: C.callId });
    teardown();
    var u = UI();
    if (u && u.closeCallScreen) u.closeCallScreen();
  }

  function teardown() {
    try { if (window.XCApp && window.XCApp.endCallAudio) window.XCApp.endCallAudio(); } catch (e) {}
    C.speaker = false;
    var sb = document.getElementById('call-speaker'); if (sb) sb.classList.remove('on');
    if (window.XCRing) window.XCRing.stop();
    stopAttachLoop();
    closeAllPeers();
    stopStream(C.localStream); C.localStream = null; C.cameraTrack = null;
    stopStream(C.screenStream); C.screenStream = null;
    C.sharing = false;
    C.timerRunning = false;
    if (C.ringTimeout) { clearTimeout(C.ringTimeout); C.ringTimeout = null; }
    C.callId = null; C.chatId = null; C.pending = null; C.ringing = {};
    C.muted = false; C.camera = false;
    var screen = document.getElementById('call-screen');
    if (screen) screen.classList.remove('ringing');
    var u = UI();
    if (u && u.stopCallTimer) u.stopCallTimer();
  }

  function addPeople(ids) {
    var list = (ids || []).map(Number).filter(Boolean);
    if (!C.callId) { toast('No active call', 'error'); return null; }
    if (!list.length) return null;
    if (!send({ t: 'call.invite', callId: C.callId, userIds: list })) toast('Not connected', 'error');
    return list;
  }

  /* ------------------------------------------------------------- toggles */

  function broadcastState() {
    if (C.callId) send({ t: 'call.state', callId: C.callId, muted: C.muted, camera: C.camera, sharing: !!C.sharing });
    var u = UI();
    if (u && u.setCallState) u.setCallState({ muted: C.muted, camera: C.camera });
  }

  /* ------------------------------------------------------- speaker routing */

  /**
   * Audio routing is user-dependent: whatever you last chose in a call is what the
   * next call starts on (stored on the device, like the theme). The very first call
   * starts on the loudspeaker because a WebView's media stream is only guaranteed
   * audible there — picking earpiece once and having the button remember it is the
   * way to make the earpiece the everyday default without silent-call surprises.
   */
  function audioPrefKey() { return 'jarvis.audioRoute'; }
  function readAudioPref() {
    try {
      var v = localStorage.getItem(audioPrefKey());
      return v === null ? null : v === 'speaker';
    } catch (e) { return null; }
  }
  function writeAudioPref(speaker) {
    try { localStorage.setItem(audioPrefKey(), speaker ? 'speaker' : 'earpiece'); } catch (e) {}
  }
  function applySpeaker(on, quiet) {
    C.speaker = !!on;
    try { if (window.XCApp && window.XCApp.setSpeaker) window.XCApp.setSpeaker(C.speaker); } catch (e) {}
    var b = document.getElementById('call-speaker');
    if (b) { b.classList.toggle('on', C.speaker); b.setAttribute('aria-pressed', C.speaker ? 'true' : 'false'); }
    if (!quiet) toast(C.speaker ? 'Speaker on' : 'Earpiece');
  }
  function toggleSpeaker() {
    if (!C.callId && !C.localStream) { toast('No active call', 'error'); return; }
    applySpeaker(!C.speaker);
    writeAudioPref(C.speaker);            // the choice sticks for the next call
  }
  /** Start of a call: take the phone's audio and route it to the remembered choice. */
  function defaultCallAudio() {
    var app = window.XCApp || {};
    if (app.startCallAudio) { try { app.startCallAudio(); } catch (e) {} }
    if (!app.setSpeaker) return;                               // browser: the OS decides
    var want = readAudioPref();
    applySpeaker(want === null ? true : want, true);
    setTimeout(function () { if (C.callId || C.localStream) applySpeaker(C.speaker, true); }, 600);
    setTimeout(function () { if (C.callId || C.localStream) applySpeaker(C.speaker, true); }, 1800);
  }
  function showSpeakerButton() {
    var b = document.getElementById('call-speaker');
    if (!b) return;
    b.hidden = !(window.XCApp && window.XCApp.setSpeaker);
    if (!b.hidden) b.classList.toggle('on', !!C.speaker);
  }

  function toggleMute() {
    if (!C.localStream) { toast('No active call', 'error'); return; }
    C.muted = !C.muted;
    C.localStream.getAudioTracks().forEach(function (t) { t.enabled = !C.muted; });
    broadcastState();
    toast(C.muted ? 'Microphone off' : 'Microphone on');
  }

  function toggleCamera() {
    if (!C.localStream) { toast('No active call', 'error'); return; }
    var tracks = C.localStream.getVideoTracks();
    if (!tracks.length) {              // audio call: switch it into a video call
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      toast('Turning the camera on…');
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
      }).then(function (s) {
        var track = s.getVideoTracks()[0];
        try { track.contentHint = 'motion'; } catch (e) {}
        C.localStream.addTrack(track);
        C.cameraTrack = track;
        C.kind = 'video';
        C.camera = true;
        Object.keys(C.pcs).forEach(function (id) {
          try { C.pcs[id].addTrack(track, C.localStream); } catch (e) {}
          tuneSenders(C.pcs[id]);
          // whoever added the track asks for a renegotiation; the other side offers
          if (iInitiate(id)) negotiate(id);
          else send({ t: 'call.signal', callId: C.callId, to: Number(id), data: { needOffer: true } });
        });
        attachStreams(); broadcastState();
        toast('Camera on — HD');
      }).catch(function () { toast('Camera permission refused', 'error'); });
      return;
    }
    C.camera = !C.camera;
    tracks.forEach(function (t) { t.enabled = C.camera; });
    broadcastState();
  }

  /** Share the screen with everyone on the call. */
  function toggleScreenShare() {
    if (!C.callId) { toast('No active call', 'error'); return null; }
    if (C.sharing) { stopScreenShare(); return null; }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      toast('This app can\'t capture the screen — open XCaller in Chrome to share your screen', 'error');
      return null;
    }
    toast('Pick what to share…');
    // capture the real screen at the device's own aspect ratio; no fixed dims — the
    // track carries the screen's native size and every side fits it with `contain`.
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 24 } }, audio: false,
    }).then(function (s) {
      var track = s.getVideoTracks()[0];
      try { track.contentHint = 'detail'; } catch (e) {}
      C.screenStream = s;
      var replaced = false;
      Object.keys(C.pcs).forEach(function (id) {
        var sender = null;
        try { sender = C.pcs[id].getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0]; } catch (e) {}
        if (sender) { sender.replaceTrack(track); replaced = true; tuneSenders(C.pcs[id]); }
        else if (C.localStream) {
          try { C.pcs[id].addTrack(track, s); } catch (e) {}
          if (iInitiate(id)) negotiate(id);
          else send({ t: 'call.signal', callId: C.callId, to: Number(id), data: { needOffer: true } });
        }
      });
      C.sharing = true;
      broadcastState();                       // tell everyone this tile is a screen, not a camera
      var u = UI();
      if (u && u.videoFor) { var v = u.videoFor(meId()); if (v) { v.srcObject = s; v.classList.remove('mirror'); safePlay(v); markTile(v, true, true); } }
      track.addEventListener('ended', function () { stopScreenShare(); });
      // paint the sharing state everywhere it matters
      document.body.classList.add('xc-sharing');
      var sb = document.getElementById('call-share');
      if (sb) { sb.classList.add('sharing'); sb.setAttribute('aria-pressed', 'true'); }
      var mt = u && u.tileFor ? u.tileFor(meId()) : null;
      if (mt) mt.classList.add('sharing');
      if (u && u.setCallStatus) u.setCallStatus('connected');   // keep clock, add indicator via CSS
      toast('Sharing your screen');
      return true;
    }).catch(function (e) {
      if (e && e.name === 'NotAllowedError') return null;      // user cancelled the picker
      toast('Screen share failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
      return null;
    });
  }

  function stopScreenShare() {
    if (C.screenStream) stopStream(C.screenStream);
    C.screenStream = null;
    C.sharing = false;
    broadcastState();                       // peers drop the screen marker
    document.body.classList.remove('xc-sharing');
    var sb2 = document.getElementById('call-share');
    if (sb2) { sb2.classList.remove('sharing'); sb2.setAttribute('aria-pressed', 'false'); }
    var mt2 = UI() && UI().tileFor ? UI().tileFor(meId()) : null;
    if (mt2) mt2.classList.remove('sharing');
    var back = C.cameraTrack && C.cameraTrack.readyState === 'live' ? C.cameraTrack : null;
    if (back) {
      Object.keys(C.pcs).forEach(function (id) {
        try {
          var sender = C.pcs[id].getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
          if (sender) sender.replaceTrack(back);
        } catch (e) {}
      });
    }
    var u = UI();
    if (u && u.videoFor) { var v = u.videoFor(meId()); if (v) { v.srcObject = C.localStream; v.classList.add('mirror'); safePlay(v); } }
    attachStreams();
  }

  // hook the screen-share button (delegated for taps, direct for reliability)
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('#call-share') : null;
    if (b) { ev.preventDefault(); toggleScreenShare(); }
  });
  setInterval(function () {
    var b = document.getElementById('call-share');
    if (!b || b.__xcBound) return;
    b.__xcBound = true;
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); toggleScreenShare(); });
  }, 1500);

  /* ------------------------------------------------------------ diagnostics */

  /**
   * What a call really looks like from this device: whether the mic is live, every peer's
   * connection/ICE state, which candidate type won the connection (host = same network,
   * srflx = STUN, relay = TURN), and how many audio bytes are actually moving each way.
   *
   * A "no voice" report is answered with evidence: zero inbound bytes means nothing is
   * arriving (network/relay), non-zero inbound bytes with no sound means the phone is
   * routing the audio somewhere inaudible (device audio route).
   */
  function peerReport(peerId, pc) {
    return pc.getStats().then(function (report) {
      var row = { peer: peerId, connection: pc.connectionState, ice: pc.iceConnectionState, path: 'unknown', audioIn: 0, audioOut: 0 };
      var pair = null;
      report.forEach(function (r) {
        if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded')) {
          if (r.selected || r.nominated) pair = r;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') row.audioIn = r.bytesReceived || 0;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') row.audioOut = r.bytesSent || 0;
      });
      if (pair) {
        var loc = report.get(pair.localCandidateId) || {};
        row.path = loc.candidateType === 'relay' ? 'relay (TURN)' : (loc.candidateType === 'srflx' ? 'STUN (direct)' : (loc.candidateType || 'local'));
      }
      return row;
    }).catch(function () { return { peer: peerId, error: 'stats unavailable' }; });
  }

  function report() {
    var out = {
      call: C.callId || null,
      kind: C.kind,
      muted: !!C.muted,
      speaker: !!C.speaker,
      localAudio: 'none',
      localVideo: 'none',
      audioElements: document.querySelectorAll('audio[id^="call-audio-"]').length,
      turnServers: (C.iceServers || []).map(function (s) { return String(s.urls); }),
      peers: [],
      verdict: 'idle',
    };
    try {
      var mic = C.localStream && C.localStream.getAudioTracks()[0];
      out.localAudio = mic ? (mic.enabled ? (mic.readyState === 'live' ? 'live' : mic.readyState) : 'muted') : 'none';
      out.localVideo = C.localStream && C.localStream.getVideoTracks().length ? 'live' : 'none';
    } catch (e) {}
    var ids = Object.keys(C.pcs);
    if (!ids.length) return Promise.resolve(out);
    return Promise.all(ids.map(function (id) { return peerReport(id, C.pcs[id]); })).then(function (rows) {
      out.peers = rows;
      var inBytes = rows.reduce(function (n, r) { return n + (r.audioIn || 0); }, 0);
      var outBytes = rows.reduce(function (n, r) { return n + (r.audioOut || 0); }, 0);
      if (!inBytes) out.verdict = 'NO audio arriving from the other side (0 bytes) — the media path is not up';
      else if (outBytes < 1000) out.verdict = 'receiving audio, but nothing being sent — check the microphone/mute';
      else out.verdict = 'audio flowing both ways (' + Math.round(inBytes / 1024) + ' KB in / ' + Math.round(outBytes / 1024) + ' KB out)';
      return out;
    });
  }

  window.Calls = {
    start: start, accept: accept, decline: decline, leave: leave, addPeople: addPeople,
    toggleMute: toggleMute, toggleCamera: toggleCamera, toggleScreenShare: toggleScreenShare,
    toggleSpeaker: toggleSpeaker, speakerOn: function () { return !!C.speaker; },
    showSpeakerButton: showSpeakerButton, report: report,
    state: function () { return { callId: C.callId, chatId: C.chatId, kind: C.kind, participants: Object.keys(C.pcs), muted: C.muted, camera: C.camera, sharing: C.sharing }; },
  };
})();
