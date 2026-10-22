/**
 * XCaller — server.
 *
 * One Node process: REST + WebSocket hub + static files + WebRTC signalling.
 * No framework, no native modules (node:sqlite + ws only).
 *
 *   npm start            → http://0.0.0.0:3910/chat/
 *
 * The public path is /chat/ (nginx proxies it here, keeping the prefix), so every
 * route also answers without the prefix for local testing.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as db from './db.js';
import { iceServers, turnConfigured } from './turn.js';
import * as push from './push.js';

const PORT = Number(process.env.PORT || 3910);
const HOST = process.env.HOST || '0.0.0.0';
const PREFIX = '/chat';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const UPLOAD_DIR = db.UPLOAD_DIR;
const MAX_UPLOAD = 200 * 1024 * 1024;          // 200 MB per attachment
const ADMIN_PASSWORD_FILE = path.join(db.DATA_DIR, 'ADMIN_PASSWORD.txt');

/* ------------------------------------------------------------ admin seed */

function seedAdmin() {
  const existing = db.getUserRow('admin');
  if (existing) return;
  const password = randomBytes(9).toString('base64url');   // 12 chars
  const user = db.createUser({ username: 'admin', password, displayName: 'Administrator' });
  db.setRole(user.id, 'admin');
  fs.writeFileSync(ADMIN_PASSWORD_FILE, `XCaller — superadmin\nusername: admin\npassword: ${password}\n\nChange it after your first login (Settings → password).\n`, { mode: 0o600 });
  console.log('[seed] superadmin "admin" created; password in ADMIN_PASSWORD.txt');
}
seedAdmin();
db.purgeSessions();
// A call still marked in progress belongs to a previous run of this process: its
// room only existed in memory, so treat it as ended — otherwise it blocks the chat.
const staleCalls = db.dbHandle().prepare('UPDATE calls SET ended_at = ? WHERE ended_at IS NULL').run(Date.now());
if (staleCalls.changes) console.log(`[boot] closed ${staleCalls.changes} call(s) left open by a previous run`);

/* ------------------------------------------------------------ small utils */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
};
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function ok(res, obj = {}) { json(res, 200, obj); }
function fail(res, code, errorCode, message) { json(res, code, { error: { code: errorCode, message } }); }
async function readBody(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too_large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('bad_json'); }
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (new URL(req.url, 'http://x').searchParams.get('token') || '');
}

/* Minimal per-IP throttle for the auth endpoints (brute-force is the real risk). */
const hits = new Map();
function throttled(ip, key, max = 20, windowMs = 60_000) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  const rec = hits.get(k);
  if (!rec || now - rec.t > windowMs) { hits.set(k, { t: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > max;
}

/* ---------------------------------------------------------- multipart body */

/** Parse a multipart/form-data body into {fields, files}. Hand-written: no deps. */
function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = buf.indexOf(delim);
  if (idx < 0) return { fields: {}, files: {} };
  idx += delim.length;
  while (idx < buf.length) {
    if (buf.slice(idx, idx + 2).toString() === '--') break;          // closing boundary
    if (buf.slice(idx, idx + 2).toString() === '\r\n') idx += 2;
    const headEnd = buf.indexOf('\r\n\r\n', idx);
    if (headEnd < 0) break;
    const headers = buf.slice(idx, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd);
    const bodyEnd = next < 0 ? buf.length : next - 2;                 // strip trailing CRLF
    const content = buf.slice(headEnd + 4, bodyEnd);
    const nameM = headers.match(/name="([^"]*)"/i);
    const fileM = headers.match(/filename="([^"]*)"/i);
    const typeM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const name = nameM ? nameM[1] : '';
    if (fileM) parts.push({ name, filename: fileM[1], mime: typeM ? typeM[1].trim() : 'application/octet-stream', data: content });
    else if (name) parts.push({ name, value: content.toString('utf8') });
    if (next < 0) break;
    idx = next + delim.length;
  }
  const files = {}, fields = {};
  for (const p of parts) {
    if (p.filename !== undefined) files[p.name || 'file'] = { filename: p.filename, mime: p.mime, data: p.data };
    else fields[p.name] = p.value;
  }
  return { fields, files };
}

/* ------------------------------------------------------------------ calls */
/* In-memory call rooms: the DB records history, this keeps live state. */
const rooms = new Map();   // callId → { id, chatId, kind, starterId, members: Map<userId, {joined, state}> }
/**
 * A dropped socket used to pull the user out of every call room instantly — and a
 * 1-to-1 call is over for both the moment one side leaves. Phones drop sockets for
 * a living (network switch, WebView frozen by Doze/MIUI, the 15s ping sweep), so
 * that instant eviction is exactly why calls "ended abruptly". A disconnect now
 * starts a grace timer; the call is only retired if the user does NOT reconnect
 * (their socket set becomes non-empty again) before it fires.
 */
const callLeaveGrace = new Map();   // userId → Map<roomId, timer>
const CALL_GRACE_MS = 20_000;

function roomOf(id) { return rooms.get(id) || null; }
/** A call only counts as active while its room is alive in this process. */
function liveActiveCall(chatId) {
  const row = db.activeCallFor(chatId);
  if (!row) return null;
  if (roomOf(row.id)) return row;
  db.endCall(row.id);            // leftover row from a restart/crash: retire it
  return null;
}
function roomParticipants(room) {
  return [...room.members.entries()].filter(([, m]) => m.joined).map(([userId, m]) => {
    const u = db.getUserById(userId) || {};
    return {
      userId, muted: !!m.state?.muted, camera: !!m.state?.camera,
      username: u.username, displayName: u.displayName, avatarColor: u.avatarColor,
    };
  });
}
function inviteToRoom(room, userIds) {
  userIds.forEach((u) => { if (!room.members.has(u)) { room.members.set(u, { joined: false, state: {} }); db.upsertCallParticipant(room.id, u, {}); } });
}

/* ------------------------------------------------------------ REST router */

async function handleApi(req, res, url, route) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const method = req.method;

  if (route === '/api/health') return ok(res, { ok: true, service: 'jarvis-chat', version: 1, turn: turnConfigured(), time: Date.now() });

  /* ---- auth ---- */
  /**
   * Is this username free? Same rules as registration, answered before the user
   * fills in a password so they are told to pick another name straight away.
   */
  if (route === '/api/username-check' && (method === 'POST' || method === 'GET')) {
    let name = '';
    if (method === 'GET') name = String(url.searchParams.get('username') || '').trim();
    else { let b; try { b = await readBody(req); } catch (e) { b = {}; } name = String((b && b.username) || '').trim(); }
    if (!db.validUsername(name)) return ok(res, { available: false, reason: 'format', message: 'Usernames are 3-20 characters: a-z, 0-9 or underscore.' });
    if (db.RESERVED_USERNAMES.has(name)) return ok(res, { available: false, reason: 'reserved', message: 'That username is reserved — choose another one.' });
    if (db.getUserRow(name)) return ok(res, { available: false, reason: 'taken', message: 'That username is already taken — choose another one.' });
    return ok(res, { available: true, message: 'That username is free.' });
  }

  if (route === '/api/register' && method === 'POST') {
    if (throttled(ip, 'reg', 10)) return fail(res, 429, 'rate_limited', 'Too many attempts, wait a minute.');
    let body; try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message, 'Bad request body.'); }
    const username = String(body.username || '').trim();       // no silent case-folding: lowercase is the rule
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim() || username;
    if (!db.validUsername(username)) return fail(res, 400, 'bad_username', 'Username must be 3-20 characters: a-z, 0-9, underscore.');
    if (db.RESERVED_USERNAMES.has(username)) return fail(res, 409, 'reserved_username', 'That username is reserved.');
    if (password.length < 6) return fail(res, 400, 'bad_password', 'Password must be at least 6 characters.');
    if (db.getUserRow(username)) return fail(res, 409, 'username_taken', 'That username is already taken.');
    try {
      const user = db.createUser({ username, password, displayName });
      const token = db.createSession(user.id);
      // Arrived through an invite link → join that group straight away.
      const joined = joinByInvite(String(body.invite || ''), user);
      return json(res, 201, { token, user: db.publicUser(user), joined: joined });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(res, 409, 'username_taken', 'That username is already taken.');
      throw e;
    }
  }
  if (route === '/api/login' && method === 'POST') {
    if (throttled(ip, 'login', 20)) return fail(res, 429, 'rate_limited', 'Too many attempts, wait a minute.');
    let body; try { body = await readBody(req); } catch (e) { return fail(res, 400, e.message, 'Bad request body.'); }
    const row = db.getUserRow(String(body.username || '').trim().toLowerCase());
    if (!row || !db.verifyPassword(String(body.password || ''), row.pw_salt, row.pw_hash)) return fail(res, 401, 'bad_credentials', 'Wrong username or password.');
    if (row.banned) return fail(res, 403, 'banned', 'This account is blocked.');
    db.touchLastSeen(row.id);
    const me = db.getUserById(row.id);
    const joined = joinByInvite(String(body.invite || ''), me);
    return ok(res, { token: db.createSession(row.id), user: db.publicUser(me), joined: joined });
  }

  // An invite link: public, because the person opening it has no account yet.
  const inviteM = route.match(/^\/api\/invite\/([A-Za-z0-9_-]{4,64})$/);
  if (inviteM && method === 'GET') {
    const inv = db.inviteByToken(inviteM[1]);
    if (!inv) return fail(res, 404, 'bad_invite', 'That invite link is not valid.');
    return ok(res, {
      valid: inv.valid, reason: inv.reason, chatId: inv.chatId, chatTitle: inv.chatTitle,
      chatKind: inv.chatKind, inviterName: inv.inviterName, memberCount: inv.memberCount,
    });
  }

  // what the newest release is — public, so even the login screen can say
  // "a new version is available"
  if (route === '/api/version' && method === 'GET') {
    let v = { version: '0.0', apk: '/chat/XCaller.apk', notes: '', releasedAt: 0 };
    try { v = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'version.json'), 'utf8')); } catch (e) { /* keep default */ }
    return ok(res, v);
  }

  // Crash reports from the Android app — no sign-in needed (the app may be dying),
  // so they are throttled per IP and capped in size.
  if (route === '/api/crash' && method === 'POST') {
    if (throttled(ip, 'crash', 30, 60_000)) return fail(res, 429, 'rate_limited', 'Too many reports.');
    let body = {};
    try { body = await readBody(req); } catch (e) { body = {}; }
    const text = (body.trace || body.error || '').toString().slice(0, 8000);
    if (!text) return fail(res, 400, 'empty', 'Nothing to report.');
    try {
      db.dbHandle().prepare('CREATE TABLE IF NOT EXISTS crashes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, version TEXT, android TEXT, error TEXT, trace TEXT)').run();
      db.dbHandle().prepare('INSERT INTO crashes (ts, version, android, error, trace) VALUES (?,?,?,?,?)')
        .run(Date.now(), String(body.version || '').slice(0, 40), String(body.android || '').slice(0, 120), String(body.error || '').slice(0, 300), text);
      console.error(`[crash] ${body.version || '?'} ${body.error || ''} — ${String(text).split('\n')[0]}`);
    } catch (e) { /* never fail a crash report */ }
    return ok(res, { received: true });
  }

  /** Add someone to the group an invite points at. Never throws at the caller. */
  function joinByInvite(token, user) {
    try {
      if (!token) return null;
      const inv = db.inviteByToken(token);
      if (!inv || !inv.valid || inv.chatKind !== 'group') return null;
      const chat = db.chatById(inv.chatId);
      if (!chat) return null;
      const already = db.isMember(inv.chatId, user.id);
      db.unhideChat(inv.chatId);
      if (!already) {
        db.addMember(inv.chatId, user.id);
        const who = user.displayName || user.username;
        db.memberIds(inv.chatId).forEach((uid) => {
          if (Number(uid) === Number(user.id)) return;
          sendTo(uid, { t: 'chat.added', chatId: inv.chatId, userId: user.id, user: db.publicUser(user) });
        });
        db.insertMessage({
          chatId: inv.chatId, senderId: user.id, kind: 'system',
          body: `${who} joined using an invite link`,
        });
        const sys = db.dbHandle().prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(inv.chatId);
        if (sys) broadcastMessage(db.shapeMessage(sys));
        db.addEvent(user.id, 'joined_group', 'Added to ' + (chat.title || 'a group'),
          (inv.inviterName || 'Someone') + ' added you to ' + (chat.title || 'a group'), { chatId: inv.chatId });
      }
      db.useInvite(token);
      return { chatId: inv.chatId, title: chat.title || 'Group', already: already };
    } catch (e) {
      console.error('[invite] join failed:', e.message);
      return null;
    }
  }

  /* ---- everything below needs a session ---- */
  const user = db.sessionUser(bearer(req));
  if (!user) return fail(res, 401, 'unauthorized', 'Sign in first.');
  // /api/inbox is polled by the background service every minute, app open or not.
  // Refreshing last_seen there stamped people "seen seconds ago" for hours after
  // they closed XCaller — that is what made the timestamps dummy. Foreground API
  // calls and the WS connection remain the only real activity signals.
  if (route !== '/api/inbox') db.touchLastSeen(user.id);
  db.recordAppVersion(user.id, req.headers['user-agent']);
  const isAdmin = user.role === 'admin';

  if (route === '/api/logout' && method === 'POST') { db.deleteSession(bearer(req)); return ok(res); }
  if (route === '/api/me' && method === 'GET') return ok(res, { user: db.publicUser(user) });
  if (route === '/api/me' && method === 'POST') {
    const body = await readBody(req);
    if (String(body.newPassword || '').length) {
      // Phase 3: a password change must present the CURRENT password — a stolen
      // session (or a drive-by on an unlocked laptop) could otherwise own the
      // account permanently. Session stays valid; we just refuse to rekey without it.
      if (!body.currentPassword) return fail(res, 403, 'wrong_password', 'Current password is required and must match to set a new one.');
      const cred = db.getUserCredentials(user.id);
      if (!cred || !db.verifyPassword(String(body.currentPassword), cred.pw_salt, cred.pw_hash)) {
        return fail(res, 403, 'wrong_password', 'Current password is required and must match to set a new one.');
      }
      if (String(body.newPassword).length < 6) return fail(res, 400, 'bad_password', 'Password must be at least 6 characters.');
      const { salt, hash } = db.hashPassword(String(body.newPassword));
      db.dbHandle().prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, user.id);
    }
    return ok(res, { user: db.publicUser(db.updateProfile(user.id, body)) });
  }
  // the caller's own call history (never anyone else's)
  if (route === '/api/calls' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 100);
    return ok(res, { calls: db.userCalls(user.id, limit) });
  }

  // ---- forward a message (with its attachment) to chats and/or usernames ----
  const fwdM = route.match(/^\/api\/messages\/(\d+)\/forward$/);
  if (fwdM && method === 'POST') {
    const id = Number(fwdM[1]);
    const src = db.messageRow(id);
    if (!src) return fail(res, 404, 'no_message', 'That message is gone.');
    if (!db.isMember(src.chat_id, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    const body = await readBody(req);
    const targets = [...new Set((Array.isArray(body.chatIds) ? body.chatIds : []).map(Number).filter(Boolean))]
      .filter((cid) => db.isMember(cid, user.id));
    const missing = [];
    const names = Array.isArray(body.usernames) ? body.usernames : String(body.usernames || '').split(/[\s,;]+/);
    names.map((s) => String(s || '').trim()).filter(Boolean).forEach((name) => {
      const row = db.getUserRow(name.toLowerCase());
      if (!row || row.banned) { missing.push(name); return; }
      if (row.id === user.id) { missing.push(name + ' (that is you)'); return; }
      targets.push(db.createDirect(user.id, row.id));       // makes the DM if it is new
    });
    const unique = [...new Set(targets)];
    if (!unique.length) return fail(res, 400, 'no_target', missing.length ? `Could not find: ${missing.join(', ')}` : 'Pick somebody to forward to.');
    const me = db.getUserById(user.id);
    const from = src.forwarded_from || `${me.displayName || me.username}`;
    const sent = [];
    unique.forEach((cid) => {
      const copy = db.insertMessage({
        chatId: cid,
        senderId: user.id,
        body: src.body,
        kind: src.kind,
        attachment: src.attachment_path ? { path: src.attachment_path, name: src.attachment_name, mime: src.attachment_mime, size: src.attachment_size } : null,
        forwardedFrom: from,
      });
      broadcastMessage(copy);
      db.memberIds(cid).forEach((uid) => {
        const frame = db.chatList(uid).find((c) => c.id === cid);
        if (frame) sendTo(uid, { t: 'chat.created', chat: frame });
      });
      sent.push(cid);
    });
    return ok(res, { forwarded: sent.length, chatIds: sent, missing });
  }

  // ---- group owner: add members ------------------------------------------
  // The owner of a group can hand out a link; whoever opens it lands in the group.
  const chatInviteM = route.match(/^\/api\/chats\/(\d+)\/invite$/);
  if (chatInviteM && method === 'POST') {
    const chatId = Number(chatInviteM[1]);
    const chat = db.chatById(chatId);
    if (!chat) return fail(res, 404, 'no_chat', 'That chat does not exist.');
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'not_a_member', 'You are not in this chat.');
    if (chat.kind !== 'group') return fail(res, 400, 'not_group', 'Invite links are for groups.');
    if (!db.isOwner(chatId, user.id)) return fail(res, 403, 'not_owner', 'Only the group owner can invite by link.');
    let body = {}; try { body = await readBody(req); } catch (e) { /* optional */ }
    const existing = body.fresh === true ? null : db.chatInvites(chatId).find((i) => i.valid);
    if (body.fresh === true) db.revokeInvitesFor(chatId);     // one live link per group
    const inv = existing || db.createInvite(chatId, user.id, Number(body.days || 30));
    const full = db.inviteByToken(inv.token);
    const url = `https://${req.headers.host}/chat/?join=${inv.token}`;
    return ok(res, {
      token: inv.token, url, expiresAt: inv.expiresAt || null,
      title: full.chatTitle, memberCount: full.memberCount, created: !existing,
    });
  }

  // Already signed in and just opened an invite link → join on the spot.
  const inviteAcceptM = route.match(/^\/api\/invite\/([A-Za-z0-9_-]{4,64})\/accept$/);
  if (inviteAcceptM && method === 'POST') {
    const joined = joinByInvite(inviteAcceptM[1], user);
    if (!joined) return fail(res, 400, 'bad_invite', 'That invite link is no longer valid.');
    return ok(res, { joined });
  }

  const chatMembersM = route.match(/^\/api\/chats\/(\d+)\/members$/);
  if (chatMembersM && method === 'POST') {
    const chatId = Number(chatMembersM[1]);
    const chat = db.chatById(chatId);
    if (!chat || chat.kind !== 'group') return fail(res, 404, 'no_group', 'That group does not exist.');
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your group.');
    if (!db.isOwner(chatId, user.id)) return fail(res, 403, 'owner_only', 'Only the group owner can add members.');
    const body = await readBody(req);
    const missing = [];
    const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(Number).filter(Boolean))];
    const names = Array.isArray(body.usernames) ? body.usernames : String(body.usernames || '').split(/[\s,;]+/);
    names.map((s) => String(s || '').trim()).filter(Boolean).forEach((name) => {
      if (name.toLowerCase() === user.username) return;      // you are already in it
      const row = db.getUserRow(name.toLowerCase());
      if (!row || row.banned) { missing.push(name); return; }
      if (row.id !== user.id) ids.push(row.id);
    });
    const added = [];
    const addedBy = db.publicUser(user);
    ids.filter((uid) => db.getUserById(uid)).forEach((uid) => {
      if (db.isMember(chatId, uid)) return;
      db.addMember(chatId, uid);
      db.unhideChat(chatId);
      added.push(uid);
      const frame = db.chatList(uid).find((c) => c.id === chatId);
      sendTo(uid, { t: 'chat.created', chat: frame });
      sendTo(uid, { t: 'chat.added', chatId, chat: frame, addedBy, title: chat.title });
      push.notify([uid], { type: 'message', title: 'Added to a group', body: `${addedBy.displayName || addedBy.username} added you to ${chat.title || 'a group'}`, chatId });
    });
    if (added.length) db.memberIds(chatId).forEach((uid) => sendTo(uid, { t: 'chat.members', chatId, members: db.chatList(uid).find((c) => c.id === chatId)?.members || [], memberCount: db.memberIds(chatId).length }));
    return ok(res, { added: added.length, missing });
  }

  // ---- group owner: remove a member --------------------------------------
  const chatMemberM = route.match(/^\/api\/chats\/(\d+)\/members\/(\d+)$/);
  if (chatMemberM && method === 'DELETE') {
    const chatId = Number(chatMemberM[1]);
    const victim = Number(chatMemberM[2]);
    const chat = db.chatById(chatId);
    if (!chat || chat.kind !== 'group') return fail(res, 404, 'no_group', 'That group does not exist.');
    if (!db.isOwner(chatId, user.id)) return fail(res, 403, 'owner_only', 'Only the group owner can remove members.');
    if (String(victim) === String(user.id)) return fail(res, 400, 'self', 'You cannot remove yourself — leave the group instead.');
    if (!db.isMember(chatId, victim)) return fail(res, 404, 'no_member', 'That person is not in this group.');
    db.leaveChat(chatId, victim);
    sendTo(victim, { t: 'chat.gone', chatId, removed: true });
    db.memberIds(chatId).forEach((uid) => sendTo(uid, { t: 'chat.members', chatId, members: db.chatList(uid).find((c) => c.id === chatId)?.members || [], memberCount: db.memberIds(chatId).length }));
    broadcastMessage(db.insertMessage({ chatId, senderId: user.id, body: `${(db.getUserById(victim) || {}).displayName || 'A member'} was removed by the owner`, kind: 'system' }));
    return ok(res, { removed: victim });
  }

  // ---- group owner: hide/show the member list ----------------------------
  const chatSettingsM = route.match(/^\/api\/chats\/(\d+)\/settings$/);
  if (chatSettingsM && method === 'POST') {
    const chatId = Number(chatSettingsM[1]);
    const chat = db.chatById(chatId);
    if (!chat || chat.kind !== 'group') return fail(res, 404, 'no_group', 'That group does not exist.');
    if (!db.isOwner(chatId, user.id)) return fail(res, 403, 'owner_only', 'Only the group owner can change this.');
    const body = await readBody(req);
    db.setHideMembers(chatId, !!body.hideMembers);
    db.memberIds(chatId).forEach((uid) => {
      const frame = db.chatList(uid).find((c) => c.id === chatId);
      if (frame) sendTo(uid, { t: 'chat.updated', chat: frame });
    });
    return ok(res, { chatId, hideMembers: !!body.hideMembers });
  }

  if (route === '/api/users' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    // Privacy: never hand out the whole user list. A search needs a real query.
    if (q.length < 2) return ok(res, { users: [], needQuery: true });
    const online = onlineIds();
    return ok(res, { users: db.searchUsers(q, user.id).map((u) => ({ ...u, online: online.has(u.id) })) });
  }
  if (route === '/api/chats' && method === 'GET') {
    const on = onlineIds();
    const chats = db.chatList(user.id);
    for (const c of chats) if (c.members) for (const m of c.members) m.online = on.has(m.id);
    return ok(res, { chats });
  }
  if (route === '/api/chats' && method === 'POST') {
    const body = await readBody(req);
    let ids = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number).filter((n) => n && n !== user.id))];
    // adding people by typing their usernames (Telegram style) — self is never added
    const missing = [];
    const typed = (Array.isArray(body.usernames) ? body.usernames : String(body.usernames || '').split(/[\s,;]+/))
      .map((s) => String(s || '').trim()).filter(Boolean);
    typed.forEach((name) => {
      if (name.toLowerCase() === user.username) return;      // you are in the group already
      const row = db.getUserRow(name.toLowerCase());
      if (!row || row.banned) { missing.push(name); return; }
      if (row.id !== user.id) ids.push(row.id);
    });
    ids = [...new Set(ids)];
    if (!ids.length) return fail(res, 400, 'no_members', missing.length ? `Could not find: ${missing.join(', ')}` : 'Pick at least one person.');
    for (const id of ids) if (!db.getUserById(id)) return fail(res, 404, 'no_such_user', 'One of those users does not exist.');
    // one person → a normal 1:1 chat, not a group (a single typed username is a DM;
    // group creation requires either 2+ members or an explicit title — Phase 1 fix,
    // was: oneToOne required !typed.length, so typing one username made "Group")
    const oneToOne = ids.length === 1 && !String(body.title || '').trim();
    const chatId = oneToOne ? db.createDirect(user.id, ids[0]) : db.createGroup(user.id, ids, body.title || '');
    if (body.hideMembers && db.chatById(chatId).kind === 'group') db.setHideMembers(chatId, true);
    const chat = db.chatList(user.id).find((c) => c.id === chatId);
    // everyone added learns about the chat immediately, with a notification
    const addedBy = db.publicUser(user);
    db.memberIds(chatId).forEach((uid) => {
      const forUser = db.chatList(uid).find((c) => c.id === chatId);
      sendTo(uid, { t: 'chat.created', chat: forUser });
      if (uid !== user.id) {
        sendTo(uid, { t: 'chat.added', chatId, chat: forUser, addedBy, title: forUser && forUser.title });
        // and a phone notification if the app is closed
        push.notify([uid], { type: 'message', title: 'Added to a group', body: `${addedBy.displayName || addedBy.username} added you to ${forUser && forUser.title ? forUser.title : 'a group'}`, chatId });
      }
    });
    // Every group gets its own link the moment it exists, so the owner can share
    // it right away — and two groups can never end up with the same link.
    let invite = null;
    if (chat && chat.kind === 'group') {
      try {
        const inv = db.createInvite(chatId, user.id, 90);
        invite = { token: inv.token, url: `https://${req.headers.host}/chat/?join=${inv.token}`, expiresAt: inv.expiresAt };
      } catch (e) { /* never fail group creation over a link */ }
    }
    return json(res, 201, { chat, missing, invite });
  }

  // delete a chat for me (1:1) or leave it (group)
  const chatGoneM = route.match(/^\/api\/chats\/(\d+)\/delete$/);
  if (chatGoneM && method === 'POST') {
    const chatId = Number(chatGoneM[1]);
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    let body = {}; try { body = await readBody(req); } catch (e) { body = {}; }
    const chat = db.chatById(chatId);
    // "leave" is an explicit choice; anything else only hides it for me.
    // (Groups get the same choice: a quiet delete, or leave for good.)
    const leave = !!(body && body.mode === 'leave' && chat && chat.kind === 'group');
    const announce = db.memberIds(chatId);
    if (leave) {
      db.leaveChat(chatId, user.id);
      announce.filter((uid) => uid !== user.id).forEach((uid) => sendTo(uid, { t: 'chat.left', chatId, userId: user.id, participants: db.memberIds(chatId) }));
    } else {
      db.hideChat(chatId, user.id);
    }
    sendTo(user.id, { t: 'chat.gone', chatId, left: leave });
    return ok(res, { chatId, left: leave });
  }
  const chatMsgM = route.match(/^\/api\/chats\/(\d+)\/messages$/);
  if (chatMsgM && method === 'GET') {
    const chatId = Number(chatMsgM[1]);
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    const before = Number(url.searchParams.get('before') || 0);
    const limit = Number(url.searchParams.get('limit') || 50);
    const messages = db.chatMessages(chatId, { before, limit });
    // this user is holding the messages now, so they really are delivered
    const changed = db.markDelivered(chatId, user.id, null);
    if (changed.length) {
      const at = Date.now();
      db.memberIds(chatId).forEach((uid) => { if (uid !== user.id) sendTo(uid, { t: 'msg.delivered', chatId, ids: changed, by: user.id, at }); });
    }
    return ok(res, { messages });
  }
  if (chatMsgM && method === 'POST') {
    const chatId = Number(chatMsgM[1]);
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    const body = await readBody(req);
    const msg = db.insertMessage({ chatId, senderId: user.id, body: body.body, kind: body.kind || 'text', attachment: body.attachment || null, replyTo: body.replyTo || null, clientId: body.clientId || null });
    broadcastMessage(msg);
    return json(res, 201, { message: msg });
  }
  const chatReadM = route.match(/^\/api\/chats\/(\d+)\/read$/);
  if (chatReadM && method === 'POST') {
    const chatId = Number(chatReadM[1]);
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    db.markRead(chatId, user.id);
    db.memberIds(chatId).forEach((uid) => sendTo(uid, { t: 'msg.read', chatId, userId: user.id, at: Date.now() }));
    return ok(res);
  }
  if (route === '/api/upload' && method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    const bm = ctype.match(/boundary=(.+)$/);
    if (!bm) return fail(res, 400, 'bad_request', 'Expected multipart/form-data.');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) return fail(res, 413, 'too_large', 'File too big (200 MB max).'); chunks.push(c); }
    const { files } = parseMultipart(Buffer.concat(chunks), bm[1]);
    const f = files.file || files.upload || Object.values(files)[0];
    if (!f || !f.data || !f.data.length) return fail(res, 400, 'no_file', 'No file in the request.');
    // Phase 3 hardening: extension allowlist (no server-executable / HTML payloads),
    // real MIME check against the magic bytes for the types people actually send.
    const safeExt = (path.extname(f.filename || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
    const ALLOW_EXT = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.pdf','.txt','.mp3','.ogg','.wav','.m4a','.mp4','.webm','.mov','.zip','.doc','.docx','.xls','.xlsx','.ppt','.pptx']);
    if (!ALLOW_EXT.has(safeExt)) return fail(res, 415, 'bad_type', 'That file type is not allowed.');
    const sniff = f.data.subarray(0, 12);
    const svg = safeExt === '.svg';
    const looksHtml = !svg && /^\s*(<\?xml|<!DOCTYPE html|<html)/i.test(f.data.subarray(0, 200).toString('utf8'));
    if (looksHtml) return fail(res, 415, 'bad_type', 'File content does not match its extension.');
    const imgExt = ['.png','.jpg','.jpeg','.gif','.webp'];
    if (imgExt.includes(safeExt)) {
      const sigs = { '.png': [0x89,0x50,0x4e,0x47], '.jpg': [0xff,0xd8,0xff], '.jpeg': [0xff,0xd8,0xff], '.gif': [0x47,0x49,0x46], '.webp': null };
      const sig = sigs[safeExt];
      if (sig && !sig.every((b, i) => sniff[i] === b)) return fail(res, 415, 'bad_type', 'File content does not match its extension.');
      if (!sig && !(sniff[8]===0x57 && sniff[9]===0x45 && sniff[10]===0x42 && sniff[11]===0x50)) return fail(res, 415, 'bad_type', 'File content does not match its extension.');
    }
    if (svg && (!f.data.subarray(0, 300).toString('utf8').includes('<svg'))) return fail(res, 415, 'bad_type', 'Not a valid SVG.');
    const stored = randomBytes(16).toString('hex') + safeExt;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.data, { mode: 0o644 });
    return json(res, 201, { path: `/chat/uploads/${stored}`, name: String(f.filename || 'file').slice(0, 200), mime: f.mime, size: f.data.length });
  }
  if (route === '/api/turn-credentials' && method === 'GET') return ok(res, { iceServers: iceServers(user) });

  /* ------------------------------------------------------------------------
   * The native Android app polls this: everything that happened since `after`
   * plus any call that is ringing for me right now. Tiny payload, plain HTTPS.
   * ---------------------------------------------------------------------- */
  if (route === '/api/inbox' && method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    const wait = Math.min(28, Math.max(0, Number(url.searchParams.get('wait') || 0)));
    // The phone remembers what it has already shown, so a notice or a missed call is
    // handed over exactly once per device — otherwise the long poll would never rest.
    const seenNotice = Number(url.searchParams.get('seenNotice') || 0);
    const seenEvent = Number(url.searchParams.get('seenEvent') || 0);

    const readInbox = () => {
      const rows = db.dbHandle().prepare(`
        SELECT m.id, m.chat_id AS chatId, m.sender_id AS senderId, m.body, m.kind, m.created_at AS createdAt,
               u.username AS senderUsername, u.display_name AS senderName,
               c.kind AS chatKind, c.title AS chatTitle
        FROM messages m
        JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        JOIN chats c ON c.id = m.chat_id
        JOIN users u ON u.id = m.sender_id
        WHERE m.id > ? AND m.sender_id != ? AND m.deleted = 0 AND cm.hidden = 0
        ORDER BY m.id LIMIT 25`).all(user.id, after, user.id);

      let call = null;
      for (const room of rooms.values()) {
        const m = room.members.get(user.id);
        if (m && !m.joined) {
          const caller = db.getUserById(room.starterId) || {};
          call = { callId: room.id, chatId: room.chatId, kind: room.kind, fromName: caller.displayName || caller.username, fromId: room.starterId };
          // Their phone is listening right now → the ring is really being delivered.
          if (m.status !== 'ringing') {
            m.status = 'ringing';
            sendTo(room.starterId, { t: 'call.status', callId: room.id, userId: user.id, status: 'ringing', name: user.displayName || user.username });
          }
          break;
        }
      }
      const latest = db.dbHandle().prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)').get(user.id).id;
      // A "new version" notice for the background service to turn into a notification.
      let notice = null;
      try {
        const h = db.dbHandle();
        h.prepare('CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, version TEXT, title TEXT, body TEXT, kind TEXT)').run();
        h.prepare('CREATE TABLE IF NOT EXISTS notice_seen (user_id INTEGER NOT NULL, notice_id INTEGER NOT NULL, PRIMARY KEY (user_id, notice_id))').run();
        // Never consume the notice here: the phone decides whether it has shown it
        // yet. Marking it "seen" on delivery would silently lose it whenever the app
        // happened to be in the foreground at that moment.
        const row = h.prepare(`SELECT * FROM notices WHERE ts > ? ORDER BY id DESC LIMIT 1`).get(Date.now() - 14 * 24 * 3600e3);
        if (row && row.id > seenNotice) notice = { id: row.id, version: row.version, title: row.title, body: row.body, kind: row.kind };
      } catch (e) { /* notices are optional */ }
      // Missed calls and anything else that happened while the phone was away.
      let events = [];
      try { events = db.eventsFor(user.id, 12 * 3600e3).filter((e) => e.id > seenEvent); } catch (e) { /* optional */ }
      return { messages: rows, call, notice, events, latestId: latest, serverTime: Date.now() };
    };

    let payload = readInbox();
    if (wait > 0) {
      // Hold the request open until something we actually deliver arrives. A wake
      // from an unrelated frame (a presence ping, say) simply starts another wait,
      // so the phone is answered the instant its message or call is ready.
      const deadline = Date.now() + wait * 1000;
      const isEmpty = (p) => !p.messages.length && !p.call && !p.notice && !(p.events || []).length;
      // Attach the disconnect watchers ONCE for the whole wait — re-adding them on
      // every round piled dozens of listeners on one request (the MaxListeners
      // warning in the log) and slowly leaked them on chatty phones.
      let wake = null;
      req.once('close', () => { if (wake) wake(); });
      res.once('close', () => { if (wake) wake(); });
      while (isEmpty(payload) && Date.now() < deadline) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const set = inboxWaiters.get(user.id);
            if (set) { set.delete(finish); if (!set.size) inboxWaiters.delete(user.id); }
            wake = null;
            resolve();
          };
          const set = inboxWaiters.get(user.id) || new Set();
          inboxWaiters.set(user.id, set);
          set.add(finish);
          wake = finish;
          const timer = setTimeout(finish, Math.max(250, deadline - Date.now()));
        });
        payload = readInbox();
      }
    }
    return ok(res, payload);
  }

  /* ---- push notifications (messages + ringing when the app is closed) ---- */
  if (route === '/api/push/key' && method === 'GET') return ok(res, { key: push.publicKey(), enabled: push.pushReady(), devices: push.subscriptionCount() });
  if (route === '/api/push/subscribe' && method === 'POST') {
    const body = await readBody(req);
    try { push.saveSubscription(user.id, body.subscription || body, req.headers['user-agent'] || ''); }
    catch { return fail(res, 400, 'bad_subscription', 'That device subscription could not be saved.'); }
    return json(res, 201, { ok: true });
  }
  if (route === '/api/push/unsubscribe' && method === 'POST') {
    const body = await readBody(req);
    push.dropSubscription(body.endpoint);
    return ok(res);
  }
  if (route === '/api/push/test' && method === 'POST') {
    const out = await push.notify([user.id], { type: 'message', title: 'XCaller', body: 'Notifications work on this device 🎉', chatId: 0 });
    return ok(res, out);
  }

  /* ---- calls ---- */
  if (route === '/api/calls' && method === 'POST') {
    const body = await readBody(req);
    const chatId = Number(body.chatId);
    if (!db.isMember(chatId, user.id)) return fail(res, 403, 'forbidden', 'Not your chat.');
    const kind = body.kind === 'video' ? 'video' : 'audio';
    const existing = liveActiveCall(chatId);
    if (existing) {
      const room = roomOf(existing.id);
      return ok(res, { call: { id: existing.id, chatId, kind: existing.kind, participants: room ? roomParticipants(room) : [] }, reused: true });
    }
    const id = createRoom({ chatId, kind, starterId: user.id });
    return json(res, 201, { call: { id, chatId, kind, participants: [] } });
  }
  const callInviteM = route.match(/^\/api\/calls\/([\w-]+)\/invite$/);
  if (callInviteM && method === 'POST') {
    const room = roomOf(callInviteM[1]);
    if (!room) return fail(res, 404, 'no_call', 'That call is over.');
    const body = await readBody(req);
    const ids = (Array.isArray(body.userIds) ? body.userIds : []).map(Number)
      .filter((id) => id && db.isMember(room.chatId, id));
    inviteToRoom(room, ids.filter((id) => id !== user.id));
    const chat = db.chatById(room.chatId);
    ids.forEach((id) => sendTo(id, {
      t: 'call.incoming', callId: room.id, chatId: room.chatId, kind: room.kind,
      from: db.publicUser(user), chat, participants: roomParticipants(room), invited: true,
    }));
    if (ids.length) notifyRoom(room, { t: 'call.invited', callId: room.id, userIds: ids });
    return ok(res, { ok: true, invited: ids });
  }
  const callLeaveM = route.match(/^\/api\/calls\/([\w-]+)\/leave$/);
  if (callLeaveM && method === 'POST') {
    const room = roomOf(callLeaveM[1]);
    if (room) leaveRoom(room, user.id);
    return ok(res);
  }
  if (route === '/api/calls/active' && method === 'GET') {
    const chatId = Number(url.searchParams.get('chatId') || 0);
    const row = chatId ? liveActiveCall(chatId) : null;
    if (!row) return ok(res, { call: null });
    const room = roomOf(row.id);
    return ok(res, { call: { id: row.id, chatId: row.chat_id, kind: row.kind, participants: room ? roomParticipants(room) : [] } });
  }

  /* ---- admin: the owner sees everything ---- */
  if (route.startsWith('/api/admin/')) {
    if (!isAdmin) return fail(res, 403, 'forbidden', 'Administrators only.');
    if (route === '/api/admin/stats' && method === 'GET') {
      const online = onlineIds();
      return ok(res, { stats: { ...db.stats(), onlineNow: online.size, turn: turnConfigured(), pushDevices: push.subscriptionCount() }, messagesPerDay: db.messagesPerDay(14) });
    }
    if (route === '/api/admin/users' && method === 'GET') {
      const online = onlineIds();
      return ok(res, { users: db.allUsers().map((u) => ({ ...u, online: online.has(u.id) })) });
    }
    if (route === '/api/admin/chats' && method === 'GET') return ok(res, { chats: db.allChats() });
    const acm = route.match(/^\/api\/admin\/chats\/(\d+)\/messages$/);
    if (acm && method === 'GET') {
      const chatId = Number(acm[1]);
      const rows = db.chatMessages(chatId, { before: Number(url.searchParams.get('before') || 0), limit: Number(url.searchParams.get('limit') || 100) });
      const names = new Map(db.chatMembers(chatId).map((m) => [m.id, m.username]));
      return ok(res, { messages: rows.map((m) => ({ ...m, senderUsername: names.get(m.senderId) || `#${m.senderId}` })) });
    }
    if (route === '/api/admin/messages' && method === 'GET') {
      return ok(res, {
        messages: db.searchMessages({
          q: url.searchParams.get('q') || '', userId: Number(url.searchParams.get('userId') || 0),
          chatId: Number(url.searchParams.get('chatId') || 0), before: Number(url.searchParams.get('before') || 0),
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
    }
    if (route === '/api/admin/calls' && method === 'GET') return ok(res, { calls: db.callLog(Number(url.searchParams.get('limit') || 200)) });
    if (route === '/api/admin/audit' && method === 'GET') return ok(res, { audit: db.auditLog(Number(url.searchParams.get('limit') || 100)) });

    // Tell every installed app that a new version exists: a live frame for apps
    // that are open, and a notice the background service turns into a notification.
    if (route === '/api/admin/announce' && method === 'POST') {
      const body = await readBody(req);
      const version = String(body.version || '').slice(0, 20);
      const title = String(body.title || 'A new version of XCaller is available').slice(0, 120);
      const text = String(body.body || 'Tap Update in the app to install it — your chats and call history stay.').slice(0, 300);
      if (!version) return fail(res, 400, 'no_version', 'Which version?');
      db.dbHandle().prepare('CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, version TEXT, title TEXT, body TEXT, kind TEXT)').run();
      const info = db.dbHandle().prepare('INSERT INTO notices (ts, version, title, body, kind) VALUES (?,?,?,?,?)')
        .run(Date.now(), version, title, text, 'update');
      const notice = { id: Number(info.lastInsertRowid), version, title, body: text, kind: 'update' };
      const ids = db.allUsers().map((u) => u.id);
      ids.forEach((uid) => sendTo(uid, { t: 'notice', notice }));           // open apps
      push.notify(ids, { type: 'notice', ...notice, tag: `update-${version}` }, { ttl: 86400, urgency: 'normal' }).catch(() => {});
      return ok(res, { notice, told: ids.length });
    }

    if (route === '/api/admin/crashes' && method === 'GET') {
      let rows = [];
      try { rows = db.dbHandle().prepare('SELECT * FROM crashes ORDER BY id DESC LIMIT 20').all(); } catch (e) { rows = []; }
      return ok(res, { crashes: rows });
    }
    const banM = route.match(/^\/api\/admin\/users\/(\d+)\/(ban|unban)$/);
    if (banM && method === 'POST') {
      const target = Number(banM[1]);
      const row = db.getUserById(target);
      if (!row) return fail(res, 404, 'no_such_user', 'No such user.');
      if (row.username === 'admin') return fail(res, 403, 'protected', 'The superadmin cannot be blocked.');
      db.setBanned(target, banM[2] === 'ban');
      db.audit(user.id, banM[2] === 'ban' ? 'user.ban' : 'user.unban', `user:${target}`, row.username);
      if (banM[2] === 'ban') closeUserSockets(target, 'banned');
      broadcastToAdmins({ t: 'admin.user', user: { ...db.getUserById(target), online: onlineIds().has(target) } });
      return ok(res, { user: db.getUserById(target) });
    }
    const roleM = route.match(/^\/api\/admin\/users\/(\d+)\/role$/);
    if (roleM && method === 'POST') {
      const target = Number(roleM[1]);
      const body = await readBody(req);
      const row = db.getUserById(target);
      if (!row) return fail(res, 404, 'no_such_user', 'No such user.');
      if (row.username === 'admin' && body.role !== 'admin') return fail(res, 403, 'protected', 'The superadmin stays an administrator.');
      db.setRole(target, body.role === 'admin' ? 'admin' : 'user');
      db.audit(user.id, body.role === 'admin' ? 'user.promote' : 'user.demote', `user:${target}`, row.username);
      return ok(res, { user: db.getUserById(target) });
    }
    const delM = route.match(/^\/api\/admin\/messages\/(\d+)\/delete$/);
    if (delM && method === 'POST') {
      const id = Number(delM[1]);
      const msg = db.getMessage(id);
      if (!msg) return fail(res, 404, 'no_message', 'No such message.');
      db.deleteMessage(id);
      db.audit(user.id, 'message.delete', `msg:${id}`, `chat ${msg.chatId}`);
      db.memberIds(msg.chatId).forEach((uid) => sendTo(uid, { t: 'msg.deleted', chatId: msg.chatId, messageId: id }));
      return ok(res, { ok: true });
    }
    return fail(res, 404, 'not_found', 'Unknown admin endpoint.');
  }

  return fail(res, 404, 'not_found', 'Unknown endpoint.');
}

/* ------------------------------------------------------------- websockets */

const wss = new WebSocketServer({ noServer: true });
const sockets = new Map();     // userId → Set<ws>
const meta = new WeakMap();    // ws → { userId, isAdmin }
/** Phones whose background service is holding /api/inbox open right now. */
const inboxWaiters = new Map();  // userId → Set<wake fn>

/** Wake a waiting inbox request: this is what makes background delivery instant. */
function wakeInbox(userId) {
  const set = inboxWaiters.get(Number(userId));
  if (!set || !set.size) return;
  for (const fn of [...set]) { try { fn(); } catch (e) { /* gone already */ } }
}

// Realtime presence (WhatsApp/Telegram semantics): "online" means the user's
// SCREEN IS OPEN or they are on an active call — not merely "some socket exists".
// XCaller keeps its socket alive in the background on purpose (so notifications
// arrive instantly), which made every backgrounded app look online forever.
const presenceState = new Map();   // userId -> last broadcast online bool

function visibleSocket(uid) {
  const set = sockets.get(Number(uid));
  if (!set) return false;
  for (const ws of set) if (ws.readyState === 1 && meta.get(ws)?.visible) return true;
  return false;
}
function inActiveCall(uid) {
  for (const room of rooms.values()) {
    const m = room.members.get(Number(uid));
    if (m?.joined) return true;
  }
  return false;
}
function userOnline(uid) { return visibleSocket(uid) || inActiveCall(uid); }

function publishPresence(uid, on) {
  presenceState.set(Number(uid), !!on);
  const goneAt = on ? undefined : Date.now();
  for (const id of db.chatMemberIdsOf(uid)) sendTo(id, { t: 'presence', userId: uid, online: !!on, at: goneAt });
  broadcastToAdmins({ t: 'admin.presence', userId: uid, online: !!on });
}
/** Recompute one user's online state and broadcast only if it changed. */
function recheckPresence(uid) {
  const on = userOnline(uid);
  const prev = presenceState.get(Number(uid));
  if (prev !== on) publishPresence(uid, on);
}

function onlineIds() {
  const s = new Set();
  for (const uid of sockets.keys()) if (userOnline(uid)) s.add(Number(uid));
  return s;
}
function sendTo(userId, frame) {
  wakeInbox(userId);                                  // a waiting phone gets it at once
  const set = sockets.get(Number(userId));
  if (!set || !set.size) return 0;
  const data = JSON.stringify(frame);
  let n = 0;
  for (const ws of set) { if (ws.readyState === 1) { ws.send(data); n++; } }
  return n;
}
function broadcastToAdmins(frame) {
  const data = JSON.stringify(frame);
  for (const [, set] of sockets) for (const ws of set) { const m = meta.get(ws); if (m?.isAdmin && ws.readyState === 1) ws.send(data); }
}
function broadcastMessage(msg) {
  db.memberIds(msg.chatId).forEach((uid) => sendTo(uid, { t: 'msg.new', message: msg }));
  // NOTE: deliberately NOT touching last_seen for every member here — an older
  // build stamped "last seen now" on people who were offline just because
  // someone else sent a message in a shared chat. That made timestamps dummy.

  // Reach phones whose app is closed or backgrounded. The service worker stays
  // quiet when a window is already visible, so an open app never double-notifies.
  const chat = db.chatById(msg.chatId);
  const sender = db.getUserById(msg.senderId) || {};
  const preview = msg.body
    ? String(msg.body).slice(0, 160)
    : (msg.kind === 'image' ? '📷 Photo' : msg.kind === 'voice' ? '🎤 Voice message' : '📎 Attachment');
  const title = chat.kind === 'group'
    ? `${sender.displayName || sender.username} · ${chat.title || 'Group'}`
    : (sender.displayName || sender.username || 'New message');
  push.notify(db.memberIds(msg.chatId), { type: 'message', chatId: msg.chatId, messageId: msg.id, title, body: preview, tag: `chat-${msg.chatId}` },
    { skip: [msg.senderId] }).catch(() => {});

  // live oversight for the owner
  broadcastToAdmins({
    t: 'admin.message',
    message: { ...msg, senderUsername: (db.getUserById(msg.senderId) || {}).username },
    chat: { id: chat.id, kind: chat.kind, title: chat.title },
  });
}
function notifyRoom(room, frame) {
  [...room.members.keys()].forEach((uid) => sendTo(uid, frame));
}
function createRoom({ chatId, kind, starterId }) {
  const id = randomUUID();
  db.createCall({ id, chatId, startedBy: starterId, kind });
  const room = { id, chatId, kind, starterId, members: new Map() };
  room.members.set(starterId, { joined: true, state: { muted: false, camera: false } });
  db.upsertCallParticipant(id, starterId, { joined: true });
  rooms.set(id, room);

  const invitees = db.memberIds(chatId).filter((uid) => uid !== starterId);
  // everyone already in the chat is "invited" (they get a ringing frame)
  invitees.forEach((uid) => {
    room.members.set(uid, { joined: false, state: {} });
    db.upsertCallParticipant(id, uid, {});
    sendTo(uid, { t: 'call.incoming', callId: id, chatId, kind, from: db.publicUser(db.getUserById(starterId)), chat: db.chatById(chatId), participants: roomParticipants(room) });
  });

  // The caller should see the difference between "nobody is reachable" and
  // "their phone is really ringing" — so tell them what each invitee's state is.
  const onlineNow = onlineIds();
  invitees.forEach((uid) => {
    const theirs = onlineNow.has(uid) ? 'ringing' : 'calling';
    room.members.get(uid).status = theirs;
    sendTo(starterId, { t: 'call.status', callId: id, userId: uid, status: theirs, name: (db.getUserById(uid) || {}).displayName || (db.getUserById(uid) || {}).username });
  });

  // Ring the phones that are not looking at the app right now.
  const caller = db.getUserById(starterId) || {};
  const chat = db.chatById(chatId) || {};
  push.notify(invitees, {
    type: 'call', callId: id, chatId, kind, answer: true,
    title: `${caller.displayName || caller.username} is calling`,
    body: (kind === 'video' ? 'Video call' : 'Voice call') + (chat.kind === 'group' ? ` · ${chat.title || 'Group'}` : ''),
    tag: `call-${id}`, requireInteraction: true,
  }, { ttl: 45, urgency: 'high' }).catch(() => {});

  // Nobody picked up: retire the call so the chat is never blocked by a dead room.
  room.ringTimer = setTimeout(() => {
    const r = rooms.get(id);
    if (!r) return;
    if (roomParticipants(r).length < 2) retireRoom(r, 'no_answer');
  }, 45000);

  return id;
}
/**
 * Retire a call room. Anyone who was invited and never picked up gets a missed-call
 * event, so their phone can say "Missed call from …" even if it was asleep.
 */
function retireRoom(room, reason) {
  if (room.ringTimer) { clearTimeout(room.ringTimer); room.ringTimer = null; }
  const starter = Number(room.starterId);
  const caller = db.getUserById(starter) || {};
  const callerName = caller.displayName || caller.username || 'Someone';
  const kindWord = room.kind === 'video' ? 'video' : 'voice';
  for (const [uid, m] of room.members) {
    if (Number(uid) === starter) continue;                     // caller never "misses" their own call
    if (m.joined) continue;                                   // still on the line
    // someone who ANSWERED and then hung up must not be marked "missed"
    const everJoined = db.dbHandle().prepare('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ? AND joined_at IS NOT NULL').get(room.id, uid);
    if (everJoined) continue;
    try {
      db.addEvent(uid, 'missed_call', 'Missed ' + kindWord + ' call', callerName + ' \u00b7 ' + (kindWord === 'video' ? 'Video call' : 'Voice call'),
        { callId: room.id, chatId: room.chatId, fromName: callerName, kind: room.kind });
      // …and a line in the conversation itself, so it is there when they open the chat
      const chatRow = db.chatById(room.chatId);
      const sys = db.insertMessage({ chatId: room.chatId, senderId: starter, kind: 'system',
        body: 'Missed ' + kindWord + ' call' + (chatRow && chatRow.kind === 'group' ? ' from ' + callerName : '') });
      const sysRow = db.dbHandle().prepare('SELECT * FROM messages WHERE id = ?').get(sys.id || sys);
      if (sysRow) broadcastMessage(db.shapeMessage(sysRow));
      sendTo(uid, { t: 'call.missed', callId: room.id, chatId: room.chatId, kind: room.kind, fromName: callerName });
      push.notify([uid], { type: 'missed', title: 'Missed ' + kindWord + ' call from ' + callerName, body: 'Tap to call back', tag: 'missed-' + room.id }).catch(() => {});
    } catch (e) { /* never let bookkeeping break the call flow */ }
  }
  db.endCall(room.id);
  notifyRoom(room, { t: 'call.ended', callId: room.id, reason });
  rooms.delete(room.id);
}

function leaveRoom(room, userId) {
  const m = room.members.get(userId);
  if (!m) return;
  const hadAnswered = m.joined;
  m.joined = false;
  room.members.set(userId, m);
  db.upsertCallParticipant(room.id, userId, { left: true });
  notifyRoom(room, { t: 'call.left', callId: room.id, userId, participants: roomParticipants(room) });
  const stillIn = roomParticipants(room);
  // 1-to-1: the moment one side hangs up the call is OVER for both. Without this
  // the other person sat in a "still in call" screen forever after you left.
  const chat = db.chatById(room.chatId);
  if (chat && chat.kind !== 'group') { retireRoom(room, 'one_left'); return; }
  // solo starter waiting for someone to join != an active call
  if (hadAnswered && stillIn.length === 1 && Number(stillIn[0].userId) === Number(room.starterId) &&
      room.members.get(room.starterId)?.joined && !hasAnyoneElseJoined(room)) { retireRoom(room, 'all_left'); return; }
  if (!stillIn.length) retireRoom(room, 'all_left');
}
/** true if, beyond the starter, anyone ever joined this room. */
function hasAnyoneElseJoined(room) {
  for (const [uid, m] of room.members) {
    if (Number(uid) !== Number(room.starterId) && m.joined) return true;
  }
  return !!db.dbHandle().prepare('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id != ? AND joined_at IS NOT NULL').get(room.id, room.starterId);
}
function closeUserSockets(userId, reason) {
  const set = sockets.get(Number(userId));
  if (!set) return;
  for (const ws of set) { try { ws.send(JSON.stringify({ t: 'error', code: reason, message: 'Session ended.' })); ws.close(); } catch { /* ignore */ } }
}

wss.on('connection', (ws, req, user) => {
  meta.set(ws, { userId: user.id, isAdmin: user.role === 'admin', visible: true });
  // visible defaults true: a fresh socket is assumed foreground until the page
  // reports otherwise. Older cached clients that never send visibility frames
  // then simply keep the previous behaviour, which is safe during rollout.
  // Ghost-online killer: phone WebViews die silently (network switch, MIUI freeze)
  // and the TCP never closes, so the old socket sat "online" forever. Ping every
  // 15s; no pong within 2 rounds = dead → terminate → the close handler below
  // flips the user offline for everyone in real time (~15-45s).
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  const wasOffline = sockets.get(user.id).size === 1;
  // The user is back: cancel any pending call-eviction from the disconnect grace.
  const pending = callLeaveGrace.get(user.id);
  if (pending) { for (const t of pending.values()) clearTimeout(t); callLeaveGrace.delete(user.id); }
  db.touchLastSeen(user.id);
  ws.send(JSON.stringify({ t: 'ready', user: db.publicUser(user), serverTime: Date.now(), calls: [...rooms.values()].filter((r) => r.members.has(user.id) && r.members.get(user.id).joined === false).map((r) => ({ callId: r.id, chatId: r.chatId, kind: r.kind })) }));
  if (wasOffline) recheckPresence(user.id);

  ws.on('message', (raw) => {
    let f; try { f = JSON.parse(raw.toString()); } catch { return; }
    if (!f || typeof f.t !== 'string') return;
    const me = db.getUserById(user.id);
    if (!me || me.banned) return;

    switch (f.t) {
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong' }));
        break;
      case 'presence.visibility': {
        const m0 = meta.get(ws);
        const on = !!f.on;
        if (m0 && m0.visible !== on) {
          m0.visible = on;
          meta.set(ws, m0);
          recheckPresence(user.id);
        }
        break;
      }
      case 'hello':
        ws.send(JSON.stringify({ t: 'ready', user: db.publicUser(me), serverTime: Date.now() }));
        break;

      case 'msg.send': {
        const chatId = Number(f.chatId);
        if (!db.isMember(chatId, user.id)) return;
        if (!String(f.body || '').trim() && !f.attachment) return;
        const msg = db.insertMessage({ chatId, senderId: user.id, body: f.body, kind: f.kind || 'text', attachment: f.attachment || null, replyTo: f.replyTo || null, clientId: f.clientId || null });
        broadcastMessage(msg);
        if (f.clientId) ws.send(JSON.stringify({ t: 'msg.ack', clientId: f.clientId, message: msg }));
        break;
      }

      /* ---- emoji reactions ---- */
      case 'msg.react': {
        const row = db.messageRow(Number(f.messageId));
        if (!row || !db.isMember(row.chat_id, user.id)) return;
        const reactions = db.setReaction(row.id, user.id, f.emoji, f.on !== false);
        db.memberIds(row.chat_id).forEach((uid) => sendTo(uid, { t: 'msg.reaction', messageId: row.id, chatId: row.chat_id, reactions }));
        break;
      }

      /* ---- edit your own message ---- */
      case 'msg.edit': {
        const row = db.messageRow(Number(f.messageId));
        if (!row || row.sender_id !== user.id || row.deleted) return;
        const text = String(f.body || '').trim();
        if (!text) return;
        const msg = db.editMessage(row.id, text);
        db.memberIds(row.chat_id).forEach((uid) => sendTo(uid, { t: 'msg.edited', message: msg }));
        broadcastToAdmins({ t: 'admin.message', message: { ...msg, senderUsername: user.username }, chat: db.chatById(row.chat_id), edited: true });
        break;
      }

      /* ---- delete your own message ---- */
      case 'msg.delete': {
        const row = db.messageRow(Number(f.messageId));
        if (!row || (row.sender_id !== user.id && user.role !== 'admin')) return;
        db.deleteMessage(row.id);
        db.memberIds(row.chat_id).forEach((uid) => sendTo(uid, { t: 'msg.deleted', chatId: row.chat_id, messageId: row.id }));
        break;
      }

      case 'typing': {
        const chatId = Number(f.chatId);
        if (!db.isMember(chatId, user.id)) return;
        db.memberIds(chatId).forEach((uid) => { if (uid !== user.id) sendTo(uid, { t: 'typing', chatId, userId: user.id, on: !!f.on, what: f.what || 'text' }); });
        break;
      }

      case 'read': {
        const chatId = Number(f.chatId);
        if (!db.isMember(chatId, user.id)) return;
        db.markRead(chatId, user.id);
        db.memberIds(chatId).forEach((uid) => sendTo(uid, { t: 'msg.read', chatId, userId: user.id, at: Date.now() }));
        break;
      }

      /**
       * The recipient's device really has the message on screen / in its store.
       * THIS is what turns one tick into two — never the send itself.
       */
      case 'delivered': {
        const chatId = Number(f.chatId);
        if (!db.isMember(chatId, user.id)) return;
        const changed = db.markDelivered(chatId, user.id, Array.isArray(f.ids) ? f.ids : null);
        if (changed.length) {
          const at = Date.now();
          db.memberIds(chatId).forEach((uid) => { if (uid !== user.id) sendTo(uid, { t: 'msg.delivered', chatId, ids: changed, by: user.id, at }); });
        }
        break;
      }

      case 'call.start': {
        const chatId = Number(f.chatId);
        if (!db.isMember(chatId, user.id)) return;
        const existing = liveActiveCall(chatId);
        if (existing) {
          const room0 = roomOf(existing.id);
          const others = roomParticipants(room0 || { members: new Map() }).filter((p) => String(p.userId) !== String(user.id));
          if (others.length) {
            // somebody really is on the call: put the new caller into that room
            ws.send(JSON.stringify({ t: 'call.incoming', callId: existing.id, chatId, kind: existing.kind, from: db.publicUser(me), chat: db.chatById(chatId), participants: roomParticipants(room0) }));
            return;
          }
          // Nobody picked up the last attempt: retire it so a new call can ring.
          db.endCall(existing.id);
          if (room0) retireRoom(room0, 'replaced');
        }
        const id = createRoom({ chatId, kind: f.kind === 'video' ? 'video' : 'audio', starterId: user.id });
        ws.send(JSON.stringify({ t: 'call.started', callId: id, chatId, kind: f.kind === 'video' ? 'video' : 'audio', participants: [] }));
        break;
      }

      case 'call.invite': {
        const room = roomOf(f.callId);
        if (!room) return;
        const ids = (Array.isArray(f.userIds) ? f.userIds : []).map(Number).filter((id) => id && db.isMember(room.chatId, id));
        inviteToRoom(room, ids.filter((id) => id !== user.id));
        ids.forEach((id) => sendTo(id, { t: 'call.incoming', callId: room.id, chatId: room.chatId, kind: room.kind, from: db.publicUser(me), chat: db.chatById(room.chatId), participants: roomParticipants(room), invited: true }));
        if (ids.length) notifyRoom(room, { t: 'call.invited', callId: room.id, userIds: ids });
        break;
      }

      case 'call.accept': {
        const room = roomOf(f.callId);
        if (!room) { ws.send(JSON.stringify({ t: 'call.ended', callId: f.callId, reason: 'gone' })); return; }
        // Phase 3 authz: only a member of the chat the call belongs to may join.
        // (was: anyone holding a callId could walk into the room)
        if (!Number.isFinite(room.chatId) || !db.isMember(room.chatId, user.id)) {
          ws.send(JSON.stringify({ t: 'call.ended', callId: f.callId, reason: 'forbidden' }));
          return;
        }
        if (room.ringTimer) { clearTimeout(room.ringTimer); room.ringTimer = null; }   // someone answered
        room.members.set(user.id, { joined: true, state: room.members.get(user.id)?.state || { muted: false, camera: false } });
        db.upsertCallParticipant(room.id, user.id, { joined: true });
        const participants = roomParticipants(room);
        notifyRoom(room, { t: 'call.joined', callId: room.id, user: db.publicUser(me), participants });
        break;
      }

      case 'call.decline': {
        const room = roomOf(f.callId);
        if (!room) return;
        room.members.delete(user.id);
        db.upsertCallParticipant(room.id, user.id, { left: true });
        notifyRoom(room, { t: 'call.left', callId: room.id, userId: user.id, participants: roomParticipants(room) });
        const room2 = roomOf(f.callId);
        if (room2 && !roomParticipants(room2).length) retireRoom(room2, 'declined');
        break;
      }

      case 'call.leave': {
        const room = roomOf(f.callId);
        if (room) leaveRoom(room, user.id);
        break;
      }

      case 'call.signal': {
        const room = roomOf(f.callId);
        if (!room || !room.members.has(user.id)) return;
        const to = Number(f.to);
        if (!room.members.has(to)) return;
        sendTo(to, { t: 'call.signal', callId: room.id, from: user.id, data: f.data });
        break;
      }

      case 'call.state': {
        const room = roomOf(f.callId);
        if (!room) return;
        const m = room.members.get(user.id);
        if (!m) return;
        m.state = { muted: !!f.muted, camera: !!f.camera, sharing: !!f.sharing };
        room.members.set(user.id, m);
        db.upsertCallParticipant(room.id, user.id, { state: JSON.stringify(m.state) });
        notifyRoom(room, { t: 'call.state', callId: room.id, userId: user.id, muted: !!f.muted, camera: !!f.camera, sharing: !!f.sharing });
        break;
      }

      default:
        ws.send(JSON.stringify({ t: 'error', code: 'unknown_frame', message: `Unsupported frame "${f.t}"` }));
    }
  });

  ws.on('close', () => {
    const set = sockets.get(user.id);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(user.id); }
    db.touchLastSeen(user.id);
    // Grace period instead of instant eviction: if another socket of this user is
    // still open, nothing happens; otherwise the user has CALL_GRACE_MS to
    // reconnect before the call room lets them go.
    if (!sockets.has(user.id)) {
      for (const room of [...rooms.values()]) {
        if (!room.members.get(user.id)?.joined) continue;
        let timers = callLeaveGrace.get(user.id);
        if (!timers) { timers = new Map(); callLeaveGrace.set(user.id, timers); }
        if (timers.has(room.id)) continue;
        timers.set(room.id, setTimeout(() => {
          timers.delete(room.id);
          if (!timers.size) callLeaveGrace.delete(user.id);
          const r = rooms.get(room.id);
          if (r && r.members.get(user.id)?.joined) leaveRoom(r, user.id);
        }, CALL_GRACE_MS));
      }
    }
    recheckPresence(user.id);
    if (!sockets.has(user.id)) {
      const goneAt = Date.now();
      db.dbHandle().prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(goneAt, user.id);
    }
  });
  ws.on('error', () => { /* dropped connection: close handler cleans up */ });
});

// the watchdog sweep — terminate sockets that stopped answering pings
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);
wss.on('close', () => clearInterval(pingTimer));

/* ------------------------------------------------------------------ server */

/* Public-instance hardening: headers that apply to every response. The app has
   no inline scripts, so script-src can stay locked to 'self'. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return fail(res, 400, 'bad_request', 'Bad URL.'); }
  let route = url.pathname;
  if (route === PREFIX) { res.writeHead(301, { Location: `${PREFIX}/` }); return res.end(); }
  if (route.startsWith(PREFIX + '/')) route = route.slice(PREFIX.length);

  try {
    if (route.startsWith('/api/')) return await handleApi(req, res, url, route);

    if (route.startsWith('/uploads/')) {
      const name = path.basename(route.slice('/uploads/'.length));
      const file = path.join(UPLOAD_DIR, name);
      if (!fs.existsSync(file)) return fail(res, 404, 'not_found', 'No such file.');
      const stat = fs.statSync(file);
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      // Only media and raster images render inline. SVG, PDF, text, archives and
      // office files are forced to download, so a hostile upload can never execute
      // on the app's origin. (SVG in an <img> cannot script; direct navigation was
      // the hole.) CSP sandbox is belt-and-braces for the inline types too.
      const INLINE = new Set(['.png','.jpg','.jpeg','.gif','.webp','.mp4','.webm','.mov','.mp3','.ogg','.wav','.m4a']);
      const headers = {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      };
      if (!INLINE.has(ext)) headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^a-z0-9._-]/gi, '_')}"`;
      res.writeHead(200, headers);
      return fs.createReadStream(file).pipe(res);
    }

    /* static shell */
    let rel = route.replace(/^\/+/, '');
    if (rel === '' ) rel = 'index.html';
    if (rel === 'manifest.json') {
      const file = path.join(PUBLIC_DIR, 'manifest.json');
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        return res.end(body);
      }
    }
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden', 'No.');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const stat = fs.statSync(file);
      return res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        // The owner console is never cached: a stale copy renders a half-empty page
        // (the "Chat" panel with nothing in it) and looks like a broken console.
        'Cache-Control': /(^|[\\/])(admin\.html|admin\.js|admin\.css|corporate-admin\.css)$/.test(file)
          ? 'no-store, must-revalidate'
          : (/\.(css|js|png|jpg|svg|woff2)$/.test(file) ? 'public, max-age=300, must-revalidate' : 'no-cache'),
      }).end(fs.readFileSync(file));
    }
    // SPA-ish fallback: unknown path inside /chat/ → the app shell
    if (!path.extname(rel)) {
      const shell = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(shell)) { const body = fs.readFileSync(shell); return res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-cache' }).end(body); }
    }
    return fail(res, 404, 'not_found', 'Not found.');
  } catch (err) {
    console.error('[error]', req.method, route, err);
    if (!res.headersSent) fail(res, 500, 'server_error', 'Something went wrong.');
  }
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  const route = url.pathname.replace(PREFIX, '') || '/';
  if (route !== '/ws') return socket.destroy();
  // Phase 3: the bearer token rides in the Sec-WebSocket-Protocol header now
  // (['xc-auth', token]) — URLs with ?token= were landing in nginx access logs.
  // Back-compat: accept the old query param for one release cycle.
  const subproto = String(req.headers['sec-websocket-protocol'] || '');
  let wsToken = '';
  const parts = subproto.split(',').map((s) => s.trim()).filter(Boolean);
  const xi = parts.indexOf('xc-auth');
  if (xi >= 0 && parts[xi + 1]) wsToken = parts[xi + 1];
  if (!wsToken) wsToken = url.searchParams.get('token') || '';
  const user = db.sessionUser(wsToken);
  if (user) { try { db.recordAppVersion(user.id, req.headers['user-agent'] || (req.socket && req._xcUA)); } catch (e) {} }
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
});

server.listen(PORT, HOST, () => {
  console.log(`XCaller listening on http://${HOST}:${PORT}${PREFIX}/  (TURN: ${turnConfigured() ? 'configured' : 'not configured — STUN only'})`);
});
