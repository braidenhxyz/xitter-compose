#!/bin/sh
# Brings this instance's live branch up to date (this fork only, not upstream):
# upstream's main and the fork's main go into main, main into live, every
# server file is build-checked, and live is pushed for the server to pull.
# Stops at the first conflict and says where, leaving the merge to finish.
#
#   scripts/update-live.sh            merge, check, push live
#   scripts/update-live.sh --no-push  merge and check only
#
# On the server afterwards: git pull && docker compose up -d --build
set -eu
# this file is only on live: checking out main would take it away mid-run, so
# it runs from a copy
if [ -z "${UPDATE_LIVE_COPY:-}" ]; then
	copy=$(mktemp)
	cp "$0" "$copy"
	UPDATE_LIVE_COPY=1 UPDATE_LIVE_REPO="$(cd "$(dirname "$0")/.." && pwd)" exec sh "$copy" "$@"
fi
cd "$UPDATE_LIVE_REPO"

push=1
[ "${1:-}" = "--no-push" ] && push=0

if [ -n "$(git status --porcelain)" ]; then
	echo "There are uncommitted changes; commit or stash them first:" >&2
	git status --short >&2
	exit 1
fi
start=$(git branch --show-current)

merge() { # into the branch checked out: $1, a message for when it conflicts
	if ! git merge --no-edit "$1" >/dev/null; then
		echo "" >&2
		echo "Merging $1 into $(git branch --show-current) conflicts in:" >&2
		git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
		echo "Fix those files, then: git add -A && git commit --no-edit, and run this again." >&2
		exit 1
	fi
}

echo "Fetching upstream and origin…"
git fetch -q upstream
git fetch -q origin

git checkout -q main
before_main=$(git rev-parse HEAD)
merge origin/main
merge upstream/main
echo "main: $(git rev-list --count "$before_main"..HEAD) new commit(s)"

git checkout -q live
before_live=$(git rev-parse HEAD)
merge origin/live
merge main
new=$(git rev-list --count "$before_live"..HEAD)
echo "live: $new new commit(s)"

# every server file must still build; bun, or bun through npx without it
if command -v bun >/dev/null 2>&1; then BUN=bun; else BUN="npx -y bun@1.2.23"; fi
tmp=$(mktemp -d)
failed=0
for f in src/*.ts src/*/*.ts scripts/fox-bot.ts; do
	[ -f "$f" ] || continue
	if ! $BUN build --no-bundle --target=bun "$f" --outfile "$tmp/out.js" >/dev/null 2>"$tmp/err"; then
		echo "Doesn't build: $f" >&2
		sed 's/^/  /' "$tmp/err" | head -8 >&2
		failed=1
	fi
done
# the admin panel's page script too
if command -v node >/dev/null 2>&1; then
	python3 -c "
import re,sys
s=open('src/admin.html').read()
open(sys.argv[1],'w').write('\n;\n'.join(re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>',s,re.S)))" "$tmp/admin.js" && node --check "$tmp/admin.js" 2>"$tmp/err" || { echo "src/admin.html's script doesn't parse:" >&2; head -8 "$tmp/err" >&2; failed=1; }
fi
rm -rf "$tmp"
if [ "$failed" = 1 ]; then
	echo "live is merged here but not pushed; fix the above first." >&2
	exit 1
fi
echo "Build check passed."

if [ "$push" = 1 ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/live)" ]; then
	git push -q origin live
	echo "Pushed live. On the server: git pull && docker compose up -d --build"
elif [ "$push" = 1 ]; then
	echo "live was already up to date; nothing to push."
fi
git checkout -q "$start"
rm -f "$0"
