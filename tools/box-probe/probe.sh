#!/bin/sh
# The escape probe of decision 0021 section 16 (DIPO-264), as it was run on 2026-10-21. Probe code,
# run by hand with the maintainer watching; results are in RESULTS.md.
#
# Fill in before running (placeholders keep the maintainer's machine out of the repository):
#   MAC_LAN_IP      the Mac's own address on its local network
#   ROUTER_IP       the local network's router
#   ALL_IF_PORT     a port of a Mac program that listens on all interfaces
#   LOOPBACK_PORT   a port of a Mac program that listens on 127.0.0.1 only
#   START_COMMIT    the commit whose code goes into the box (the probe used origin/main)
# Every check only asks whether something answers or is readable; none reads secret contents.
set -eu
: "${MAC_LAN_IP:?}" "${ROUTER_IP:?}" "${ALL_IF_PORT:?}" "${LOOPBACK_PORT:?}" "${START_COMMIT:?}"
IMAGE=docker.io/library/alpine:3.20
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/box-probe.XXXX")

# Box setup: a host-only network, a box with nothing mounted and no SSH forwarding (no --ssh), and
# the code at START_COMMIT copied in without .git.
container network create --internal probe-internal
HOST_IP=$(container network inspect probe-internal | sed -n 's/.*"ipv4Gateway" : "\(.*\)".*/\1/p')
mkdir "$WORK/code"
git -C "$HERE/../.." archive "$START_COMMIT" | tar -x -C "$WORK/code"
container run -d --name probe-box --network probe-internal "$IMAGE" sleep 3600
container cp "$WORK/code/." probe-box:/work
container exec probe-box sh -c 'id; [ -e /work/.git ] && echo ".git present" || echo ".git absent"; env | cut -d= -f1'

# Without the proxy: the Mac, the LAN, the internet and a registry, straight from the box (as root).
container exec probe-box sh -c "
  for t in $HOST_IP:$ALL_IF_PORT $HOST_IP:$LOOPBACK_PORT $MAC_LAN_IP:$ALL_IF_PORT $ROUTER_IP:80 1.1.1.1:443; do
    nc -z -w2 \${t%:*} \${t#*:} && echo \"OPEN \$t\" || echo \"closed \$t\"; done
  wget -q -T5 -O /dev/null https://example.com && echo 'internet: yes' || echo 'internet: no'
  wget -q -T5 -O /dev/null https://registry.npmjs.org/ && echo 'registry direct: yes' || echo 'registry direct: no'"

# The web route: dipo's web proxy on the box network's host address, Safe-Chain behind it.
(tail -f /dev/null | bun "$HERE/web-proxy.ts" "$HOST_IP" 3128 "$WORK/ca.pem" > "$WORK/proxy.log" 2>&1 &)
until grep -qE '^ready|did not start' "$WORK/proxy.log" 2>/dev/null; do sleep 2; done
container cp "$WORK/ca.pem" probe-box:/ca.pem

# Through the proxy: only public internet addresses and the registries (through Safe-Chain).
container exec probe-box sh -c "
  P=http://$HOST_IP:3128
  https_proxy=\$P http_proxy=\$P apk add --no-cache curl nodejs npm >/dev/null 2>&1
  try() { echo \"\$1 -> \$(curl -x \$P -sS -m 8 -o /dev/null -w '%{http_code}' \"\$2\" 2>&1 | tail -1)\"; }
  try 'Mac loopback by address' https://127.0.0.1:$LOOPBACK_PORT/
  try 'Mac loopback by name' https://localhost:$LOOPBACK_PORT/
  try 'public name pointing at 127.0.0.1' https://localtest.me:$LOOPBACK_PORT/
  try 'Mac LAN address' https://$MAC_LAN_IP:$ALL_IF_PORT/
  try 'router' https://$ROUTER_IP/
  try 'box network host' https://$HOST_IP:$ALL_IF_PORT/
  try 'registry by IP literal' https://104.16.3.34/
  try 'registry with a trailing dot' https://registry.npmjs.org./
  try 'internet' https://example.com/
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=\$P npm --prefix /tmp/a install is-number@7.0.0 >/dev/null 2>&1 && echo 'registry via Safe-Chain: installed'
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=\$P npm --prefix /tmp/b install safe-chain-test 2>&1 | grep -m1 'blocked by safe-chain'"
cat "$WORK/proxy.log"

# Measurements: memory, and stop and start keep the files.
container stats --no-stream probe-box
container stop probe-box && container start probe-box
container exec probe-box sh -c '[ -f /work/package.json ] && echo "files kept after restart"'

# A test box's way in (DIPO-309): a listener in the box on the dev port, reached from the Mac the
# way dipo's forwarder connects, from the box network's host address; a plain connection is printed
# too (a VPN that routes the box network's range takes it elsewhere). The test box's firewall rule
# itself is checked on boxes of the office image by test-box.box.test.ts (DIPO_TEST_BOX=1).
BOX_IP=$(container exec probe-box sh -c 'ip -4 addr show eth0' | sed -n 's/.*inet \([0-9.]*\).*/\1/p')
container exec -d probe-box sh -c 'while true; do printf "HTTP/1.0 200 OK\r\n\r\ntest box\n" | nc -l -p 5173; done'
sleep 2
curl -sS -m 5 -o /dev/null -w 'from the box network host: %{http_code}\n' --interface "$HOST_IP" "http://$BOX_IP:5173/" || true
curl -sS -m 5 -o /dev/null -w 'plain: %{http_code}\n' "http://$BOX_IP:5173/" || true
route -n get "$BOX_IP" | sed -n 's/ *interface: /route to the box: /p'

# The login (decision 11) is a separate, manual step: the maintainer starts model-proxy.ts serve in
# their own terminal with the token, one request runs from the box with ANTHROPIC_BASE_URL on the
# model proxy, a placeholder key and NO_PROXY for HOST_IP, and model-proxy.ts check reports whether
# the token occurs in the box. See RESULTS.md.

pkill -TERM -f "$HERE/web-proxy.ts" || true
container stop probe-box && container rm probe-box
container network delete probe-internal
rm -rf "$WORK"
