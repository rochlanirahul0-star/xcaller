#!/bin/bash
# Build XCaller with the Android SDK's own tools (no Gradle).
#
# Nothing sensitive is baked into this repo. Provide:
#   XC_SERVER_URL, XC_KEYSTORE, XC_KEYSTORE_PASS, XC_KEY_ALIAS, XC_KEY_PASS
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
BT="$SDK/build-tools/36.0.0"
AJ="$SDK/platforms/android-36/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

VERSION_CODE=32
VERSION_NAME=3.14

: "${XC_SERVER_URL:?Set XC_SERVER_URL to your HTTPS origin, e.g. https://example.com/chat/}"
case "$XC_SERVER_URL" in
  https://*) ;;
  *) echo "BUILD FAILED: XC_SERVER_URL must start with https://"; exit 1 ;;
esac

: "${XC_KEYSTORE:?Set XC_KEYSTORE to the release keystore path}"
: "${XC_KEYSTORE_PASS:?Set XC_KEYSTORE_PASS}"
XC_KEY_ALIAS="${XC_KEY_ALIAS:-xcaller}"
: "${XC_KEY_PASS:=$XC_KEYSTORE_PASS}"

[ -x "$BT/aapt2" ] || { echo "BUILD FAILED: $BT not found"; exit 1; }
[ -f "$AJ" ] || { echo "BUILD FAILED: $AJ not found"; exit 1; }

echo "== 1. icon =="
mkdir -p res/mipmap-xxhdpi res/mipmap-hdpi
XC_ICON="$(cd "$HERE/.." && pwd)/public/icon-512.png" python3 - <<'PY'
import os
from PIL import Image
src = Image.open(os.environ['XC_ICON']).convert('RGBA')
src.resize((192,192), Image.LANCZOS).save('res/mipmap-xxhdpi/ic_launcher.png')
src.resize((72,72), Image.LANCZOS).save('res/mipmap-hdpi/ic_launcher.png')
print('  icons written')
PY

echo "== 2. compile resources =="
rm -rf out && mkdir -p out/gen out/obj out/dex dist
"$BT/aapt2" compile --dir res -o out/res.zip

echo "== 3. link resources =="
"$BT/aapt2" link -o out/base.apk \
  -I "$AJ" \
  --manifest AndroidManifest.xml \
  -R out/res.zip \
  --java out/gen \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "== 4. compile java =="
# A compile error here used to be swallowed by a pipe, which produced an APK
# with no MainActivity — it installed fine and crashed instantly on launch.
set -o pipefail
# The repository contains no endpoint. Inject it into a build copy only.
mkdir -p out/src && cp -a src/. out/src/
python3 - "$XC_SERVER_URL" <<'INJECT'
import sys
p = 'out/src/com/jarvis/chat/Server.java'
url = sys.argv[1].strip()
if not url.endswith('/'):
    url += '/'
s = open(p).read()
if '__XC_SERVER_URL__' not in s:
    raise SystemExit('Server.java placeholder missing')
open(p, 'w').write(s.replace('__XC_SERVER_URL__', url))
INJECT
if ! javac -source 8 -target 8 -Xlint:-options -classpath "$AJ" -d out/obj \
     $(find out/src -name '*.java') $(find out/gen -name '*.java') 2>&1 | grep -vE "^Note:|deprecat|unchecked"; then :; fi
for c in MainActivity NotifyService BootReceiver Crash Api Server; do
  if [ ! -f "out/obj/com/jarvis/chat/$c.class" ]; then
    echo "BUILD FAILED: $c.class was not compiled — the APK would crash on launch."
    exit 1
  fi
done

echo "== 5. dex =="
"$BT/d8" --lib "$AJ" --min-api 24 --output out/dex $(find out/obj -name '*.class')

echo "== 6. pack classes.dex =="
"$BT/dexdump" -f out/dex/classes.dex > out/classes.txt 2>/dev/null || true
for c in MainActivity NotifyService BootReceiver; do
  if ! grep -q "Lcom/jarvis/chat/$c;" out/classes.txt; then
    echo "BUILD FAILED: $c is missing from the dex — the app would crash on launch."
    exit 1
  fi
done
(cd out/dex && zip -q -X ../base.apk classes.dex)

echo "== 7. sign =="
"$BT/zipalign" -f 4 out/base.apk out/aligned.apk
"$BT/apksigner" sign \
  --ks "$XC_KEYSTORE" \
  --ks-pass "env:XC_KEYSTORE_PASS" \
  --ks-key-alias "$XC_KEY_ALIAS" \
  --key-pass "env:XC_KEY_PASS" \
  --out "dist/XCaller-$VERSION_NAME.apk" out/aligned.apk

echo "== 8. verify =="
"$BT/apksigner" verify --print-certs "dist/XCaller-$VERSION_NAME.apk" | head -4
"$BT/aapt" dump badging "dist/XCaller-$VERSION_NAME.apk" | grep -E "^package|^application-label|launchable-activity" | head -4
ls -lh "dist/XCaller-$VERSION_NAME.apk"
