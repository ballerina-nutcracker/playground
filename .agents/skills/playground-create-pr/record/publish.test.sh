#!/usr/bin/env bash
# Exercises the publish CLI against a local bare origin; no GitHub requests.
set -euo pipefail

publisher=$(cd "$(dirname "$0")" && pwd)/publish.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
git init --quiet --bare origin.git
git init --quiet checkout
cd checkout
git -c user.name=Test -c user.email=test@example.invalid commit --quiet --allow-empty -m initial
git config user.name Test
git config user.email test@example.invalid
git switch --quiet -c 'fix/#148'
git remote add origin ../origin.git
mkdir bin before after
printf '#!/bin/sh\nprintf "PUBLIC\\n"\n' > bin/gh
chmod +x bin/gh
export PATH="$PWD/bin:$PATH"

printf 'first\n' > before/demo.gif
printf 'second\n' > after/demo.gif
if bash "$publisher" before/demo.gif after/demo.gif > output 2> error; then
	echo 'expected duplicate destinations to be rejected' >&2
	exit 1
fi
grep -Fxq 'error: duplicate media destination: fix-#148/demo.gif' error
test ! -s output
test -z "$(git --git-dir=../origin.git for-each-ref refs/heads/pr-media)"

git init --quiet --bare ../other.git
git remote set-url --push origin ../other.git
if bash "$publisher" before/demo.gif > output 2> error; then
	echo 'expected a mismatched push URL to be rejected' >&2
	exit 1
fi
grep -Fxq 'error: origin must have one push URL matching its fetch URL' error
test ! -s output
test -z "$(git --git-dir=../other.git for-each-ref refs/heads/pr-media)"
git config --unset remote.origin.pushurl

feature_commit=$(git rev-parse HEAD)
git push --quiet origin HEAD:refs/heads/feature/pr-media
printf 'video\n' > 'after/demo (#148).mp4'
links=$(bash "$publisher" before/demo.gif 'after/demo (#148).mp4')
commit=$(git --git-dir=../origin.git rev-parse refs/heads/pr-media)
grep -Fq "$commit/fix-%23148/demo.gif)" <<< "$links"
grep -Fq "$commit/fix-%23148/demo%20%28%23148%29.mp4)" <<< "$links"
test "$(git --git-dir=../origin.git show "$commit:fix-#148/demo.gif")" = first
test "$(git --git-dir=../origin.git show "$commit:fix-#148/demo (#148).mp4")" = video
test "$(git --git-dir=../origin.git rev-list --parents -n 1 "$commit")" = "$commit"
test "$(git --git-dir=../origin.git rev-parse refs/heads/feature/pr-media)" = "$feature_commit"

# When both refs exist, the exact media ref is the parent and its files stay.
printf 'follow-up\n' > after/next.gif
bash "$publisher" after/next.gif > /dev/null
next_commit=$(git --git-dir=../origin.git rev-parse refs/heads/pr-media)
test "$(git --git-dir=../origin.git rev-parse "$next_commit^1")" = "$commit"
test "$(git --git-dir=../origin.git show "$next_commit:fix-#148/demo.gif")" = first
test "$(git --git-dir=../origin.git show "$next_commit:fix-#148/next.gif")" = follow-up
