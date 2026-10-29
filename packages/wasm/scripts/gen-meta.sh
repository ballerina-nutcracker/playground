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

# Generates `packages/wasm/dist/ballerina-meta.json` from the Ballerina module
# version pinned in `go.mod`. A tagged version is recorded as a tag; a
# pseudo-version is recorded as the commit it points to.

set -e

cd "$(dirname "$0")/.."

MODULE="github.com/ballerina-nutcracker/ballerina/lib"

VERSION=$(go list -m -f '{{with .Replace}}{{.Version}}{{else}}{{.Version}}{{end}}' "$MODULE")

case "$VERSION" in
  *-??????????????-????????????)
    VERSION="${VERSION##*-}"
    TYPE="commit"
    ;;
  *)
    TYPE="tag"
    ;;
esac

mkdir -p dist

cat > dist/ballerina-meta.json << EOF
{
  "version": "$VERSION",
  "type": "$TYPE",
  "commit": "$VERSION"
}
EOF
