# XCaller

**Messaging and calls that don't need your phone number nor a tech giant.**

XCaller is an open-source messenger you can actually own. Pick a username,
message people, make voice and video calls, and share your screen. No phone
number, no email address, no ads, no analytics, no app-store account.

[**Download the Android app**](https://github.com/rochlanirahul0-star/xcaller/releases/latest) · [Run your own server](docs/SELF-HOSTING.md)

## Why XCaller is different

- **A username is the identity.** No phone number to leak, no email to verify, no
  contact upload. People find you by the name you chose.
- **One device at a time.** Signing in somewhere new is deliberate. Sessions do not
  silently multiply across devices.
- **The calls are real.** Voice, video and screen sharing are built into the same
  app — no switching to another service when the conversation matters.
- **The server is yours if you want it.** The entire stack is open source: one Node
  process, SQLite, WebSocket and WebRTC. Point the app at your own instance and
  nobody else is in the middle.
- **No ads and no tracking SDKs.** The client talks to the server it is pointed at,
  not to an advertising network.
- **Install directly.** Download the signed APK, tap it, and use it. No store
  account and no gatekeeper required.
- **Honest about privacy.** Messages are stored unencrypted on the server, so the
  operator can read them. There is no end-to-end encryption yet. If you need full
  control, run the server yourself. Do not use XCaller for anything you would not
  trust the operator with.

## Download and use

1. Open [Releases](https://github.com/rochlanirahul0-star/xcaller/releases/latest)
   and download the latest `XCaller-*.apk`.
2. Open the file on your phone and allow installing from this source.
3. Create a username, share it with someone, and start a conversation.

No configuration, account or server setup is required for the hosted build.
Android 7.0 or newer is supported.

## What is inside

- One-to-one and group chats, typing indicators, read receipts and presence.
- Voice and video calls, conference calls and screen sharing over WebRTC.
- Photos, video, audio, voice notes and documents up to 200 MB.
- Invite links, search, replies, forwarding and per-device notifications.
- A small Android shell that keeps messages and calls arriving in the background,
  rings natively and updates itself in place.
- A self-hostable server behind HTTPS with a TURN relay for calls between mobile
  networks.

## Run your own server

The same repository contains the complete backend. Docker is the shortest path:

```bash
git clone https://github.com/rochlanirahul0-star/xcaller.git
cd xcaller
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d --build
```

Then put it behind HTTPS at `/chat/` with the Caddy or nginx example in `deploy/`.
Full instructions, TURN setup, backups and hardening are in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

To build the Android app against your own server, set `XC_SERVER_URL` and follow
[android/README.md](android/README.md).

## Technology

Node 22+ with the built-in SQLite driver, `ws` for WebSocket, WebRTC for calls, and
a no-build vanilla JavaScript client. No frameworks, no native Node modules, no
external database.

## Contact

- Email: [rochlanirahul0@gmail.com](mailto:rochlanirahul0@gmail.com?subject=XCaller)
- On XCaller: **@rajani**

## Security

See [SECURITY.md](SECURITY.md) for the threat model and reporting. The short
version: passwords use scrypt, sessions are random bearer tokens, traffic is
HTTPS/WSS, uploads cannot execute on the app origin, and the operator can read
message content.

## License

AGPL-3.0. If you run a modified XCaller as a network service, you must offer the
corresponding source to its users. See [LICENSE](LICENSE).
