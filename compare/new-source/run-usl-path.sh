#!/bin/sh
# Render the Zetaris setup scripts without and with the new table, and count what changed. Read-only: nothing is sent to Zetaris.
set -e
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
npx tsx compare/new-source/usl-path.ts --out "$tmp/before"
npx tsx compare/new-source/usl-path.ts --out "$tmp/after" --with-new
echo "--- generated lines changed (added/removed) per script"
diff -r "$tmp/before" "$tmp/after" | grep -E '^[<>]' | awk '{c[$1]++} END{print "added", c[">"], "removed", c["<"]}'
for f in "$tmp"/after/*; do n=$(basename "$f"); d=$(diff "$tmp/before/$n" "$f" | grep -cE '^[<>]' || true); [ "$d" != 0 ] && echo "  $n: $d"; done
echo "--- authored by hand"
node tools/count-lines.mjs compare/new-source/watchlist.spec.ts
rm -rf "$tmp"
