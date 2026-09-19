#!/usr/bin/env bash
# Stamp a new winget manifest set for a published Hypheus release.
# Usage: scripts/winget-update.sh 0.15.8
set -euo pipefail
VERSION="${1:?version required}"
REPO="MichaelCrowe11/crowe-terminal"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/packaging/winget/manifests/c/CroweLogic/Hypheus"
TEMPLATE="$(ls -d "$SRC_DIR"/*/ | sort -V | tail -1)"
DEST="$SRC_DIR/$VERSION"
mkdir -p "$DEST"

sha_for() {
    curl -fsSL "https://github.com/$REPO/releases/download/v$VERSION/$1" | shasum -a 256 | awk '{print $1}'
}
X64_SHA="$(sha_for "Hypheus-win32-x64-$VERSION.exe")"
ARM64_SHA="$(sha_for "Hypheus-win32-arm64-$VERSION.exe")"
TODAY="$(date -u +%F)"

for f in "$TEMPLATE"/*.yaml; do
    out="$DEST/$(basename "$f")"
    sed -e "s/^PackageVersion: .*/PackageVersion: $VERSION/" \
        -e "s/^ReleaseDate: .*/ReleaseDate: $TODAY/" \
        -e "s#/v[0-9.]*/Hypheus-win32-x64-[0-9.]*\.exe#/v$VERSION/Hypheus-win32-x64-$VERSION.exe#" \
        -e "s#/v[0-9.]*/Hypheus-win32-arm64-[0-9.]*\.exe#/v$VERSION/Hypheus-win32-arm64-$VERSION.exe#" \
        "$f" > "$out"
done
# Replace the two SHA lines in order: x64 first, arm64 second.
awk -v a="$X64_SHA" -v b="$ARM64_SHA" '
    /InstallerSha256:/ { n++; sub(/InstallerSha256: .*/, "InstallerSha256: " (n==1 ? a : b)) } { print }
' "$DEST/CroweLogic.Hypheus.installer.yaml" > "$DEST/.tmp" && mv "$DEST/.tmp" "$DEST/CroweLogic.Hypheus.installer.yaml"
echo "wrote $DEST"
