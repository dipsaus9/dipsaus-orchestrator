#!/bin/sh
# A stand-in for Claude in the CI-only host tests: it reads the first stdin line, writes its PID,
# prints stream lines and waits until the test creates `release` next to it, then exits 0.
dir=$(dirname "$0")
read -r first
echo $$ > "$dir/worker.pid"
printf '{"type":"stub","first":%s}\n' "$first"
while [ ! -f "$dir/release" ]; do sleep 0.1; done
echo '{"type":"done"}'
exit 0
