#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# This checkout is a build cache, not the compiler/runtime submodule.
revision=e64ff12f6e1e947ed7a473363507f34bf16a6eb0
if [[ ! -d .upstream/.git ]]; then
  git init -q .upstream
  git -C .upstream remote add origin https://github.com/ballerina-nutcracker/ballerina.git
fi
git -C .upstream remote set-url origin https://github.com/ballerina-nutcracker/ballerina.git
if [[ "$(git -C .upstream rev-parse HEAD 2>/dev/null || true)" != "$revision" ]]; then
  git -C .upstream fetch --depth=1 origin "$revision"
  git -C .upstream checkout --detach "$revision"
fi
# Build the pinned revision unmodified.
if ! git -C .upstream diff --quiet || ! git -C .upstream diff --cached --quiet || \
   [[ -n "$(git -C .upstream ls-files --others --exclude-standard)" ]]; then
  echo 'LS source cache has unexpected local modifications; remove packages/ls-wasm/.upstream and rebuild.' >&2
  exit 1
fi
