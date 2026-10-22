# XCaller for Android

A deliberately small WebView shell around the XCaller web app. It adds what a
browser tab cannot:

- persistent camera/microphone grants for calls
- a foreground service for messages and calls while the app is closed
- native ringing (full-screen intent) and call audio routing (speaker/earpiece/BT)
- file uploads, HTML5 fullscreen, screen share
- in-app updates + a one-time “What’s new” panel after each update

## Point it at a server

The repository contains **no endpoint**. `build.sh` injects it at build time:

```bash
export XC_SERVER_URL="https://your-domain.example/chat/"
```

Keep the trailing slash. The web UI, the background service and the updater all
read this one value. It is never committed to the repository.

## Build

Requirements:

- JDK (11 or newer; the build targets Java 8 bytecode)
- Android SDK with `build-tools;36.0.0` and `platforms;android-36`
- `python3` with Pillow (icons are generated from `../public/icon-512.png`)

Signing is supplied by environment variables — never commit a keystore:

```bash
export XC_SERVER_URL="https://your-domain.example/chat/"
export XC_KEYSTORE=/secure/xcaller-release.jks
export XC_KEYSTORE_PASS='…'
export XC_KEY_ALIAS=xcaller
export XC_KEY_PASS='…'
cd android
./build.sh
# → dist/XCaller-<version>.apk
```

The build fails loudly if a required class is missing from the dex, so a broken
APK cannot be produced silently.

## Release checklist

Bump all four together:

1. `android/AndroidManifest.xml` — `versionCode`, `versionName`
2. `android/build.sh` — `VERSION_CODE`, `VERSION_NAME`
3. `public/js/version.js` — `window.XC_VERSION`
4. `version.json` — `version`, `whatsNew`, `releasedAt`, `sha256`

Then build, copy the APK to `public/XCaller.apk`, and update the checksum.

**Never change the signing key after the first public release.** Android refuses
to install an update signed by a different key; users would have to uninstall
and lose local data. Rotate only with an APK Signature Scheme v3 lineage, and
test on a real device first.

## Package name

`com.jarvis.chat` is the current application id. It can never change without a
new install; decide before the first public release.

## CI

`.github/workflows/android-release.yml` builds on a tag and creates a GitHub
release. Required secrets:

- `XC_KEYSTORE_B64` — base64 of the release keystore
- `XC_KEYSTORE_PASS`
- `XC_KEY_PASS`
- `XC_KEY_ALIAS` (optional; defaults to `xcaller`)

## Permissions

Camera/microphone for calls, notifications for messages, foreground service for
background delivery, install packages for in-app updates, boot receiver to
restart delivery. All are declared in the manifest; none are used for tracking.
