#!/usr/bin/env bash
# Asserts that every Crowe Terminal .app and .dmg in the given directory was
# signed with a Developer ID identity, packaged with hardened runtime, and (for
# .dmg) carries a stapled notarization ticket.
#
# Used by .github/workflows/build-helper.yml so that a silently-unsigned release
# (the v0.14.6 / v0.14.7 regression) fails CI instead of shipping.

set -euo pipefail

DIR="${1:-make}"
fail=0

note() { printf "[verify-mac] %s\n" "$*"; }
err()  { printf "[verify-mac] FAIL: %s\n" "$*" >&2; fail=1; }

shopt -s nullglob

apps=()
while IFS= read -r -d '' a; do apps+=("$a"); done < <(find "$DIR" -maxdepth 4 -type d -name "*.app" -print0 2>/dev/null)

if [[ ${#apps[@]} -eq 0 ]]; then
    err "no .app bundles found under $DIR"
fi

for app in "${apps[@]}"; do
    note "checking app: $app"
    if ! codesign -dv --verbose=2 "$app" 2>&1 | tee /tmp/cs.out >/dev/null; then
        err "$app: codesign -dv failed"
        continue
    fi
    if ! grep -q "Authority=Developer ID Application" /tmp/cs.out; then
        err "$app: not signed with a Developer ID Application identity"
        sed 's/^/[verify-mac]   /' /tmp/cs.out >&2
        continue
    fi
    if ! grep -q "flags=.*runtime" /tmp/cs.out; then
        err "$app: hardened runtime flag missing on signature"
        sed 's/^/[verify-mac]   /' /tmp/cs.out >&2
        continue
    fi
    note "  Developer ID signed + hardened runtime OK"
done

dmgs=("$DIR"/*.dmg)
if [[ ${#dmgs[@]} -eq 0 ]]; then
    err "no .dmg files found under $DIR"
fi

for dmg in "${dmgs[@]}"; do
    note "checking dmg: $dmg"
    if ! codesign -dv --verbose=2 "$dmg" >/dev/null 2>&1; then
        err "$dmg: not code-signed"
        continue
    fi
    if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
        err "$dmg: notarization ticket not stapled (xcrun stapler validate failed)"
        continue
    fi
    if ! spctl -a -vv -t install "$dmg" >/dev/null 2>&1; then
        err "$dmg: Gatekeeper assessment failed (spctl -a -t install)"
        continue
    fi
    note "  signed + stapled + Gatekeeper-accepted OK"
done

if [[ $fail -ne 0 ]]; then
    echo "[verify-mac] release artifacts failed signing/notarization checks" >&2
    exit 1
fi
echo "[verify-mac] all darwin artifacts under $DIR are properly signed, hardened, and notarized."
