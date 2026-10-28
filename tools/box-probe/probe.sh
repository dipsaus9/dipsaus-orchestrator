#!/bin/sh
# The escape probe of 0008 (DIPO-264; the Safe-Chain box and dipo's own web route since DIPO-343),
# run by hand. Results are in RESULTS.md.
#
# Fill in before running (placeholders keep the maintainer's machine out of the repository):
#   MAC_LAN_IP      the Mac's own address on its local network
#   ROUTER_IP       the local network's router
#   ALL_IF_PORT     a port of a Mac program that listens on all interfaces
#   LOOPBACK_PORT   a port of a Mac program that listens on 127.0.0.1 only
#   START_COMMIT    the commit whose code goes into the developer box
# Every check only asks whether something answers or is readable; none reads secret contents.
#
# Two boxes on dipo's host-only box network (`dipo-boxes`):
# - The developer box: Alpine with the code copied in, behind dipo's box firewall as a session sets
#   it (the rule text is dipo's own `firewallRules`). Every check runs as root, the worst case: a
#   worker runs as the box user, with no capability.
# - The Safe-Chain box: started by dipo's own web route (`web-proxy.ts`), from the machine-wide
#   Safe-Chain image, behind its own firewall. Its checks run as root through `container exec`.
# Each line prints what happened; RESULTS.md says what each must print.
set -eu
: "${MAC_LAN_IP:?}" "${ROUTER_IP:?}" "${ALL_IF_PORT:?}" "${LOOPBACK_PORT:?}" "${START_COMMIT:?}"
IMAGE=docker.io/library/alpine:3.20
NET=dipo-boxes
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/box-probe.XXXX")

# dipo's box network, made as dipo makes it when it is missing (it is never deleted here).
container network inspect "$NET" >/dev/null 2>&1 ||
  container network create --internal --label dipo=network "$NET"
HOST_IP=$(container network inspect "$NET" | sed -n 's/.*"ipv4Gateway" : "\(.*\)".*/\1/p')

# The developer box: nothing mounted, no SSH forwarding (no --ssh), the code at START_COMMIT copied
# in without .git, and the one capability dipo's boxes get for their firewall.
mkdir "$WORK/code"
git -C "$REPO" archive "$START_COMMIT" | tar -x -C "$WORK/code"
container run -d --name probe-box --network "$NET" --cap-add CAP_NET_ADMIN "$IMAGE" sleep 3600
container cp "$WORK/code/." probe-box:/work
container exec probe-box sh -c 'id; [ -e /work/.git ] && echo ".git present" || echo ".git absent"; env | cut -d= -f1'

# Without the proxy: the Mac, the LAN, the internet and a registry, straight from the box (as root).
REGISTRY_IP=$(dig +short registry.npmjs.org A | tail -n 1)
container exec probe-box sh -c "
  for t in $HOST_IP:$ALL_IF_PORT $HOST_IP:$LOOPBACK_PORT $MAC_LAN_IP:$ALL_IF_PORT $ROUTER_IP:80 1.1.1.1:443 $REGISTRY_IP:443; do
    nc -z -w2 \${t%:*} \${t#*:} && echo \"OPEN \$t\" || echo \"closed \$t\"; done
  wget -q -T5 -O /dev/null https://example.com && echo 'internet: yes' || echo 'internet: no'
  wget -q -T5 -O /dev/null https://registry.npmjs.org/ && echo 'registry direct: yes' || echo 'registry direct: no'"

# The web route: dipo's own, with the Safe-Chain box behind it. It listens on the box network's
# address, which exists while the developer box runs.
(tail -f /dev/null | bun "$HERE/web-proxy.ts" "$WORK/route" "$WORK/ca.pem" > "$WORK/route.log" 2>&1 &)
until grep -qE '^ready|did not start' "$WORK/route.log" 2>/dev/null; do sleep 2; done
READY=$(grep '^ready' "$WORK/route.log")
field() { printf '%s\n' "$READY" | tr ' ' '\n' | sed -n "s/^$1=//p"; }
P=$(field proxy)
SC_BOX=$(field safe-chain-box)
SC_IP=$(field safe-chain-address)
U=$(field upstream)
P_PORT=${P##*:}
echo "web proxy $P, Safe-Chain box $SC_BOX at $SC_IP, upstream listener $U"
container cp "$WORK/ca.pem" probe-box:/ca.pem
container cp "$HERE/tls-naming.js" probe-box:/tls-naming.js

# The developer box's tools, through the proxy, then dipo's firewall as a session sets it.
container exec probe-box sh -c "https_proxy=$P http_proxy=$P apk add --no-cache curl nodejs npm nftables >/dev/null 2>&1"
RULE=$(cd "$REPO" && bun -e 'import { firewallRules } from "./packages/engine/src/box/firewall"; console.log(firewallRules({ hostAddress: process.argv[1], ports: [Number(process.argv[2])] }))' "$HOST_IP" "$P_PORT")
container exec probe-box nft "$RULE"

# From the developer box, behind its firewall: the Mac, the Safe-Chain box, the upstream listener.
container exec probe-box sh -c "
  for t in $HOST_IP:$ALL_IF_PORT $HOST_IP:$LOOPBACK_PORT $MAC_LAN_IP:$ALL_IF_PORT $SC_IP:8101 $SC_IP:8102 $SC_IP:22 ${U#http://}; do
    nc -z -w2 \${t%:*} \${t#*:} && echo \"OPEN \$t\" || echo \"closed \$t\"; done"

# Through the proxy: only public internet addresses, and the registries only through Safe-Chain.
container exec probe-box sh -c "
  P=$P
  try() { echo \"\$1 -> \$(curl -x \$P -sS -m 8 -o /dev/null -w '%{http_code}' \$3 \"\$2\" 2>&1 | tail -1)\"; }
  try 'Mac loopback by address' https://127.0.0.1:$LOOPBACK_PORT/
  try 'Mac loopback by name' https://localhost:$LOOPBACK_PORT/
  try 'public name pointing at 127.0.0.1' https://localtest.me:$LOOPBACK_PORT/
  try 'Mac LAN address' https://$MAC_LAN_IP:$ALL_IF_PORT/
  try 'router' https://$ROUTER_IP/
  try 'box network host' https://$HOST_IP:$ALL_IF_PORT/
  try 'the Safe-Chain box' https://$SC_IP:8101/
  try 'registry by IP literal' https://$REGISTRY_IP/
  try 'registry alias' https://registry.npmjs.com/
  try 'registry CDN name' https://registry.npmjs.org.cdn.cloudflare.net/
  HTTPS_PROXY=$P node /tls-naming.js
  try 'internet' https://example.com/
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=\$P npm --prefix /tmp/a install is-number@7.0.0 >/dev/null 2>&1 && echo 'registry via Safe-Chain: installed'
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=\$P npm --prefix /tmp/b install safe-chain-test 2>&1 | grep -m1 -o '403 Forbidden\|blocked by safe-chain'
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=http://$SC_IP:8101 npm --prefix /tmp/c --fetch-retries 0 --fetch-timeout 10000 install is-odd@3.0.1 >/dev/null 2>&1 && echo 'proxy set to the Safe-Chain box: installed' || echo 'proxy set to the Safe-Chain box: failed'
  NODE_EXTRA_CA_CERTS=/ca.pem https_proxy=$U npm --prefix /tmp/d --fetch-retries 0 --fetch-timeout 10000 install is-odd@3.0.1 >/dev/null 2>&1 && echo 'proxy set to the upstream listener: installed' || echo 'proxy set to the upstream listener: failed'"

# Switching off the network rules: as an unprivileged user (as a worker runs), then as root.
container exec probe-box sh -c "
  su -s /bin/sh nobody -c 'nft flush ruleset' >/dev/null 2>&1 && echo 'flush as a user: flushed' || echo 'flush as a user: refused'
  nft flush ruleset && echo 'flush as root: flushed'
  for t in $MAC_LAN_IP:$ALL_IF_PORT $ROUTER_IP:80 1.1.1.1:443 $REGISTRY_IP:443 $SC_IP:8101; do
    nc -z -w2 \${t%:*} \${t#*:} && echo \"after the flush OPEN \$t\" || echo \"after the flush closed \$t\"; done"

# The Safe-Chain box, as root: nothing of the Mac's, no way out but the upstream listener, and the
# upstream listener reaches only the hosts Safe-Chain checks.
container exec "$SC_BOX" sh -c "
  id -u; env | cut -d= -f1 | sort | tr '\n' ' '; echo
  ls /Users /root/.npmrc /root/.ssh 2>&1 | sed 's/^/files: /'
  for t in $HOST_IP:$ALL_IF_PORT $HOST_IP:$LOOPBACK_PORT $HOST_IP:$P_PORT $MAC_LAN_IP:$ALL_IF_PORT $ROUTER_IP:80 1.1.1.1:443 $REGISTRY_IP:443; do
    timeout 3 bash -c \"exec 3<>/dev/tcp/\${t%:*}/\${t#*:}\" 2>/dev/null && echo \"OPEN \$t\" || echo \"closed \$t\"; done
  try() { echo \"upstream: \$1 -> \$(curl -x $U -sS -m 8 -o /dev/null -w '%{http_code}' \"\$2\" 2>&1 | tail -1)\"; }
  try 'registry' https://registry.npmjs.org/is-number
  try 'malware lists' https://malware-list.aikido.dev/
  try 'internet' https://example.com/
  try 'registry alias' https://registry.npmjs.com/
  try 'Mac loopback by name' https://localhost:$LOOPBACK_PORT/
  /dipo-net/ld.so --library-path /dipo-net/lib /dipo-net/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- /dipo-net/ld.so --library-path /dipo-net/lib /dipo-net/bin/nft flush ruleset >/dev/null 2>&1 && echo 'flush as the box user: flushed' || echo 'flush as the box user: refused'"

cat "$WORK/route.log"

# Stop and start keep the files.
container stop probe-box && container start probe-box
container exec probe-box sh -c '[ -f /work/package.json ] && echo "files kept after restart"'

# The login (decision 11) is a separate, manual step: the maintainer starts model-proxy.ts serve in
# their own terminal with the token, one request runs from the box with ANTHROPIC_BASE_URL on the
# model proxy, a placeholder key and NO_PROXY for HOST_IP, and model-proxy.ts check reports whether
# the token occurs in the box. See RESULTS.md.

# The route stops with its stdin: the Safe-Chain box is deleted with it. dipo's network stays.
pkill -TERM -f "$HERE/web-proxy.ts" || true
until ! container list --all | grep -q "$SC_BOX"; do sleep 1; done
echo "the Safe-Chain box is gone with the route"
container stop probe-box && container rm probe-box
rm -rf "$WORK"
