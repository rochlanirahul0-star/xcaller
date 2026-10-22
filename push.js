/**
 * Web Push notifications.
 *
 * This is what makes a message or a call reach a phone whose app is closed or in
 * the background. The server holds one subscription per device; payloads are tiny
 * and the service worker decides whether to show anything (it stays silent when
 * the app is already open and focused).
 *
 * Keys live in vapid.json (mode 600). Only the public key ever leaves the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { dbHandle } from './db.js';

const KEY_FILE = process.env.XC_VAPID_FILE || path.join(import.meta.dirname, 'vapid.json');

let keys = null;
try { keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch { /* not set up */ }

if (keys && keys.publicKey && keys.privateKey) {
  webpush.setVapidDetails(keys.subject || 'mailto:admin@localhost', keys.publicKey, keys.privateKey);
}

dbHandle().exec(`
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ua         TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
`);

export function pushReady() { return !!(keys && keys.publicKey); }
export function publicKey() { return keys ? keys.publicKey : null; }

export function saveSubscription(userId, subscription, ua = '') {
  if (!subscription || !subscription.endpoint || !subscription.keys) throw new Error('bad_subscription');
  dbHandle().prepare(`INSERT INTO push_subs (endpoint, user_id, keys_json, created_at, ua) VALUES (?,?,?,?,?)
                      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, ua = excluded.ua`)
    .run(subscription.endpoint, userId, JSON.stringify(subscription.keys), Date.now(), String(ua).slice(0, 200));
  return true;
}
export function dropSubscription(endpoint) {
  dbHandle().prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || ''));
}
export function subscriptionCount() {
  return dbHandle().prepare('SELECT COUNT(*) AS n FROM push_subs').get().n;
}

/**
 * Send a payload to every device of the given users, skipping any user in `skip`.
 * Dead subscriptions (404/410) are pruned as we go.
 */
export async function notify(userIds, payload, { skip = [], ttl = 3600, urgency = 'normal' } = {}) {
  if (!pushReady()) return { sent: 0, skipped: 'push_not_configured' };
  const skipSet = new Set(skip.map(Number));
  const ids = [...new Set(userIds.map(Number))].filter((id) => id && !skipSet.has(id));
  if (!ids.length) return { sent: 0 };

  let sent = 0, dead = 0;
  for (const uid of ids) {
    const rows = dbHandle().prepare('SELECT endpoint, keys_json FROM push_subs WHERE user_id = ?').all(uid);
    for (const row of rows) {
      const subscription = { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: ttl, urgency });
        sent++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) { dropSubscription(row.endpoint); dead++; }
      }
    }
  }
  if (sent || dead) console.log(`[push] ${payload.type || 'payload'} → ${sent} device(s)${dead ? `, pruned ${dead} dead` : ''}`);
  return { sent, dead };
}
