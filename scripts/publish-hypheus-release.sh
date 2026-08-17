#!/usr/bin/env bash
# Publish a Hypheus macOS release to releases.hypheus.com from the CI build.
#
# Build Helper (.github/workflows/build-helper.yml, on tag push) signs,
# notarizes, staples and attaches the darwin artifacts to a draft GitHub
# release. Nothing about that reaches users: the update feed and the download
# links are the R2 bucket `hypheus-downloads` under `hypheus/`, served by the
# crowe-releases-gate Worker at https://releases.hypheus.com/hypheus/. This
# script carries the exact CI bytes over.
#
#   1. downloads the darwin artifacts of the draft release for <version>
#   2. unpacks the arm64 zip (the artifact electron-updater installs) and runs
#      scripts/verify-mac-release.sh over app + dmgs: Developer ID, hardened
#      runtime, stapled ticket, Gatekeeper
#   3. regenerates latest-mac.yml from the stapled bytes with
#      scripts/gen-latest-mac-yml.sh (electron-builder's copy predates
#      stapling and lies about size and sha512; that is how 0.15.3 shipped a
#      manifest for bytes that did not exist)
#   4. with --upload, puts every artifact into R2 and latest-mac.yml LAST, so
#      the feed only flips once every file it names is already there
#
# Usage:
#   scripts/publish-hypheus-release.sh <version>            # dry run: download, verify, show manifest
#   scripts/publish-hypheus-release.sh <version> --upload   # and publish
#
# Needs gh (logged in) and wrangler. The shell-exported CLOUDFLARE_API_TOKEN
# on the dev machines is Workers-scoped and breaks every wrangler command, so
# authenticate wrangler with the account's Global API Key instead:
#
#   env -u CLOUDFLARE_API_TOKEN \
#       CLOUDFLARE_API_KEY=<global key> CLOUDFLARE_EMAIL=michael@crowelogic.com \
#       CLOUDFLARE_ACCOUNT_ID=<account id> \
#       scripts/publish-hypheus-release.sh 0.15.5 --upload

set -euo pipefail

VERSION="${1:?usage: publish-hypheus-release.sh <version> [--upload]}"
VERSION="${VERSION#v}"
UPLOAD=0
[[ "${2:-}" == "--upload" ]] && UPLOAD=1

BUCKET="hypheus-downloads"
PREFIX="hypheus"
FEED="https://releases.hypheus.com/${PREFIX}"
TAG="v${VERSION}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${HERE}/../artifacts/${VERSION}"

log() { printf '[publish] %s\n' "$*"; }
die() { printf '[publish] FAIL: %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "gh is required"
[[ $UPLOAD -eq 1 ]] && { command -v wrangler >/dev/null || die "wrangler is required for --upload"; }

# --- 1. download ---------------------------------------------------------
mkdir -p "$DIR"
log "downloading darwin artifacts of ${TAG} into ${DIR}"
gh release download "$TAG" --dir "$DIR" --pattern 'Hypheus-darwin-*' --clobber

primary="Hypheus-darwin-arm64-${VERSION}.zip"
[[ -f "$DIR/$primary" ]] || die "missing $primary; that is the file electron-updater downloads, nothing to publish"

# The upload set. arm64 zip is mandatory (checked above); the rest are
# whatever CI produced. latest-mac.yml is appended after generation.
files=()
for name in \
    "Hypheus-darwin-arm64-${VERSION}.zip" \
    "Hypheus-darwin-arm64-${VERSION}.zip.blockmap" \
    "Hypheus-darwin-x64-${VERSION}.zip" \
    "Hypheus-darwin-x64-${VERSION}.zip.blockmap" \
    "Hypheus-darwin-arm64-${VERSION}.dmg" \
    "Hypheus-darwin-x64-${VERSION}.dmg"; do
    if [[ -f "$DIR/$name" ]]; then
        files+=("$name")
    else
        log "note: ${name} not in the release, skipping"
    fi
done

# --- 2. verify -----------------------------------------------------------
log "unpacking ${primary} to verify the app the updater will install"
rm -rf "$DIR/unzipped-arm64"
mkdir -p "$DIR/unzipped-arm64"
ditto -x -k "$DIR/$primary" "$DIR/unzipped-arm64"
bash "${HERE}/verify-mac-release.sh" "$DIR"

# --- 3. manifest ---------------------------------------------------------
bash "${HERE}/gen-latest-mac-yml.sh" "$DIR" "$VERSION"
files+=("latest-mac.yml")
log "manifest:"
sed 's/^/    /' "$DIR/latest-mac.yml"

if [[ $UPLOAD -eq 0 ]]; then
    log "dry run. would upload to r2://${BUCKET}/${PREFIX}/ in this order:"
    printf '    %s\n' "${files[@]}"
    log "re-run with --upload to publish"
    exit 0
fi

# --- 4. upload -----------------------------------------------------------
content_type() {
    case "$1" in
        *.dmg) echo application/x-apple-diskimage ;;
        *.zip) echo application/zip ;;
        *.yml) echo text/yaml ;;
        *) echo application/octet-stream ;;
    esac
}

for name in "${files[@]}"; do
    log "uploading ${name}"
    wrangler r2 object put "${BUCKET}/${PREFIX}/${name}" \
        --file "$DIR/$name" --content-type "$(content_type "$name")" --remote --force
done

# --- 5. confirm from the outside -----------------------------------------
log "checking the live feed"
live="$(curl -fsS "${FEED}/latest-mac.yml")" || die "feed unreadable after upload"
if [[ "$live" == "$(cat "$DIR/latest-mac.yml")" ]]; then
    log "live latest-mac.yml matches the uploaded manifest"
else
    die "live latest-mac.yml differs from what was uploaded (CDN cache?); check ${FEED}/latest-mac.yml"
fi
size_live="$(curl -fsSI "${FEED}/${primary}" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
size_local="$(stat -f%z "$DIR/$primary")"
[[ "$size_live" == "$size_local" ]] || die "${primary}: live size ${size_live} != local ${size_local}"
log "published ${VERSION}: ${FEED}/${primary} (${size_live} bytes) and latest-mac.yml"
