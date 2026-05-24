#!/usr/bin/env bash
# Sign, notarize, and staple Crowe Terminal .dmg files in-place.
#
# Requires a Developer ID Application certificate in the active keychain and:
#   - APPLE_ID
#   - APPLE_TEAM_ID
#   - APPLE_ID_PASSWORD or APPLE_APP_SPECIFIC_PASSWORD
#
# Run from the repo root after `task package`.

set -euo pipefail

: "${APPLE_ID:?set APPLE_ID env var}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID env var (10-char team id)}"

APPLE_ID_PASSWORD="${APPLE_ID_PASSWORD:-${APPLE_APP_SPECIFIC_PASSWORD:-}}"
if [[ -z "$APPLE_ID_PASSWORD" ]]; then
    echo "set APPLE_ID_PASSWORD or APPLE_APP_SPECIFIC_PASSWORD env var (app-specific password)" >&2
    exit 1
fi

find_identity() {
    security find-identity -v -p codesigning | awk '/Developer ID Application/ { print $2; exit }'
}

import_csc_link() {
    if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
        return 1
    fi

    local tmp_base cert_path keychain_path keychain_password
    tmp_base="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
    cert_path="$(mktemp "$tmp_base/crowe-terminal-certificate.XXXXXX.p12")"
    keychain_path="$(mktemp -u "$tmp_base/crowe-terminal-signing.XXXXXX.keychain-db")"
    keychain_password="$(uuidgen 2>/dev/null || date +%s)"

    if [[ -f "$CSC_LINK" ]]; then
        cp "$CSC_LINK" "$cert_path"
    else
        printf '%s' "$CSC_LINK" | base64 --decode > "$cert_path"
    fi

    security create-keychain -p "$keychain_password" "$keychain_path"
    security set-keychain-settings -lut 21600 "$keychain_path"
    security unlock-keychain -p "$keychain_password" "$keychain_path"
    security import "$cert_path" \
        -k "$keychain_path" \
        -P "$CSC_KEY_PASSWORD" \
        -T /usr/bin/codesign \
        -T /usr/bin/productbuild

    local current_keychains=()
    local keychain
    while IFS= read -r keychain; do
        keychain="${keychain//\"/}"
        keychain="${keychain#"${keychain%%[![:space:]]*}"}"
        keychain="${keychain%"${keychain##*[![:space:]]}"}"
        if [[ -n "$keychain" && "$keychain" != "$keychain_path" ]]; then
            current_keychains+=("$keychain")
        fi
    done < <(security list-keychains -d user)

    security list-keychains -d user -s "$keychain_path" "${current_keychains[@]}"
    security default-keychain -s "$keychain_path"
    security set-key-partition-list \
        -S apple-tool:,apple:,codesign: \
        -s \
        -k "$keychain_password" \
        "$keychain_path"
}

IDENTITY="$(find_identity)"
if [[ -z "$IDENTITY" ]]; then
    echo "[notarize] no active Developer ID identity found; importing CSC_LINK certificate"
    import_csc_link || true
    IDENTITY="$(find_identity)"
fi
if [[ -z "$IDENTITY" ]]; then
    echo "no Developer ID Application identity found in keychain" >&2
    exit 1
fi
echo "[notarize] using signing identity: $IDENTITY"

DMG_DIR="${1:-make}"
shopt -s nullglob
DMGS=("$DMG_DIR"/*.dmg)
if [[ ${#DMGS[@]} -eq 0 ]]; then
    echo "no .dmg files in $DMG_DIR" >&2
    exit 1
fi

PROFILE="${NOTARYTOOL_PROFILE:-crowe-terminal-notary}"

xcrun notarytool store-credentials "$PROFILE" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_ID_PASSWORD" >/dev/null 2>&1 || true

for dmg in "${DMGS[@]}"; do
    echo
    echo "=== $dmg ==="

    echo "[notarize] signing dmg container..."
    codesign --force --sign "$IDENTITY" "$dmg"

    echo "[notarize] submitting to Apple..."
    xcrun notarytool submit "$dmg" --keychain-profile "$PROFILE" --wait

    echo "[notarize] stapling ticket..."
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
    spctl -a -vv -t install "$dmg" >/dev/null

    echo "[notarize] done: $dmg"
done

echo
echo "[notarize] all .dmgs signed, notarized, and stapled."
