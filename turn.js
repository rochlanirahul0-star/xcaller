/**
 * TURN credentials for WebRTC calls.
 *
 * Calls between two phones on different networks need a relay: STUN alone fails
 * behind carrier NAT. coturn's REST API (RFC-style "long-term credential" with a
 * shared secret) is what we hand out here — short-lived, per-user, generated with
 * the same secret coturn is configured with. Nothing secret is ever logged.
 *
 * Configure with either:
 *   - /var/lib/hermes-agent/jarvis-chat/turn.json  { "host": "...", "secret": "..." }
 *   - env TURN_HOST / TURN_SECRET
 * Without it the app still works on the same Wi-Fi (STUN only) and says so.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = process.env.XC_TURN_FILE || path.join(import.meta.dirname, 'turn.json');
const TTL_SECONDS = 12 * 3600;

const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function loadConfig() {
  if (process.env.TURN_SECRET) return { host: process.env.TURN_HOST || '', secret: process.env.TURN_SECRET };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (raw && raw.secret) return { host: raw.host || '', secret: raw.secret, port: raw.port, tlsPort: raw.tlsPort };
  } catch { /* not configured yet */ }
  return null;
}

export function turnConfigured() {
  const c = loadConfig();
  return !!(c && c.secret && c.host);
}

/** ICE servers for one user: STUN always, TURN when it is configured. */
export function iceServers(user) {
  const servers = [{ urls: STUN }];
  const cfg = loadConfig();
  if (cfg && cfg.secret && cfg.host) {
    const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${user ? user.id : 0}`;
    const credential = createHmac('sha1', cfg.secret).update(username).digest('base64');
    const port = cfg.port || 3478;
    const tlsPort = cfg.tlsPort || 5349;
    servers.push({
      urls: [
        `turn:${cfg.host}:${port}?transport=udp`,
        `turn:${cfg.host}:${port}?transport=tcp`,
        `turns:${cfg.host}:${tlsPort}?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return servers;
}

export function writeConfig({ host, secret, port = 3478, tlsPort = 5349 }) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ host, secret, port, tlsPort }, null, 2), { mode: 0o600 });
}

/** Used by scripts/setup-turn.sh to print what it generated. */
export function suggestedSecret() {
  return createHmac('sha256', String(Date.now())).update('jarvis-chat-turn').digest('hex');
}
