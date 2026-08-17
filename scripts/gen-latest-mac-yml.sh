#!/usr/bin/env bash
# Regenerate latest-mac.yml from the artifacts as they exist on disk RIGHT NOW.
#
# This must run AFTER `xcrun stapler staple`. Stapling rewrites the .dmg to
# embed the notarization ticket, which changes both its size and its sha512.
# electron-builder writes latest-mac.yml during packaging, before notarization,
# so the manifest it produces describes bytes that no longer exist by the time
# the dmg is uploaded. Shipping that stale manifest is how the published 0.15.3
# ended up declaring 188,775,105 bytes for a dmg that is actually 188,786,730.
#
# It also emits each artifact exactly once. Running electron-builder per-arch
# appends to the existing manifest, which is why the published 0.15.3 listed the
# x64 zip and both dmgs three times each.
#
# Usage: scripts/gen-latest-mac-yml.sh <dir> <version> [release-date-iso]

set -euo pipefail

DIR="${1:?usage: gen-latest-mac-yml.sh <dir> <version> [release-date-iso]}"
VERSION="${2:?version required}"
RELEASE_DATE="${3:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"

sha512b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }
sizeof() { stat -f%z "$1"; }

# The zip is the auto-update artifact; electron-updater downloads it, not the
# dmg. arm64 leads because it is the overwhelming majority of installs.
ordered=()
for name in \
    "Hypheus-darwin-arm64-${VERSION}.zip" \
    "Hypheus-darwin-x64-${VERSION}.zip" \
    "Hypheus-darwin-arm64-${VERSION}.dmg" \
    "Hypheus-darwin-x64-${VERSION}.dmg"; do
    [[ -f "$DIR/$name" ]] && ordered+=("$name")
done

if [[ ${#ordered[@]} -eq 0 ]]; then
    echo "[gen-yml] no artifacts for version $VERSION in $DIR" >&2
    exit 1
fi

PRIMARY="Hypheus-darwin-arm64-${VERSION}.zip"
if [[ ! -f "$DIR/$PRIMARY" ]]; then
    echo "[gen-yml] missing $PRIMARY; electron-updater has nothing to download" >&2
    exit 1
fi

OUT="$DIR/latest-mac.yml"
{
    printf 'version: %s\n' "$VERSION"
    printf 'files:\n'
    for name in "${ordered[@]}"; do
        printf '  - url: %s\n' "$name"
        printf '    sha512: %s\n' "$(sha512b64 "$DIR/$name")"
        printf '    size: %s\n' "$(sizeof "$DIR/$name")"
    done
    printf 'path: %s\n' "$PRIMARY"
    printf 'sha512: %s\n' "$(sha512b64 "$DIR/$PRIMARY")"
    printf "releaseDate: '%s'\n" "$RELEASE_DATE"
} >"$OUT"

echo "[gen-yml] wrote $OUT"
cat "$OUT"
