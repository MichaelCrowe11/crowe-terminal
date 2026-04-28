#!/usr/bin/env bash
# Sign, notarize, and staple Crowe Terminal .dmg files.
# Requires:
#   - "Developer ID Application: <Name> (TEAM_ID)" cert in default keychain
#   - APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID env vars
#     (APPLE_ID_PASSWORD is an app-specific password, not your Apple ID password)
# Run from the repo root after `task package`.

set -euo pipefail

: "${APPLE_ID:?set APPLE_ID env var (e.g. info@southwestmushrooms.com)}"
: "${APPLE_ID_PASSWORD:?set APPLE_ID_PASSWORD env var (app-specific password)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID env var (10-char team id)}"

IDENTITY="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ { print $2; exit }')"
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

# Store credentials once so subsequent runs don't re-prompt.
xcrun notarytool store-credentials crowe-notarize \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_ID_PASSWORD" >/dev/null 2>&1 || true

for dmg in "${DMGS[@]}"; do
    echo
    echo "=== $dmg ==="

    echo "[notarize] re-signing inner app with Developer ID..."
    mount_point="$(mktemp -d)"
    hdiutil attach "$dmg" -mountpoint "$mount_point" -nobrowse >/dev/null
    app_path="$(find "$mount_point" -maxdepth 1 -name "*.app" | head -1)"
    if [[ -z "$app_path" ]]; then
        hdiutil detach "$mount_point" >/dev/null
        echo "no .app inside $dmg" >&2
        continue
    fi
    work_app="/tmp/$(basename "$app_path")"
    rm -rf "$work_app"
    cp -R "$app_path" "$work_app"
    hdiutil detach "$mount_point" >/dev/null

    codesign --deep --force --options runtime \
        --entitlements scripts/entitlements.plist \
        --sign "$IDENTITY" \
        "$work_app"

    echo "[notarize] re-packaging dmg with signed .app..."
    new_dmg="${dmg%.dmg}-signed.dmg"
    rm -f "$new_dmg"
    hdiutil create -volname "Crowe Terminal" -srcfolder "$work_app" -ov -format UDZO "$new_dmg" >/dev/null
    codesign --force --sign "$IDENTITY" "$new_dmg"

    echo "[notarize] submitting to Apple..."
    xcrun notarytool submit "$new_dmg" --keychain-profile crowe-notarize --wait

    echo "[notarize] stapling ticket..."
    xcrun stapler staple "$new_dmg"
    xcrun stapler validate "$new_dmg"

    echo "[notarize] done: $new_dmg"
done

echo
echo "[notarize] all .dmgs signed, notarized, and stapled."
