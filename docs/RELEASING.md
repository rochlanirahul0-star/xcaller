# Releasing XCaller

## One-time signing setup (GitHub Actions)

The APK signer is permanent. **Never rotate it after the first public release** —
Android will refuse to install an update signed by a different key.

Add these repository secrets under
**Settings → Secrets and variables → Actions** (a maintainer must do this; a
normal PAT cannot write repo secrets):

| Secret | Value |
|---|---|
| `XC_KEYSTORE_B64` | `base64 -w0 your-release.jks` (one line) |
| `XC_KEYSTORE_PASS` | keystore password |
| `XC_KEY_PASS` | key password (same as store for PKCS12) |
| `XC_KEY_ALIAS` | the alias used when the key was created |
| `XC_SERVER_URL` | the HTTPS origin the official APK should use, ending in `/chat/` |

`XC_SERVER_URL` is stored as an encrypted secret and is never committed or printed
in logs. Without either the key or the URL, the Android workflow skips the signed
build and still passes.

Keep the keystore and passwords outside the repository in a root-only location,
and back the keystore up offline. Losing it means every user must uninstall.

Until the secrets exist, the Android workflow skips the build and still passes;
the release can be assembled manually (below).

## Version bump — four places, always together

1. `android/AndroidManifest.xml` — `versionCode` + `versionName`
2. `android/build.sh` — `VERSION_CODE` + `VERSION_NAME`
3. `public/js/version.js` — `window.XC_VERSION`
4. `version.json` — `version`, `whatsNew`, `releasedAt`, `sha256`

`whatsNew` is what users see in the update prompt and in the one-time
**What’s new** panel after updating. Keep bullets short and user-visible.

## Build and publish

```bash
cd android
export XC_SERVER_URL="https://your-server.example/chat/"
export XC_KEYSTORE=/secure/your-release.jks
export XC_KEYSTORE_PASS='…'
export XC_KEY_ALIAS='…'
export XC_KEY_PASS='…'
./build.sh
cp dist/XCaller-<version>.apk ../public/XCaller.apk
sha256sum ../public/XCaller.apk
```

Update `sha256` in `version.json`, restart the service, then tag:

```bash
git tag v<version>
git push origin v<version>
gh release create v<version> dist/XCaller-<version>.apk dist/SHA256SUMS.txt \
  --title "XCaller <version>" --notes-file notes.md
```

The tag triggers the Android workflow. With secrets configured it attaches a
fresh signed APK to the release; without them it skips cleanly.

## Device update path

Installed apps poll `/chat/api/version` at launch. A higher `version` shows the
update prompt with the `whatsNew` bullets. After installing, the app shows the
same bullets once. The APK must be signed with the same key as the installed
app or Android will reject it ("App not installed").

## Verify before announcing

```bash
apksigner verify --print-certs dist/XCaller-<version>.apk
curl -I https://<host>/chat/XCaller.apk
curl -s https://<host>/chat/api/version
```

Test on a real phone: update over the previous build, send a message, answer a
call, and confirm the What’s new panel appears.
