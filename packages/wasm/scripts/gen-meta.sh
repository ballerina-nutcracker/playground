#!/bin/bash

# Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Generates `packages/wasm/dist/ballerina-meta.json` from the submodule state.
# Uses an exact tag when available; otherwise records the current commit hash.

set -e

cd "$(dirname "$0")/../ballerina"

resolve_tag() {
  git describe --tags --exact-match 2>/dev/null || true
}

TAG=$(resolve_tag)

if [ -z "$TAG" ] && git remote get-url origin >/dev/null 2>&1; then
  if ! git fetch --tags --quiet origin >/dev/null 2>&1; then
    echo "warn: failed to fetch tags from origin; falling back to commit metadata" >&2
  fi
  TAG=$(resolve_tag)
fi

if [ -n "$TAG" ]; then
  VERSION="$TAG"
  TYPE="tag"
else
  VERSION=$(git rev-parse --short HEAD)
  TYPE="commit"
fi

mkdir -p ../dist

cat > ../dist/ballerina-meta.json << EOF
{
  "version": "$VERSION",
  "type": "$TYPE",
  "commit": "$(git rev-parse HEAD)"
}
EOF
