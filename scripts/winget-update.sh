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
# x64 only: the Windows arm64 build is not produced (see build-helper.yml).
X64_SHA="$(sha_for "Hypheus-win32-x64-$VERSION.exe")"
TODAY="$(date -u +%F)"

for f in "$TEMPLATE"/*.yaml; do
    out="$DEST/$(basename "$f")"
    sed -e "s/^PackageVersion: .*/PackageVersion: $VERSION/" \
        -e "s/^ReleaseDate: .*/ReleaseDate: $TODAY/" \
        -e "s#/v[0-9.]*/Hypheus-win32-x64-[0-9.]*\.exe#/v$VERSION/Hypheus-win32-x64-$VERSION.exe#" \
        -e "s/^\(\s*InstallerSha256:\) .*/\1 $X64_SHA/" \
        "$f" > "$out"
done
echo "wrote $DEST"
