#!/usr/bin/env bash
# Sourced by build/test after changing to the package directory.
export GOWORK=off GOTOOLCHAIN=go1.27.1
if [[ -z "${LS_SOURCE_DIR:-}" && -f .source-dir ]]; then
  LS_SOURCE_DIR="$(cat .source-dir)"
fi
if [[ -n "${LS_SOURCE_DIR:-}" ]]; then
  LS_SOURCE_DIR="$(cd "$LS_SOURCE_DIR" && pwd)"
  cp go.mod .local.go.mod
  cp go.sum .local.go.sum
  # Override every compiler module, not just the root module. Never patch or
  # otherwise modify the developer checkout.
  while read -r module relative; do
    target="$LS_SOURCE_DIR${relative#./.upstream}"
    if [[ ! -f "$target/go.mod" ]]; then
      echo "Missing LS source module: $target/go.mod" >&2
      exit 1
    fi
    go mod edit -modfile=.local.go.mod "-replace=$module=$target"
  done < <(awk '$1 == "replace" && $4 ~ /^\.\/\.upstream/ { print $2, $4 }' go.mod)
  export GOFLAGS="${GOFLAGS:-} -modfile=$PWD/.local.go.mod"
  echo "Building language server from $LS_SOURCE_DIR"
else
  bash scripts/prepare.sh
fi
if grep -q 'func New(openDir func(string) fs.FS' "${LS_SOURCE_DIR:-.upstream}/ls/core/workspace/workspace.go"; then
  export GOFLAGS="${GOFLAGS:-} -tags=ls_iofs"
fi
