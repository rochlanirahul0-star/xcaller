# Contributing

1. Open an issue describing the bug or proposal before large changes.
2. Keep the no-build philosophy: vanilla JS/CSS on the client, no framework.
3. Run the checks:
   ```bash
   npm ci
   node --check server.js && node --check db.js
   bash scripts/ci-smoke.sh
   ```
4. Test in a real browser at 390 px and 1440 px, plus a dark/light system setting.
5. Do not commit data, uploads, keystores, tokens or `.env` files.
6. Keep commits focused and explain the user-visible change.

By contributing you agree that your work is licensed under AGPL-3.0.
