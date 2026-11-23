#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/source.sh
go test -mod=readonly -race .
# Exercise upstream compiler/server suites under the race detector.
go test -mod=readonly -race github.com/ballerina-nutcracker/ballerina/ls/core/compile \
  github.com/ballerina-nutcracker/ballerina/ls/server -count=1 -timeout=90s
GOOS=js GOARCH=wasm go test -mod=readonly -exec="$(go env GOROOT)/lib/wasm/go_js_wasm_exec" .
# Exercise the shipped artifact and JS registration, not only the Go helpers.
bash scripts/build.sh
node scripts/smoke-test.cjs
node scripts/stdlib-smoke-test.cjs
