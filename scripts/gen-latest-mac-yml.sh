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
# Optional fourth argument: latest-mac.yml, alpha-mac.yml, or beta-mac.yml.

set -euo pipefail

fail() { printf '[gen-yml] %s\n' "$*" >&2; exit 1; }

[[ $# -ge 2 && $# -le 4 ]] || fail 'usage: gen-latest-mac-yml.sh <dir> <version> [release-date-iso] [manifest-basename]'
DIR="$1"
VERSION="$2"
BASENAME="${4-latest-mac.yml}"
VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
DATE_PATTERN='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'
[[ "$VERSION" =~ $VERSION_PATTERN ]] || fail 'invalid version'
case "$BASENAME" in
    latest-mac.yml|alpha-mac.yml|beta-mac.yml) ;;
    *) fail 'unsupported manifest basename' ;;
esac
if [[ $# -ge 3 ]]; then
    RELEASE_DATE="$3"
else
    RELEASE_DATE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" || fail 'cannot determine release date'
fi
[[ "$RELEASE_DATE" =~ $DATE_PATTERN ]] || fail 'invalid release date; expected UTC ISO timestamp'
while [[ "$DIR" != / && "$DIR" == */ ]]; do DIR="${DIR%/}"; done
[[ -d "$DIR" && ! -L "$DIR" ]] || fail 'artifact directory must be a nonsymlink directory'
if [[ "$DIR" != /* ]]; then DIR="$PWD/$DIR"; fi
DIR="$(cd -- "$DIR" && pwd -P)" || fail 'cannot resolve artifact directory'

sha512b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }
sizeof() { wc -c < "$1"; }

# The zip is the auto-update artifact; electron-updater downloads it, not the
# dmg. arm64 leads because it is the overwhelming majority of installs.
ordered=()
for name in \
    "Hypheus-darwin-arm64-${VERSION}.zip" \
    "Hypheus-darwin-x64-${VERSION}.zip" \
    "Hypheus-darwin-arm64-${VERSION}.dmg" \
    "Hypheus-darwin-x64-${VERSION}.dmg"; do
    [[ ! -L "$DIR/$name" ]] || fail "symlink artifact: $name"
    if [[ -e "$DIR/$name" ]]; then
        [[ -f "$DIR/$name" ]] || fail "nonregular artifact: $name"
        ordered+=("$name")
    fi
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

OUT="$DIR/$BASENAME"
[[ ! -L "$OUT" ]] || fail 'manifest output must not be a symlink'
[[ ! -e "$OUT" || -f "$OUT" ]] || fail 'manifest output must be a regular file'
TMP=""
cleanup() { if [[ -n "$TMP" ]]; then rm -f -- "$TMP"; fi; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
TMP="$(mktemp "$DIR/.${BASENAME}.XXXXXX")" || fail 'cannot create manifest temporary file'

write_manifest() {
    local name hash size primary_hash=""
    printf "version: '%s'\n" "$VERSION" || return 1
    printf 'files:\n' || return 1
    for name in "${ordered[@]}"; do
        hash="$(sha512b64 "$DIR/$name")" || return 1
        [[ "$hash" =~ ^[A-Za-z0-9+/]{86}==$ ]] || return 1
        size="$(sizeof "$DIR/$name")" || return 1
        size="${size//[[:space:]]/}"
        [[ "$size" =~ ^[0-9]+$ && "$size" != 0 ]] || return 1
        if [[ "$name" == "$PRIMARY" ]]; then primary_hash="$hash"; fi
        printf "  - url: '%s'\n" "$name" || return 1
        printf '    sha512: %s\n' "$hash" || return 1
        printf '    size: %s\n' "$size" || return 1
    done
    printf "path: '%s'\n" "$PRIMARY" || return 1
    printf 'sha512: %s\n' "$primary_hash" || return 1
    printf "releaseDate: '%s'\n" "$RELEASE_DATE" || return 1
}

# A failure inside a function used as a condition bypasses Bash's errexit.
# Keep every hash, size, and write checked before replacing the previous feed.
write_manifest > "$TMP" || fail 'manifest generation failed; previous output preserved'
chmod 644 "$TMP" || fail 'cannot set manifest permissions'
mv -f -- "$TMP" "$OUT" || fail 'cannot replace manifest'
TMP=""

echo "[gen-yml] wrote $OUT"
cat "$OUT"
