# Box probe results (DIPO-264, DIPO-343)

## Run of 2026-10-27: the Safe-Chain box (DIPO-343)

The probe ran again after Safe-Chain moved into a box of its own and the box firewall gained the Safe-Chain box's input chain (`firewall.ts`). It ran on macOS 26.6.2 (Apple silicon) with Apple `container` 1.6.0, by the builder of DIPO-343, against boxes the probe itself started: the developer box (Alpine 3.20, the code of `origin/main` at `15923c32`, no `.git`) and the Safe-Chain box that dipo's own web route started (`web-proxy.ts`, from the machine-wide Safe-Chain image, Safe-Chain 1.5.12). The Mac's services were two stand-ins, one on all interfaces and one on loopback. Every check ran as root, the worst case; a worker runs as the box user with no capability.

**Every line passes** (two root-only lines are the accepted risk, as before):

| Attempt | Must | Result |
|---|---|---|
| Developer box: read the home folder, `.git`, host environment, SSH agent | fail | **fails**: nothing mounted, `.git` absent, environment `SHLVL HOME PATH PWD` |
| Developer box without dipo's firewall: the Mac on all interfaces | (shows what the rule closes) | open, as on 2026-10-21 |
| Developer box behind dipo's firewall: the Mac (all interfaces, loopback port, local-network address), the Safe-Chain box's ports 8101, 8102 and 22, dipo's upstream listener | fail | **fails**: every one closed |
| Developer box: the router, the internet, a registry, straight out | fail | **fails**: closed, no DNS, no route |
| Through the web proxy: the Mac's loopback by address, by name and by a public name, its local-network address, the router, the box network, the Safe-Chain box, a registry's IP address | fail | **fails**: 403 for each |
| Through the web proxy: a registry alias, a registry's CDN name | fail | **fails**: 403 |
| Through the web proxy: a tunnel to `example.com` whose TLS handshake names `registry.npmjs.org` | fail | **fails**: closed before the registry answers |
| Through the web proxy: the internet | work | **works**: 200 |
| An install through the Safe-Chain box | work | **works**: `is-number@7.0.0` installs; `safe-chain-test` is refused (`403 Forbidden`, `blocked by safe-chain`) |
| The proxy setting changed in the box: to the Safe-Chain box, to the upstream listener | fail | **fails**: the install fails |
| Switch off the network rules as an unprivileged user | fail | **fails**: `nft flush ruleset` refused |
| Switch off the network rules as root (root only: dipo never runs worker code as root with the network capability, 0008) | fail for the internet, the local network and the registries | **fails** for those, and for the Safe-Chain box; the Mac's own local-network address is then reachable, the accepted risk of 2026-10-21 |
| Safe-Chain box: the maintainer's files and settings | fail | **fails**: environment `HOME PATH PWD`, no `/Users`, `.npmrc` or `.ssh` |
| Safe-Chain box: the Mac (all interfaces, loopback port, the web proxy), its local-network address, the router, the internet, a registry, straight out | fail | **fails**: every one closed |
| Safe-Chain box through the upstream listener: a registry, the malware lists | work | **works**: 200 and an answer from Aikido |
| Safe-Chain box through the upstream listener: the internet, a registry alias, the Mac's loopback | fail | **fails**: refused, each "not a host Safe-Chain reaches" |
| Safe-Chain box: switch off its firewall as the box user | fail | **fails**: refused |
| The Safe-Chain box after the route stops | gone | **gone**: deleted with the route |

The same lines run as a test against the real path in `packages/engine/test/box/safe-chain-box.ci.test.ts`, with the developer box made from an office image and every try as the box user.

## Run of 2026-10-21 (DIPO-264)

Results of the escape probe that decision 0021 (section 16) makes the gate. They were run by hand on 2026-10-21, with the maintainer watching, on macOS 26.6 (Apple silicon) with Apple `container` 1.6.0 and its recommended default kernel. The box image is `docker.io/library/alpine:3.20`, and the box code came from `origin/main` (`git archive`, so no `.git`).

Every command was in `probe.sh` as it was then, with placeholders for the Mac's own addresses and ports. Every check ran as root in the box (`uid=0`).

### Escape table

| Attempt from inside the box | Must | Result |
|---|---|---|
| Read a file from the maintainer's home folder | fail | **fails**: nothing is mounted. The box sees only its own filesystem and the code copied in with `container cp` |
| Connect to the Mac: dipo's socket, any local port | fail | **partly**. dipo's socket is a Unix socket and not reachable. Ports bound to `127.0.0.1` are reachable neither directly nor through the web proxy. **Services on the Mac that listen on all interfaces are reachable directly** over the box network (not through the proxy, which refuses them). Accepted risk, see below |
| Reach the router or another device on the local network | fail | **fails**: there is no route on the host-only network, and the web proxy refuses private and local addresses |
| Reach a package registry directly | fail | **fails**: there is no route out except the web proxy, and the proxy sends registry names to Safe-Chain (also with a trailing dot) and refuses bare IP addresses |
| Install a package through Safe-Chain | work | **works**: `is-number@7.0.0` installs; Safe-Chain's test package is refused with `403 Forbidden - blocked by safe-chain` |
| Reach the internet | work | **works** through the web proxy (`https://example.com`, HTTP 200). Without the proxy there is no route and no DNS |
| Find the SSH agent, host environment variables or `.npmrc` | fail | **fails**: the box's environment is only `SHLVL HOME PATH PWD`. There is no SSH agent (`--ssh` is not passed) and no host files |
| As root, switch off the network rules | fail | **fails** for the internet, the local network and the registries: those limits come from the host-only network and the web proxy, both outside the box. **No rule exists yet for the Mac's own services** (the accepted risk), so there is nothing to switch off there |
| Find the Claude token in the box | fail | **fails**: after a live request, the token is in neither the box's environment nor its files. The model proxy checked this itself and reported only yes or no |

### How the network is enforced

- Each box joins a host-only network (`container network create --internal`). It has no route to the internet, the local network or a VPN.
- The box's only way out is dipo's web proxy (`web-proxy.ts`), which listens only on the box network's address on the Mac:
  - Tunnels to the npm and PyPI registries go to dipo's Safe-Chain proxy (`startSafeChainProxy`). The host name is normalised first, so a trailing dot changes nothing.
  - Every other tunnel is allowed only to a **public internet address**. The proxy resolves the name once and connects to that address. It refuses bare IP addresses and names that resolve to:
    - the Mac itself;
    - a private, shared (VPN-style), link-local or multicast range;
    - the box network.
- The host-only network and the proxy are both outside the box, and the box cannot change them.
- The first version of the proxy passed any target, so a box could reach the Mac's loopback services, the local network and a registry without Safe-Chain. The review of this probe caught it, and every line was then tested again through the fixed proxy.

### The Claude login (decision 11)

- The box's Claude Code (2.1.303 from npm, installed through Safe-Chain) has a placeholder key, `ANTHROPIC_BASE_URL` set to the model proxy, and `NO_PROXY` for the box network's host address.
- The model proxy (`model-proxy.ts`) runs on the Mac, started by the maintainer in their own terminal. It:
  - passes only model requests (`/v1/messages`) and does not follow redirects;
  - replaces the placeholder with the maintainer's subscription login (a `claude setup-token` token);
  - forwards to the Anthropic API.
- One live request (`claude -p "Reply with OK" --model haiku`, with the maintainer's OK) returned `OK`, exit 0.
- The token was never in the box and was never seen by the session running the probe.
- **The first choice of decision 11 works.** The fallback (a token inside the box) is not needed.
- The path limit and the redirect setting were added after that request. The build story's proxy keeps both.

### Accepted risk (maintainer, 2026-10-21)

On the host-only network the Mac is the box's neighbour, so a box can reach services on the Mac that listen on all interfaces. The web proxy does not give this access; the direct network link does. Blocking it needs a firewall:
- inside the box: the maintainer's chosen option, a rule set at box start that the worker cannot change;
- or on the Mac.

It could not be built in this session. The maintainer accepted the risk for now.

### Measurements

| What | Result |
|---|---|
| First box start (one-time download of the 66 MB init image) | about 18.6 s |
| Box start with a warm image | about 1 s |
| Copy of the dipo code (14 MB, no `.git`) into a box with `container cp` | under 1 s |
| Memory of an idle box | 7.2 MiB, of a **1 GiB default limit** that Apple `container` sets unless told otherwise |
| Stop and start a box again | about 0 s; the files are kept |

### Findings for the stories

- Apple `container` sets a 1 GiB memory limit by default. To honour decision 16 (no limits), dipo must set an explicit high limit per box.
- The box's model base URL must bypass the web proxy (`NO_PROXY=<box network host address>`). Without it, Claude Code sends its model requests to the web proxy.
- npm's newest Claude Code (2.1.303) lagged the native installer's (2.1.306), so the box image needs a deliberate version choice.
- With full web access, Safe-Chain checks installs from the known registries only. A package fetched from anywhere else (another mirror, a direct download link) takes the direct route unchecked. This follows from decision 10 combined with Safe-Chain.
- The web proxy's address rule recognises private hosts by their address range. It does not recognise:
  - a host that a VPN serves on a public address range;
  - a home network's global IPv6 addresses, or its own public IPv4 address reached back through the router;
  - IPv6 forms that embed a private IPv4 address (`64:ff9b::/96`, `2002::/16`).

  Lines 2 and 3 were tested over IPv4 only. The build story's proxy should also refuse the Mac's own interface addresses and its on-link prefixes, plus those two IPv6 ranges.
- The registry check goes by name. A public alias of a registry, or a tunnel to another name on the same CDN that then asks for the registry in its TLS handshake, reaches the registry directly and skips Safe-Chain. Line 4 holds for the registry's own names and for IP literals only.
- The default (NAT) network had no internet on this Mac; the cause is not known. The design does not use that path.

## Run of 2026-10-28 (DIPO-346): git in the image, a box-local repository

DIPO-346 changed the image build (every office image now has git from Debian's archive) and what a box holds (dipo runs `git init` in `/work` as the box user and commits the start state; parts leave the box without `/work/.git`). The probe ran again on 2026-10-28, on Apple `container` 1.6.0, against boxes it started itself (`probe-box` on `probe-internal`), with two listeners of its own on the Mac (one on all interfaces, one on loopback only) and the branch head as `START_COMMIT`.

- Every line of the escape table came out as on 2026-10-21. Without the proxy: no internet, no registry, no router; the Mac's loopback-only port is closed; the all-interfaces port answers on the box network and on the Mac's LAN address (the accepted risk above; the probe's Alpine box has no box firewall, which dipo's boxes have since DIPO-281). Through the web proxy: the Mac's loopback by address, by name and through a public name, the LAN address, the router, the box network host and a registry IP literal are refused; a registry with a trailing dot goes to Safe-Chain; the internet answers 200; `is-number` installs through Safe-Chain and `safe-chain-test` is refused with `403 Forbidden - blocked by safe-chain`. The box's environment is only `SHLVL HOME PATH PWD`, and its files are kept across a stop and start.
- The probe's box is Alpine, not the office image, so the git lines were checked in a box of the office image by `packages/engine/test/box/box-git.box.test.ts` (`DIPO_TEST_BOX=1`), which passed on the same day: the box's repository is the box user's, holds one commit of the start state, no remote, no other ref and no hooks; a test that needs git passes as dipo's verify in the box; a part leaves the box without `.git`, also after the worker committed, set `core.hooksPath` and added a remote there, and no hook runs on the Mac; a symlink to `.git` or to `.git/config`, a `.git` file below the root and a nested repository are each refused with nothing committed; a part that carries a changed `.git/config` (the exclude dropped on its way into the box) is refused, nothing is committed or pushed, and the Mac repository's config, refs and hooks are unchanged.
