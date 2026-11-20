#!/usr/bin/env bash
# Publishes PR media to the `pr-media` branch of the `origin` remote, without
# touching the working tree, index or current branch, and prints Markdown for
# the PR description. URLs are pinned to the media commit.
#
# usage: publish.sh <file>...
set -euo pipefail

if [[ $# -eq 0 ]]; then
	sed -n '2,6p' "$0" >&2
	exit 2
fi

branch=$(git branch --show-current)
dir=${branch//\//-}
[[ -n $dir ]] || dir=detached-$(git rev-parse --short HEAD)

paths=() encoded_paths=()
for file in "$@"; do
	path="$dir/$(basename -- "$file")"
	for previous in ${paths[@]+"${paths[@]}"}; do
		if [[ $path == "$previous" ]]; then
			printf 'error: duplicate media destination: %s\n' "$path" >&2
			exit 2
		fi
	done
	paths+=("$path")
	encoded=$(jq -rn --arg path "$path" '$path | split("/") | map(@uri) | join("/")')
	encoded_paths+=("$encoded")
done

remote=origin media_branch=pr-media
url=$(git remote get-url "$remote")
# The visibility check, parent lookup and Markdown must all describe the
# destination Git will publish to. Reject separate or multiple push URLs.
if [[ $(git remote get-url --push --all "$remote") != "$url" ]]; then
	echo "error: $remote must have one push URL matching its fetch URL" >&2
	exit 2
fi
repo=$(sed -E 's#^(git@github\.com:|https://github\.com/|ssh://git@github\.com/)##; s#\.git$##' <<<"$url")
visibility=$(gh repo view "$repo" --json visibility --jq .visibility)
if [[ $visibility != PUBLIC ]]; then
	echo "error: $repo is $visibility; PR reviewers may not be able to see media hosted there" >&2
	exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE=$tmp/index

parent=""
media_ref="refs/heads/$media_branch"
# ls-remote patterns match ref tails; compare the returned ref name exactly.
remote_refs=$(git ls-remote --heads "$remote" "$media_ref")
if awk -v ref="$media_ref" '$2 == ref { found = 1 } END { exit !found }' <<<"$remote_refs"; then
	git fetch --quiet --no-tags "$remote" "+$media_ref:refs/remotes/$remote/$media_branch"
	parent=$(git rev-parse "refs/remotes/$remote/$media_branch")
	git read-tree "$parent"
else
	git read-tree --empty
fi

i=0
for file in "$@"; do
	blob=$(git hash-object -w -- "$file")
	git update-index --add --cacheinfo "100644,$blob,${paths[i]}"
	i=$((i + 1))
done

tree=$(git write-tree)
commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "media: $dir")
# The media branch holds no code, so skip the repository's pre-push test hook.
git push --quiet --no-verify "$remote" "$commit:refs/heads/$media_branch"

for i in "${!paths[@]}"; do
	path=${paths[i]}
	encoded=${encoded_paths[i]}
	label=${path##*/}
	label=${label//\\/\\\\}
	label=${label//\[/\\[}
	label=${label//\]/\\]}
	case $path in
	*.gif | *.png | *.jpg | *.jpeg | *.webp) printf '![%s](https://raw.githubusercontent.com/%s/%s/%s)\n' "$label" "$repo" "$commit" "$encoded" ;;
	*) printf '[%s](https://github.com/%s/blob/%s/%s)\n' "$label" "$repo" "$commit" "$encoded" ;;
	esac
done
