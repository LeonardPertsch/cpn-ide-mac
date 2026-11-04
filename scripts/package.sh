#!/usr/bin/env bash
# Build "CPN IDE.app" for Apple Silicon into ./dist.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f ui/index.html ]] || bash scripts/fetch-ui.sh
npx electron-packager . "CPN IDE" \
  --platform=darwin --arch=arm64 \
  --out=dist --overwrite --asar \
  --icon=build/icon.icns \
  --app-bundle-id=org.cpnide.mac \
  --app-category-type=public.app-category.developer-tools \
  --extend-info=build/Info.extra.plist \
  --ignore='^/(build|scripts|dist|node_modules)($|/)' --ignore='^/README\.md$'
# Ad-hoc signature so macOS runs it on this machine.
codesign --force --deep --sign - "dist/CPN IDE-darwin-arm64/CPN IDE.app"
echo "done: dist/CPN IDE-darwin-arm64/CPN IDE.app"
