#!/usr/bin/env bash
# Produce a fully signed + notarized + stapled local build of Crowe Terminal.
#
# Pulls credentials straight from ~/.crowe-developer-id/ (see REFERENCE.md
# there). Use this when you want to hand a customer a working DMG without
# pushing a tag through GitHub Actions.
#
# Usage:
#   scripts/sign-and-notarize-local.sh                # build arm64+x64
#   scripts/sign-and-notarize-local.sh --arm64        # arm64 only
#   scripts/sign-and-notarize-local.sh --x64          # x64 only

set -euo pipefail

CRED_DIR="${CROWE_DEVELOPER_ID_DIR:-$HOME/.crowe-developer-id}"
P12="$CRED_DIR/CroweDeveloperID.p12"
P12_PW_FILE="$CRED_DIR/.p12_password"
NOTARY_PW_FILE="$CRED_DIR/.notarization_password"

for f in "$P12" "$P12_PW_FILE" "$NOTARY_PW_FILE"; do
    if [[ ! -r "$f" ]]; then
        echo "[sign] missing credential: $f" >&2
        echo "[sign] see ~/.crowe-developer-id/REFERENCE.md to (re)create it" >&2
        exit 1
    fi
done

export CSC_LINK="$P12"
export CSC_KEY_PASSWORD="$(<"$P12_PW_FILE")"
export CSC_NAME="${CSC_NAME:-Developer ID Application: Michael Crowe (6QLMV9UCPP)}"
export APPLE_ID="${APPLE_ID:-crowelogicmc@icloud.com}"
export APPLE_APP_SPECIFIC_PASSWORD="$(<"$NOTARY_PW_FILE")"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-6QLMV9UCPP}"

cli_args=""
case "${1:-}" in
    --arm64) cli_args="--mac --arm64" ;;
    --x64)   cli_args="--mac --x64" ;;
    "")      cli_args="--mac --arm64 --x64" ;;
    *)       echo "[sign] unknown arg: $1" >&2; exit 2 ;;
esac

echo "[sign] building Crowe Terminal with Developer ID signing + notarization"
echo "[sign] identity:    $CSC_NAME"
echo "[sign] team id:     $APPLE_TEAM_ID"
echo "[sign] apple id:    $APPLE_ID"
echo "[sign] targets:     $cli_args"

npm run build:prod
# shellcheck disable=SC2086
npm exec electron-builder -- -c electron-builder.config.cjs -p never $cli_args

echo "[sign] verifying artifacts in ./make"
bash "$(dirname "$0")/verify-mac-release.sh" make

echo "[sign] done. Signed DMGs are in ./make/"
