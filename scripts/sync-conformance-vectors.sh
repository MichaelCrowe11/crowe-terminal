#!/usr/bin/env bash
# Refresh the vendored Crowe Code capability conformance vectors from the
# canonical copy in the crowe-id repo. The TS kernel
# (@crowe/code-capability) owns conformance/vectors.json; the Go mirror vendors
# a copy here so `go test` is self-contained. Run this after the canonical
# vectors change, then commit the updated testdata file.
set -euo pipefail
CROWE_ID_DIR="${CROWE_ID_DIR:-$HOME/Projects/crowe-id}"
SRC="$CROWE_ID_DIR/capability/conformance/vectors.json"
DST="$(cd "$(dirname "$0")/.." && pwd)/pkg/agent/scope/testdata/vectors.json"
if [[ ! -f "$SRC" ]]; then
  echo "canonical vectors not found at $SRC (set CROWE_ID_DIR)" >&2
  exit 1
fi
cp "$SRC" "$DST"
echo "synced vectors from $SRC -> $DST"
