#!/usr/bin/env bash
# Build, sign and publish XCaller from this machine.
# No GitHub Actions secrets are needed; nothing sensitive is committed.
#
#   1. edit version.json (version, whatsNew) and the other three version spots
#   2. ./scripts/release-local.sh
#
# Values are read from .release.env (gitignored, mode 600). See
# .release.env.example for the shape.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ -f .release.env ]; then
  set -a
  . ./.release.env
  set +a
fi

: "${XC_SERVER_URL:?Set XC_SERVER_URL in .release.env}"
: "${XC_KEYSTORE:?Set XC_KEYSTORE in .release.env}"
: "${XC_KEYSTORE_PASS:?Set XC_KEYSTORE_PASS in .release.env}"
: "${XC_KEY_ALIAS:?Set XC_KEY_ALIAS in .release.env}"
: "${XC_KEY_PASS:=$XC_KEYSTORE_PASS}"
export XC_SERVER_URL XC_KEYSTORE XC_KEYSTORE_PASS XC_KEY_ALIAS XC_KEY_PASS

VER=$(python3 -c "import json;print(json.load(open('version.json'))['version'])")
NAME=$(grep -oP 'android:versionName="\K[^"]+' android/AndroidManifest.xml)
CODE=$(grep -oP 'android:versionCode="\K[0-9]+' android/AndroidManifest.xml)
JSVER=$(grep -oP "XC_VERSION = '\K[^']+" public/js/version.js)
BUILDVER=$(grep -oP '^VERSION_NAME=\K.*' android/build.sh)
BUILDCODE=$(grep -oP '^VERSION_CODE=\K.*' android/build.sh)

if [ "$VER" != "$NAME" ] || [ "$VER" != "$JSVER" ] || [ "$VER" != "$BUILDVER" ]; then
  echo "Version mismatch: version.json=$VER manifest=$NAME js=$JSVER build.sh=$BUILDVER"
  exit 1
fi
if [ "$CODE" != "$BUILDCODE" ]; then
  echo "versionCode mismatch: manifest=$CODE build.sh=$BUILDCODE"
  exit 1
fi

echo "Building XCaller $VER ($CODE)…"
( cd android && ./build.sh )

APK="android/dist/XCaller-$VER.apk"
[ -f "$APK" ] || { echo "build did not produce $APK"; exit 1; }

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
"$SDK/build-tools/36.0.0/apksigner" verify --print-certs "$APK" | sed -n '1,3p'
HASH=$(sha256sum "$APK" | cut -d' ' -f1)
echo "sha256 $HASH"

if [ "$DRY" = 1 ]; then
  echo "Dry run: built and verified only; nothing published."
  exit 0
fi

cp "$APK" public/XCaller.apk
printf '%s  XCaller.apk\n' "$HASH" > public/XCaller.apk.sha256
python3 - "$HASH" <<'PY'
import json, sys, time
p = 'version.json'
d = json.load(open(p))
d['sha256'] = sys.argv[1]
d['releasedAt'] = int(time.time() * 1000)
with open(p, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
PY

python3 - <<'PY' > /tmp/xcaller-release-notes.md
import json
d = json.load(open('version.json'))
print(f"# XCaller {d['version']}\n")
print(d.get('notes', ''))
print("\n## What's new\n")
for item in d.get('whatsNew', []):
    print(f"- {item}")
print(f"\nAPK SHA-256: `{d['sha256']}`")
print("\nNo end-to-end encryption: the operator can read messages. Run your own server for full control.")
PY

git add version.json
git commit -m "release: v$VER" || true
git push origin main

if gh release view "v$VER" >/dev/null 2>&1; then
  echo "Release v$VER already exists. Bump the version first."
  exit 1
fi
gh release create "v$VER" "$APK" public/XCaller.apk.sha256 \
  --title "XCaller $VER" --notes-file /tmp/xcaller-release-notes.md --latest
echo "Published v$VER."
