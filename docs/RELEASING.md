# Releasing XCaller

## Recommended: one command on the release machine

Signing keys and the server endpoint stay on the machine that publishes. Nothing
sensitive is committed and no GitHub secrets are required.

1. Bump the version in all four places:
   - `android/AndroidManifest.xml` — `versionCode` + `versionName`
   - `android/build.sh` — `VERSION_CODE` + `VERSION_NAME`
   - `public/js/version.js` — `window.XC_VERSION`
   - `version.json` — `version`, `whatsNew`, `releasedAt`, `sha256`

2. Create a local, gitignored `.release.env` (mode 600) from
   `.release.env.example`:

   ```
   XC_SERVER_URL=https://your-server.example/chat/
   XC_KEYSTORE=/secure/your-release.jks
   XC_KEYSTORE_PASS=…
   XC_KEY_ALIAS=…
   XC_KEY_PASS=…
   ```

3. Publish:

   ```bash
   ./scripts/release-local.sh
   ```

The script checks that every version spot agrees, builds and signs the APK,
updates `version.json` and `public/XCaller.apk`, commits that, pushes `main`, and
creates the GitHub release with the APK and checksum.

Use `./scripts/release-local.sh --dry-run` to build and verify without
publishing.

**Never rotate the signing key after the first public release.** Android refuses
to install an update signed by a different key; every user would have to
uninstall. Back the keystore up offline.

## Optional: build on GitHub Actions

The manual **Android build (optional)** workflow can produce a signed APK as an
artifact. It does not publish a release. It needs repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `XC_KEYSTORE_B64` | `base64 -w0 your-release.jks` (one line) |
| `XC_KEYSTORE_PASS` | keystore password |
| `XC_KEY_PASS` | key password (same as store for PKCS12) |
| `XC_KEY_ALIAS` | the alias used when the key was created |
| `XC_SERVER_URL` | the HTTPS origin, ending in `/chat/` |

Secrets are encrypted and never shown on the repository or in logs. If either the
key or the server URL is missing, the workflow skips the build and still passes.
If you do not want the endpoint stored on GitHub at all, use the local release
script instead and leave this workflow unused.

## Device update path

Installed apps poll `/chat/api/version` at launch and when they become visible.
A higher `version` shows the update prompt with the `whatsNew` bullets. After
installing, the app shows the same bullets once. The APK must be signed with the
same key as the installed app, or Android will reject it.

## Verify before announcing

```bash
apksigner verify --print-certs dist/XCaller-<version>.apk
curl -I https://<host>/chat/XCaller.apk
curl -s https://<host>/chat/api/version
```

Test on a real phone: update over the previous build, send a message, answer a
call, and confirm the What’s new panel appears.
