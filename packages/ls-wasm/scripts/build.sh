#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/source.sh
mkdir -p dist
GOOS=js GOARCH=wasm go build -mod=readonly -trimpath -buildvcs=false -o dist/ballerina-ls.wasm .
# Toolchain files can be read-only in Go's module cache.
rm -f dist/wasm_exec.js
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" dist/wasm_exec.js
chmod u+w dist/wasm_exec.js
