# Architecture

```
browser / Android WebView
   │  HTTPS + WSS (/chat/)
   ▼
nginx or Caddy  ──►  Node (server.js)  ──►  SQLite (node:sqlite)
                       │  REST /api/*
                       │  WebSocket /chat/ws
                       │  static public/
                       ▼
                  coturn (optional relay)
```

## Server

- One process, no framework. `server.js` routes REST, upgrades WebSocket and
  serves the static app.
- `db.js` owns the schema and queries: users, sessions, chats, members, messages,
  calls, attachments, invites, push subscriptions, audit log.
- `push.js` stores one Web Push subscription per device.
- `turn.js` issues HMAC time-limited TURN credentials.
- Authentication is a bearer token (`Authorization: Bearer …`), also accepted as
  `?token=` for the WebSocket and media URLs.
- Attachments are written to `data/uploads` with random names.

## Client

- Vanilla JS, no build step. `public/js/app.js` is the main UI, `calls.js` the
  WebRTC engine, `ui2.js` the newer sheets and update flow, `features.js` extras,
  `push.js` notifications.
- One WebSocket carries messages, receipts, typing, presence and call signalling.
- Service worker caches the app shell only; API responses are never cached.

## Calls

WebRTC mesh: every participant connects to every other participant. Voice/video
and screen share work without a media server, but each participant uploads one
stream per peer. Practical ceiling is roughly 4–6 people; go beyond that only
with an SFU, which XCaller does not include. TURN is required when peers are
behind carrier NAT.

## Security boundaries

- Passwords: scrypt; sessions: random 32-byte tokens.
- The operator can read all messages and attachments. There is no E2EE.
- Admin API is role-gated; protect the admin console further at the proxy if you
  run a public instance.
- Uploads are type-checked and served with `nosniff`; non-media files download
  instead of rendering in the app origin.
