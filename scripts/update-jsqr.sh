#!/usr/bin/env bash
# Refresh the vendored jsQR library (QR-code detection for attachment
# previews). Source: npm (Apache-2.0). Run occasionally:
#   bash scripts/update-jsqr.sh [version]
set -euo pipefail

VERSION="${1:-1.4.0}"

cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching jsqr@$VERSION from npm …"
(cd "$TMP" && npm pack "jsqr@$VERSION" --silent)

tar xzf "$TMP"/jsqr-*.tgz -C "$TMP"
cp "$TMP/package/dist/jsQR.js" vendor/jsQR.js
cp "$TMP/package/LICENSE" vendor/jsQR.LICENSE

echo "Done. vendor/jsQR.js updated to $VERSION."
echo "Review the diff, then: git add vendor/jsQR.js vendor/jsQR.LICENSE && git commit -m 'Update vendored jsQR'"
