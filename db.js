/**
 * XCaller — data layer.
 *
 * Node's built-in SQLite (node:sqlite) so there is no native module to build.
 * Everything the app knows lives in one file: data/jarvis-chat.db
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.XC_DATA_DIR
  ? path.resolve(process.env.XC_DATA_DIR)
  : path.join(import.meta.dirname, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'jarvis-chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  avatar_color  TEXT DEFAULT '#5288c1',
  pw_hash       TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('direct','group')),
  title      TEXT DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  dm_key     TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  role         TEXT DEFAULT 'member',
  last_read_at INTEGER DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'text',
  attachment_path TEXT,
  attachment_name TEXT,
  attachment_mime TEXT,
  attachment_size INTEGER,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted         INTEGER NOT NULL DEFAULT 0,
  client_id       TEXT
);
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  started_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'audio',
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER,
  left_at   INTEGER,
  state     TEXT,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  title   TEXT DEFAULT '',
  body    TEXT DEFAULT '',
  extra   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses   INTEGER NOT NULL DEFAULT 0,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_chat ON invites(chat_id);
`);

/* Column added after the first release: replies/quotes. Guarded so boot is idempotent. */
const messageCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!messageCols.includes('reply_to')) {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  console.log('[db] added messages.reply_to (quoted replies)');
}
/* Delivery receipts: sent → delivered → read, WhatsApp style. */
if (!messageCols.includes('delivered_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN delivered_at INTEGER');
  console.log('[db] added messages.delivered_at (delivery ticks)');
}

const memberCols = db.prepare('PRAGMA table_info(chat_members)').all().map((c) => c.name);
if (!memberCols.includes('hidden')) {
  db.exec('ALTER TABLE chat_members ADD COLUMN hidden INTEGER DEFAULT 0');
  console.log('[db] added chat_members.hidden (delete chat)');
}

const chatCols = db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
if (!chatCols.includes('hide_members')) {
  db.exec('ALTER TABLE chats ADD COLUMN hide_members INTEGER DEFAULT 0');
  console.log('[db] added chats.hide_members (owner can hide the member list)');
}
if (!messageCols.includes('forwarded_from')) {
  db.exec('ALTER TABLE messages ADD COLUMN forwarded_from TEXT');
  console.log('[db] added messages.forwarded_from (forwarded messages)');
}
/* Client-generated id: lets a retried send de-duplicate instead of double-posting. */
if (!messageCols.includes('client_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  console.log('[db] added messages.client_id (send de-duplication)');
}

/* Sessions never expire: you stay logged in until you press Log out. */
const SESSION_MS = 100 * 365 * 24 * 3600e3;

// Sessions never expire any more: push every existing one out to "forever" so
// people who are already logged in never have to log in again.
try {
  const far = Date.now() + SESSION_MS;
  const info = db.prepare('UPDATE sessions SET expires_at = ? WHERE expires_at < ?').run(far, far);
  if (info.changes) console.log(`[db] ${info.changes} session(s) now never expire`);
} catch (e) { /* sessions table not there yet on a brand-new install */ }

/* ------------------------------------------------------------------ users */

export const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'jarvis', 'system', 'support']);
const COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(password), salt, 64).toString('hex') };
}
export function verifyPassword(password, salt, hash) {
  const got = scryptSync(String(password), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
export function validUsername(u) { return typeof u === 'string' && /^[a-z0-9_]{3,20}$/.test(u); }

export function createUser({ username, password, displayName }) {
  const { salt, hash } = hashPassword(password);
  const now = Date.now();
  const color = COLORS[createHash('sha1').update(username).digest()[0] % COLORS.length];
  const info = db.prepare(`INSERT INTO users (username, display_name, pw_hash, pw_salt, role, created_at, last_seen, avatar_color)
                           VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`)
    .run(username, (displayName || username).slice(0, 60), hash, salt, now, now, color);
  return getUserById(Number(info.lastInsertRowid));
}
export function getUserById(id) {
  return db.prepare(`SELECT id, username, display_name AS displayName, bio, avatar_color AS avatarColor,
                            role, banned, created_at AS createdAt, last_seen AS lastSeen
                     FROM users WHERE id = ?`).get(id) || null;
}
/** Full row incl. password fields — internal use only (password-change check). */
export function getUserCredentials(id) {
  return db.prepare('SELECT id, username, pw_hash, pw_salt FROM users WHERE id = ?').get(id) || null;
}
export function getUserRow(username) { return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null; }
export function findByUsername(username) { return getUserRow(username); }
export function touchLastSeen(id) { db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), id); }

/* Which app build each user is on (from the XCallerApp/x.y UA on any API call). */
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('app_version')) {
  db.exec('ALTER TABLE users ADD COLUMN app_version TEXT');
  db.exec('ALTER TABLE users ADD COLUMN app_version_at INTEGER');
  console.log('[db] added users.app_version (per-user app build tracking)');
}
let _lastAppVersion = ['', 0];
export function recordAppVersion(id, ua) {
  const m = /XCallerApp\/([0-9][0-9.]*)/i.exec(String(ua || ''));
  const now = Date.now();
  if (m) {
    // the installed app is the version that matters — always record it
    const key = id + '|' + m[1];
    if (_lastAppVersion[0] === key && now - _lastAppVersion[1] < 600000) return; // throttled
    _lastAppVersion = [key, now];
    db.prepare('UPDATE users SET app_version = ?, app_version_at = ? WHERE id = ?').run(m[1], now, id);
    return;
  }
  // browser/PWA: only fills the blank, never overwrites a real app version
  if (!browserRe.test(String(ua || ''))) return;
  const cur = db.prepare('SELECT app_version AS v FROM users WHERE id = ?').get(id);
  if (cur && cur.v) return;
  db.prepare('UPDATE users SET app_version = ?, app_version_at = ? WHERE id = ?').run('web', now, id);
}
const browserRe = /(Android|iPhone|iPad|Macintosh|Windows)/i;
export function updateProfile(id, { displayName, bio }) {
  if (typeof displayName === 'string' && displayName.trim()) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName.trim().slice(0, 60), id);
  }
  if (typeof bio === 'string') db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio.slice(0, 300), id);
  return getUserById(id);
}
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.displayName ?? u.display_name,
    bio: u.bio ?? '', avatarColor: u.avatarColor ?? u.avatar_color, role: u.role,
    createdAt: u.createdAt ?? u.created_at, lastSeen: u.lastSeen ?? u.last_seen,
  };
}
export function searchUsers(q, excludeId) {
  const like = `%${String(q || '').toLowerCase()}%`;
  return db.prepare(`SELECT id, username, display_name AS displayName, avatar_color AS avatarColor, role, last_seen AS lastSeen
                     FROM users WHERE banned = 0 AND id != ? AND (lower(username) LIKE ? OR lower(display_name) LIKE ?)
                     ORDER BY username LIMIT 50`).all(excludeId ?? 0, like, like);
}
export function allUsers() {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.role, u.banned,
           u.created_at AS createdAt, u.last_seen AS lastSeen, u.avatar_color AS avatarColor,
           u.app_version AS appVersion, u.app_version_at AS appVersionAt,
           (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS messageCount,
           (SELECT COUNT(*) FROM chat_members cm WHERE cm.user_id = u.id) AS chatCount
    FROM users u ORDER BY u.id`).all();
}
export function setBanned(id, banned) { db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id); }
export function setRole(id, role) { db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', id); }

/* --------------------------------------------------------------- sessions */

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  // One-device policy (Phase 3): a fresh sign-in retires every older session of
  // this user. Deliberate — new device wins, nothing is silently multi-logged-in.
  const kicked = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, token);
  if (kicked.changes) console.log(`[auth] one-device: retired ${kicked.changes} older session(s) of user ${userId}`);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_MS);
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  const user = getUserById(row.user_id);
  if (!user || user.banned) return null;
  return user;
}
export function deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
/** Housekeeping only: with never-expiring sessions this normally deletes nothing. */
export function purgeSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

/* ------------------------------------------------------------------ chats */

export function dmKey(a, b) { return [Number(a), Number(b)].sort((x, y) => x - y).join(':'); }

export function createDirect(a, b) {
  const key = dmKey(a, b);
  const found = db.prepare('SELECT * FROM chats WHERE dm_key = ?').get(key);
  if (found) {
    // Re-adding a person whose chat you deleted must bring it back (Phase 4 fix):
    // the chat row still exists but hidden=1 made it vanish — unhide for both sides.
    db.prepare('UPDATE chat_members SET hidden = 0 WHERE chat_id = ?').run(found.id);
    return found.id;
  }
  const now = Date.now();
  const info = db.prepare(`INSERT INTO chats (kind, title, created_by, created_at, dm_key) VALUES ('direct','',?,?,?)`)
    .run(a, now, key);
  const id = Number(info.lastInsertRowid);
  addMember(id, a); addMember(id, b);
  return id;
}
export function createGroup(creatorId, memberIds, title) {
  const now = Date.now();
  const info = db.prepare(`INSERT INTO chats (kind, title, created_by, created_at) VALUES ('group',?,?,?)`)
    .run(String(title || 'Group').slice(0, 80), creatorId, now);
  const id = Number(info.lastInsertRowid);
  addMember(id, creatorId, 'owner');
  memberIds.forEach((m) => addMember(id, m));
  return id;
}
export function addMember(chatId, userId, role = 'member') {
  db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at, role, last_read_at) VALUES (?,?,?,?,0)')
    .run(chatId, userId, Date.now(), role);
}

/** "Delete chat": hide it for me only. Nobody else loses anything. */
export function hideChat(chatId, userId) {
  db.prepare('UPDATE chat_members SET hidden = 1 WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}
/** Any new message brings a hidden chat back for everyone in it. */
export function unhideChat(chatId) {
  db.prepare('UPDATE chat_members SET hidden = 0 WHERE chat_id = ?').run(chatId);
}
/** Leave a group for good. */
export function leaveChat(chatId, userId) {
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}

/* --------------------------------------------------------- group owners --- */

/** Who owns this group (the member row marked owner, else whoever created it). */
export function chatOwnerId(chatId) {
  const row = db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'owner'").get(chatId);
  if (row) return row.user_id;
  const chat = db.prepare('SELECT created_by FROM chats WHERE id = ?').get(chatId);
  return chat ? chat.created_by : null;
}
export function isOwner(chatId, userId) {
  return String(chatOwnerId(chatId)) === String(userId);
}
export function setHideMembers(chatId, on) {
  db.prepare('UPDATE chats SET hide_members = ? WHERE id = ?').run(on ? 1 : 0, chatId);
}
export function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}
export function chatById(id) { return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null; }
export function chatMembers(chatId) {
  return db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.avatar_color AS avatarColor, u.role, u.last_seen AS lastSeen
                     FROM chat_members cm JOIN users u ON u.id = cm.user_id
                     WHERE cm.chat_id = ? ORDER BY cm.joined_at`).all(chatId);
}
export function memberIds(chatId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((r) => r.user_id);
}
/** Everyone who shares at least one chat with this user (for presence broadcasts). */
export function chatMemberIdsOf(userId) {
  return db.prepare(`
    SELECT DISTINCT other.user_id AS id FROM chat_members mine
    JOIN chat_members other ON other.chat_id = mine.chat_id
    WHERE mine.user_id = ? AND other.user_id != ?`).all(userId, userId).map((r) => r.id);
}
export function lastMessage(chatId) {
  const m = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1').get(chatId);
  return m ? shapeMessage(m) : null;
}
export function unreadCount(chatId, userId) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM messages m
                          JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
                          WHERE m.chat_id = ? AND m.sender_id != ? AND m.deleted = 0
                            AND m.created_at > cm.last_read_at`).get(userId, chatId, userId);
  return row ? row.n : 0;
}
export function chatList(userId) {
  const rows = db.prepare(`SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
                           WHERE cm.user_id = ? AND COALESCE(cm.hidden,0) = 0`).all(userId);
  const list = rows.map((c) => {
    const last = lastMessage(c.id);
    const allMembers = chatMembers(c.id);
    const ownerId = chatOwnerId(c.id);
    // "hide the member list": everyone but the owner only sees themselves
    const hideMembers = c.kind === 'group' && !!c.hide_members && String(ownerId) !== String(userId);
    return {
      id: c.id, kind: c.kind, title: c.title, createdAt: c.created_at,
      ownerId, hideMembers, memberCount: allMembers.length,
      members: hideMembers ? allMembers.filter((m) => String(m.id) === String(userId)) : allMembers,
      lastMessage: last, unread: unreadCount(c.id, userId),
      updatedAt: last ? last.createdAt : c.created_at,
    };
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}
export function allChats() {
  const rows = db.prepare('SELECT * FROM chats ORDER BY id').all();
  return rows.map((c) => {
    const last = lastMessage(c.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND deleted = 0').get(c.id).n;
    return {
      id: c.id, kind: c.kind, title: c.title, createdAt: c.created_at, dmKey: c.dm_key,
      members: chatMembers(c.id), messageCount: count, lastMessage: last,
      lastActivity: last ? last.createdAt : c.created_at,
    };
  });
}
export function markRead(chatId, userId) {
  db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?').run(Date.now(), chatId, userId);
}
/**
 * Mark messages of *other* people in this chat as delivered to this user.
 * Returns the ids that changed, so the sender's ticks can go from ✓ to ✓✓.
 */
export function markDelivered(chatId, userId, ids = null) {
  const at = Date.now();
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const marks = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id FROM messages WHERE chat_id = ? AND sender_id != ? AND delivered_at IS NULL AND deleted = 0 AND id IN (${marks})`)
      .all(chatId, userId, ...ids.map(Number));
  } else {
    rows = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND sender_id != ? AND delivered_at IS NULL AND deleted = 0')
      .all(chatId, userId);
  }
  if (!rows.length) return [];
  const changed = rows.map((r) => r.id);
  const marks = changed.map(() => '?').join(',');
  db.prepare(`UPDATE messages SET delivered_at = ? WHERE id IN (${marks})`).run(at, ...changed);
  return changed;
}

/* --------------------------------------------------------------- messages */

export function shapeMessage(m) {
  if (!m) return null;
  return {
    id: m.id, chatId: m.chat_id, senderId: m.sender_id, body: m.body, kind: m.kind,
    createdAt: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted,
    deliveredAt: m.delivered_at || null,
    forwardedFrom: m.forwarded_from || null,
    replyTo: m.reply_to || null,
    quote: m.reply_to ? quoteFor(m.reply_to) : null,
    reactions: m.__reactions || reactionsFor(m.id),
    attachment: m.attachment_path ? {
      path: m.attachment_path, name: m.attachment_name, mime: m.attachment_mime, size: m.attachment_size,
    } : null,
  };
}

/* --------------------------------------------------- phone event queue */

/** Something that happened while the user was away: a missed call, a new version… */
export function addEvent(userId, kind, title, body, extra) {
  db.prepare('INSERT INTO events (user_id, ts, kind, title, body, extra) VALUES (?,?,?,?,?,?)')
    .run(Number(userId), Date.now(), String(kind), title || '', body || '', extra ? JSON.stringify(extra) : null);
}

/** Everything queued in the last `sinceMs`. The phone remembers what it has shown. */
export function eventsFor(userId, sinceMs) {
  const rows = db.prepare('SELECT id, ts, kind, title, body, extra FROM events WHERE user_id = ? AND ts > ? ORDER BY id DESC LIMIT 30')
    .all(Number(userId), Date.now() - sinceMs);
  return rows.map((r) => ({ ...r, extra: r.extra ? safeJson(r.extra) : null }));
}

function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

/** The one-line preview a quoted reply shows. */
/* ------------------------------------------------------------ invite links */

/** A shareable link that puts whoever opens it into this group. */
export function createInvite(chatId, userId, days = 30) {
  const token = randomBytes(9).toString('base64url');
  const now = Date.now();
  const expires = now + Math.max(1, Math.min(365, Number(days) || 30)) * 24 * 3600e3;
  db.prepare('INSERT INTO invites (token, chat_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(token, Number(chatId), Number(userId), now, expires);
  return inviteByToken(token);
}

export function inviteByToken(token) {
  if (!token) return null;
  const r = db.prepare('SELECT * FROM invites WHERE token = ?').get(String(token));
  if (!r) return null;
  const chat = chatById(r.chat_id);
  const inviter = getUserById(r.created_by);
  const expired = !!r.expires_at && Date.now() > r.expires_at;
  const usedUp = r.max_uses > 0 && r.uses >= r.max_uses;
  return {
    token: r.token, chatId: r.chat_id, createdBy: r.created_by, createdAt: r.created_at,
    expiresAt: r.expires_at, uses: r.uses, maxUses: r.max_uses,
    revoked: !!r.revoked, valid: !r.revoked && !expired && !usedUp,
    reason: r.revoked ? 'revoked' : expired ? 'expired' : usedUp ? 'used_up' : null,
    chatTitle: chat ? chat.title : '', chatKind: chat ? chat.kind : '',
    inviterName: inviter ? (inviter.display_name || inviter.username) : '',
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(r.chat_id).n,
  };
}

export function useInvite(token) {
  db.prepare('UPDATE invites SET uses = uses + 1 WHERE token = ?').run(String(token));
}

export function chatInvites(chatId) {
  return db.prepare('SELECT token, created_at AS createdAt, expires_at AS expiresAt, uses, revoked FROM invites WHERE chat_id = ? ORDER BY created_at DESC')
    .all(Number(chatId)).map((r) => ({ ...r, revoked: !!r.revoked, valid: !r.revoked && (!r.expiresAt || Date.now() < r.expiresAt) }));
}

export function revokeInvitesFor(chatId) {
  db.prepare('UPDATE invites SET revoked = 1 WHERE chat_id = ? AND revoked = 0').run(Number(chatId));
}

export function revokeInvite(token, userId) {
  db.prepare('UPDATE invites SET revoked = 1 WHERE token = ?').run(String(token));
}

export function quoteFor(messageId) {
  const m = db.prepare('SELECT m.id, m.body, m.kind, m.deleted, u.username, u.display_name AS displayName FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(messageId);
  if (!m) return null;
  return {
    id: m.id, sender: m.username, senderName: m.displayName,
    body: m.deleted ? '(deleted)' : (m.body || (m.kind === 'image' ? '📷 Photo' : m.kind === 'voice' ? '🎤 Voice message' : '📎 Attachment')).slice(0, 140),
  };
}

/** Reactions grouped per message: [{ emoji, count, users:[ids], me }]. */
export function reactionsFor(messageId, meId = 0) {
  const rows = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at').all(messageId);
  const byEmoji = new Map();
  rows.forEach((r) => {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  });
  return [...byEmoji.entries()].map(([emoji, users]) => ({ emoji, count: users.length, users, me: users.includes(Number(meId)) }));
}

/** Toggle one person's reaction. Returns the fresh grouped list for that message. */
export function setReaction(messageId, userId, emoji, on = true, meId = 0) {
  const clean = String(emoji || '').slice(0, 8);
  if (!clean) return reactionsFor(messageId, meId);
  if (on) db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(messageId, userId, clean, Date.now());
  else db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, clean);
  return reactionsFor(messageId, meId);
}

export function messageRow(id) { return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null; }

export function editMessage(id, body) {
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(String(body || '').slice(0, 8000), Date.now(), id);
  return getMessage(id);
}
export function insertMessage({ chatId, senderId, body, kind = 'text', attachment = null, replyTo = null, forwardedFrom = null, clientId = null }) {
  // Idempotent retries: the same (sender, clientId) within 10 min returns the original row —
  // double-tapped Send or a WS reconnect replay can never create duplicates.
  if (clientId) {
    const dupe = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND client_id = ? AND created_at > ?')
      .get(chatId, senderId, String(clientId), Date.now() - 600000);
    if (dupe) return getMessage(Number(dupe.id));
  }
  unhideChat(chatId);        // a new message brings a "deleted" chat back
  const info = db.prepare(`INSERT INTO messages (chat_id, sender_id, body, kind, attachment_path, attachment_name, attachment_mime, attachment_size, created_at, reply_to, forwarded_from, client_id)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, senderId, String(body || '').slice(0, 8000), kind,
      attachment?.path || null, attachment?.name || null, attachment?.mime || null, attachment?.size || null,
      Date.now(), replyTo ? Number(replyTo) : null, forwardedFrom ? String(forwardedFrom).slice(0, 120) : null, clientId ? String(clientId) : null);
  return getMessage(Number(info.lastInsertRowid));
}
export function getMessage(id) {
  return shapeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}
export function chatMessages(chatId, { before = 0, limit = 50, includeDeleted = false } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const del = includeDeleted ? '' : 'AND deleted = 0 ';
  const rows = before
    ? db.prepare(`SELECT * FROM messages WHERE chat_id = ? ${del}AND id < ? ORDER BY id DESC LIMIT ?`).all(chatId, before, lim)
    : db.prepare(`SELECT * FROM messages WHERE chat_id = ? ${del}ORDER BY id DESC LIMIT ?`).all(chatId, lim);
  return rows.reverse().map(shapeMessage);
}
export function deleteMessage(id) { db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(id); }
export function searchMessages({ q = '', userId = 0, chatId = 0, before = 0, limit = 100 }) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = ['m.deleted = 0'];
  const args = [];
  if (q) { where.push('lower(m.body) LIKE ?'); args.push(`%${String(q).toLowerCase()}%`); }
  if (userId) { where.push('m.sender_id = ?'); args.push(Number(userId)); }
  if (chatId) { where.push('m.chat_id = ?'); args.push(Number(chatId)); }
  if (before) { where.push('m.id < ?'); args.push(Number(before)); }
  args.push(lim);
  return db.prepare(`
    SELECT m.*, u.username AS senderUsername, u.display_name AS senderName,
           c.kind AS chatKind, c.title AS chatTitle
    FROM messages m JOIN users u ON u.id = m.sender_id JOIN chats c ON c.id = m.chat_id
    WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...args).map((m) => ({
    id: m.id, chatId: m.chat_id, chatKind: m.chat_kind || m.chatKind, chatTitle: m.chatTitle,
    senderId: m.sender_id, senderUsername: m.senderUsername, senderName: m.senderName,
    body: m.body, kind: m.kind, createdAt: m.created_at,
    attachment: m.attachment_path ? { path: m.attachment_path, name: m.attachment_name, mime: m.attachment_mime, size: m.attachment_size } : null,
  }));
}

/* ------------------------------------------------------------------ calls */

export function createCall({ id, chatId, startedBy, kind }) {
  const callId = id || randomUUID();
  db.prepare('INSERT INTO calls (id, chat_id, started_by, kind, started_at) VALUES (?,?,?,?,?)')
    .run(callId, chatId, startedBy, kind === 'video' ? 'video' : 'audio', Date.now());
  return callId;
}
export function callById(id) { return db.prepare('SELECT * FROM calls WHERE id = ?').get(id) || null; }
export function upsertCallParticipant(callId, userId, { joined = false, left = false, state = null } = {}) {
  const existing = db.prepare('SELECT * FROM call_participants WHERE call_id = ? AND user_id = ?').get(callId, userId);
  if (!existing) {
    db.prepare('INSERT INTO call_participants (call_id, user_id, joined_at, left_at, state) VALUES (?,?,?,?,?)')
      .run(callId, userId, joined ? Date.now() : null, null, state);
  } else {
    db.prepare('UPDATE call_participants SET joined_at = COALESCE(?, joined_at), left_at = ?, state = COALESCE(?, state) WHERE call_id = ? AND user_id = ?')
      .run(joined ? Date.now() : null, left ? Date.now() : null, state, callId, userId);
  }
}
export function callParticipants(callId) {
  return db.prepare(`SELECT cp.user_id, cp.joined_at, cp.left_at, cp.state, u.username, u.display_name AS displayName, u.avatar_color AS avatarColor
                     FROM call_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.call_id = ?`).all(callId);
}
export function endCall(id) { db.prepare('UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id); }

/** The still-open call in this chat, if any (the DB side of liveActiveCall). */
export function activeCallFor(chatId) {
  return db.prepare('SELECT * FROM calls WHERE chat_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(chatId) || null;
}

/** One user's own call history: direction, who, how long, answered or missed. */
export function userCalls(userId, limit = 100) {
  const rows = db.prepare(`
    SELECT c.*, ch.title AS chatTitle, ch.kind AS chatKind,
           u.username AS starterUsername, u.display_name AS starterName, u.avatar_color AS starterColor,
           cp.joined_at AS myJoinedAt, cp.left_at AS myLeftAt
      FROM calls c
      JOIN chats ch ON ch.id = c.chat_id
      JOIN chat_members cm ON cm.chat_id = c.chat_id AND cm.user_id = ?
      JOIN users u ON u.id = c.started_by
      LEFT JOIN call_participants cp ON cp.call_id = c.id AND cp.user_id = ?
     ORDER BY c.started_at DESC
     LIMIT ?`).all(userId, userId, Math.min(Number(limit) || 100, 300));

  return rows.map((c) => {
    const answered = !!c.myJoinedAt;
    // Duration = TALK time, not ring time. Talk starts when the last person
    // joins (both on the line) and stops at end. The old end-start counted the
    // ringing seconds too, which is why durations looked wrong. Missed/no-answer
    // rows show nothing at all.
    let durMs = 0;
    if (c.ended_at) {
      const joins = db.prepare('SELECT joined_at FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL').all(c.id).map((r) => r.joined_at);
      if (joins.length >= 2) {                        // real two-person talk; ringing alone = 0
        const talkStart = Math.max(c.started_at, ...joins);
        durMs = Math.max(0, c.ended_at - talkStart);
      }
    }
    return {
      id: c.id,
      chatId: c.chat_id,
      chatTitle: c.chatTitle,
      kind: c.kind,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      durationMs: durMs,
      outgoing: c.started_by === userId,
      answered,
      missed: c.started_by !== userId && !answered,
      peer: { id: c.started_by, username: c.starterUsername, displayName: c.starterName, avatarColor: c.starterColor },
      others: db.prepare(`SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ? AND user_id != ?`).get(c.id, userId).n,
    };
  });
}

export function callLog(limit = 200) {
  const calls = db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT ?').all(Math.min(Number(limit) || 200, 500));
  return calls.map((c) => {
    const parts = callParticipants(c.id);
    const joined = parts.filter((p) => p.joined_at);
    const end = c.ended_at || Math.max(...parts.map((p) => p.left_at || Date.now()), c.started_at);
    return {
      id: c.id, chatId: c.chat_id, kind: c.kind, startedAt: c.started_at, endedAt: c.ended_at,
      startedBy: c.started_by,
      starterUsername: (db.prepare('SELECT username FROM users WHERE id = ?').get(c.started_by) || {}).username,
      duration: Math.max(0, Math.round((end - c.started_at) / 1000)),
      inProgress: !c.ended_at,
      participants: parts.map((p) => ({ id: p.user_id, username: p.username, displayName: p.displayName, joinedAt: p.joined_at, leftAt: p.left_at })),
      participantCount: joined.length,
    };
  });
}
export function stats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const dayAgo = Date.now() - 24 * 3600e3;
  return {
    users: one('SELECT COUNT(*) AS n FROM users'),
    chats: one('SELECT COUNT(*) AS n FROM chats'),
    directChats: one("SELECT COUNT(*) AS n FROM chats WHERE kind = 'direct'"),
    groupChats: one("SELECT COUNT(*) AS n FROM chats WHERE kind = 'group'"),
    messages: one('SELECT COUNT(*) AS n FROM messages WHERE deleted = 0'),
    messagesToday: one('SELECT COUNT(*) AS n FROM messages WHERE created_at > ?', dayAgo),
    calls: one('SELECT COUNT(*) AS n FROM calls'),
    activeCalls: one('SELECT COUNT(*) AS n FROM calls WHERE ended_at IS NULL'),
    admins: one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    banned: one('SELECT COUNT(*) AS n FROM users WHERE banned = 1'),
  };
}

/* ----------------------------------------------------------- admin audit log */
export function audit(adminId, action, target = '', detail = '') {
  db.prepare('INSERT INTO admin_audit (admin_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(adminId, String(action).slice(0, 60), String(target).slice(0, 120), String(detail).slice(0, 300), Date.now());
}
export function auditLog(limit = 100) {
  return db.prepare(
    `SELECT a.*, u.username AS adminUsername FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ?`
  ).all(limit);
}

/** Messages per day for the last `days` days (oldest first) — admin overview chart. */
export function messagesPerDay(days = 14) {
  const start = Math.floor((Date.now() - (days - 1) * 24 * 3600e3) / 24 / 3600e3) * 24 * 3600e3;
  const rows = db.prepare(
    "SELECT (created_at / 86400000) * 86400000 AS d, COUNT(*) AS n FROM messages WHERE deleted = 0 AND created_at >= ? GROUP BY d ORDER BY d"
  ).all(start);
  const byDay = new Map(rows.map((r) => [Number(r.d), r.n]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = start + i * 24 * 3600e3;
    out.push({ day: Math.floor(d / 86400000), label: new Date(d).toISOString().slice(5, 10), n: byDay.get(d) || 0 });
  }
  return out;
}

export function dbHandle() { return db; }
