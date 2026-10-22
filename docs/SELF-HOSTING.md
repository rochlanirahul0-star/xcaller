# Self-hosting XCaller

XCaller is one Node process (REST + WebSocket + static files) and one SQLite
database. It has no external services except the optional TURN relay used by
calls and the optional Web Push keys.

## Requirements

- Linux host with a public IPv4 (and IPv6 if you want it)
- Domain pointing at the host
- Node 22+ (or Docker)
- HTTPS certificate (Caddy or certbot)
- Open ports: 443/tcp, 3478/udp+tcp, 5349/tcp, and a UDP relay range for TURN

## Docker

```bash
cp .env.example .env
mkdir -p data && sudo chown -R 1000:1000 data   # container runs as node (uid 1000)
docker compose up -d --build
```

Data lives in `./data`:

```
data/jarvis-chat.db      SQLite database
data/uploads/            attachments
data/ADMIN_PASSWORD.txt  first-boot superadmin password (600)
data/vapid.json          optional Web Push keys
data/turn.json           optional TURN credentials
```

Put Caddy in front using `deploy/Caddyfile` (automatic TLS + WebSocket), or the
nginx example. The app must be served at `/chat/`; keep that prefix.

First login: `admin` plus the password in `data/ADMIN_PASSWORD.txt`. Change it
immediately in Profile. Create your own account, promote it if needed, and keep
the admin account for recovery.

## Without Docker

```bash
npm ci
XC_DATA_DIR=/var/lib/xcaller PORT=3910 npm start
```

A systemd unit similar to:

```ini
[Unit]
Description=XCaller
After=network-online.target

[Service]
WorkingDirectory=/opt/xcaller
Environment=PORT=3910 HOST=127.0.0.1 XC_DATA_DIR=/var/lib/xcaller
ExecStart=/usr/bin/node server.js
Restart=always
User=xcaller
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/xcaller

[Install]
WantedBy=multi-user.target
```

## Calls (TURN)

STUN works on the same LAN. For calls between mobile networks you need coturn:

```bash
apt install coturn
cp deploy/turnserver.conf /etc/turnserver.conf   # set static-auth-secret
systemctl enable --now coturn
```

Then either set `TURN_HOST` + `TURN_SECRET`, or put this in
`data/turn.json` (mode 600):

```json
{ "host": "turn.example.com", "secret": "the-same-static-auth-secret" }
```

The server hands each signed-in user short-lived credentials. Never expose the
secret to clients.

## Web Push

```bash
npx web-push generate-vapid-keys
```

Save the JSON as `data/vapid.json` with `publicKey`, `privateKey` and a `subject`
(`mailto:` or URL). Without it, in-app delivery still works while the app is open;
push notifications are disabled.

## Upgrades

1. Back up `data/`.
2. Pull the new code / image, rebuild, restart.
3. Bump `version.json` (and the Android manifest/build script if you ship an APK).
4. The service worker and in-app updater pick up the new version on next launch.

## Backups

```bash
node scripts/backup.mjs     # VACUUM INTO data/backups, keeps 14
```

Back up `data/` nightly and test a restore. Uploads are not inside the database;
copy `data/uploads` too.

## Hardening checklist

- HTTPS only; HSTS is sent by the app
- strong admin password; no shared accounts
- keep `data/` mode 700 and the database 600
- firewall: expose 443 and the TURN ports only
- fail2ban or nginx rate limits on `/chat/api/`
- monitor disk (uploads) and memory (calls are peer-to-peer, but signalling is here)
- review the privacy template with your own policy before opening registration
