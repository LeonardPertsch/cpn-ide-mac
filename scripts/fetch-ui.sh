#!/usr/bin/env bash
# Download the official CPN IDE installer (v1.24.1031) and unpack its Angular UI into ./ui.
# Needs innoextract (brew install innoextract).
set -euo pipefail

URL="https://cpnide.org/downloads/cpn-ide-1.24.1031.setup.exe"
SHA256="19084e923258681b809e80b5a5c1944da6b7f072397d1194a26689b46a9b879a"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v innoextract >/dev/null || { echo "fetch-ui: innoextract fehlt (brew install innoextract)" >&2; exit 1; }
echo "fetch-ui: lade $URL"
curl -fsSL --retry 5 -C - -o "$WORK/setup.exe" "$URL"
echo "$SHA256  $WORK/setup.exe" | shasum -a 256 -c --status || { echo "fetch-ui: SHA-256 stimmt nicht" >&2; exit 1; }
innoextract --silent -d "$WORK/x" "$WORK/setup.exe"
npx --yes @electron/asar@3.2.18 extract "$WORK/x/app/resources/app.asar" "$WORK/asar"
rm -rf "$ROOT/ui"
cp -R "$WORK/asar/dist/cpn-ide" "$ROOT/ui"
echo "fetch-ui: fertig -> $ROOT/ui"
