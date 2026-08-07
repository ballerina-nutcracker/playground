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

# Updates the `packages/wasm/ballerina` submodule source.
# - Switch mode: points the submodule to a given remote + branch.
# - Reset mode: restores the submodule to the repository-pinned commit.

set -e

SUBMODULE_DIR="packages/wasm/ballerina"

usage() {
    echo "Usage:"
    echo "  $0 <remote-url> <branch>"
    echo "  $0 --reset"
    exit 1
}

reset() {
    echo "Resetting submodule..."
    git submodule update --init --force "$SUBMODULE_DIR"
    echo "Submodule reset complete."
}

switch() {
    local remote_url=$1
    local branch=$2

    echo "Pointing submodule to $remote_url @ $branch..."

    pushd "$SUBMODULE_DIR" > /dev/null 

    git remote add temp "$remote_url" 2>/dev/null || git remote set-url temp "$remote_url"
    git fetch temp "$branch"
    git checkout "temp/$branch"

    popd > /dev/null

    echo "Submodule now pointing to $remote_url @ $branch."
}

case "$1" in
  --reset)
    reset
    ;;
  "")
    usage
    ;;
  *)
    [ -z "$2" ] && usage
    switch "$1" "$2"
    ;;
esac
