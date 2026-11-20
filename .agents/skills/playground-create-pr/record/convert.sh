#!/usr/bin/env bash
# Converts a Playwright .webm recording into an inline GIF and a full-quality MP4.
#
# usage: convert.sh <input.webm> <output-base> [--start S] [--end S] [--speed N] [--width W] [--fps F]
#   Writes <output-base>.gif and <output-base>.mp4 and prints their sizes.
#   --start/--end trim the recording (seconds, before speed-up); --speed > 1 speeds it up.
set -euo pipefail

if [[ $# -lt 2 ]]; then
	sed -n '2,6p' "$0" >&2
	exit 2
fi
input=$1 base=$2
shift 2
start="" end="" speed=1 width=1024 fps=10
while [[ $# -gt 0 ]]; do
	case $1 in
	--start) start=$2 ;;
	--end) end=$2 ;;
	--speed) speed=$2 ;;
	--width) width=$2 ;;
	--fps) fps=$2 ;;
	*) echo "unknown option: $1" >&2 && exit 2 ;;
	esac
	shift 2
done

trim=()
[[ -n $start ]] && trim+=(-ss "$start")
[[ -n $end ]] && trim+=(-to "$end")
mkdir -p "$(dirname "$base")"

ffmpeg -hide_banner -loglevel error -y ${trim[@]+"${trim[@]}"} -i "$input" \
	-vf "setpts=PTS/${speed},scale=trunc(iw/2)*2:trunc(ih/2)*2" \
	-an -c:v libx264 -pix_fmt yuv420p -crf 28 -movflags +faststart "$base.mp4"

ffmpeg -hide_banner -loglevel error -y ${trim[@]+"${trim[@]}"} -i "$input" \
	-vf "setpts=PTS/${speed},fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
	"$base.gif"

for f in "$base.gif" "$base.mp4"; do
	printf '%s\t%s\n' "$(du -h "$f" | cut -f1)" "$f"
done
gif_bytes=$(wc -c <"$base.gif")
if ((gif_bytes > 9 * 1024 * 1024)); then
	echo "warning: GIF is over 9 MB; GitHub may not render it inline. Trim, speed up, or lower --width/--fps." >&2
fi
