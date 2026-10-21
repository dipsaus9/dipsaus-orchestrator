# Box probe results (DIPO-264)

Results of the escape probe that decision 0021 (section 16) makes the gate. They were run by hand on 2026-10-21, with the maintainer watching, on macOS 26.6 (Apple silicon) with Apple `container` 1.6.0 and its recommended default kernel. The box image is `docker.io/library/alpine:3.20`, and the box code came from `origin/main` (`git archive`, so no `.git`).

Every command is in `probe.sh`, with placeholders for the Mac's own addresses and ports. Every check ran as root in the box (`uid=0`).

## Escape table

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

## How the network is enforced

- Each box joins a host-only network (`container network create --internal`). It has no route to the internet, the local network or a VPN.
- The box's only way out is dipo's web proxy (`web-proxy.ts`), which listens only on the box network's address on the Mac:
  - Tunnels to the npm and PyPI registries go to dipo's Safe-Chain proxy (`startSafeChainProxy`). The host name is normalised first, so a trailing dot changes nothing.
  - Every other tunnel is allowed only to a **public internet address**. The proxy resolves the name once and connects to that address. It refuses bare IP addresses and names that resolve to:
    - the Mac itself;
    - a private, shared (VPN-style), link-local or multicast range;
    - the box network.
- The host-only network and the proxy are both outside the box, and the box cannot change them.
- The first version of the proxy passed any target, so a box could reach the Mac's loopback services, the local network and a registry without Safe-Chain. The review of this probe caught it, and every line was then tested again through the fixed proxy.

## The Claude login (decision 11)

- The box's Claude Code (2.1.303 from npm, installed through Safe-Chain) has a placeholder key, `ANTHROPIC_BASE_URL` set to the model proxy, and `NO_PROXY` for the box network's host address.
- The model proxy (`model-proxy.ts`) runs on the Mac, started by the maintainer in their own terminal. It:
  - passes only model requests (`/v1/messages`) and does not follow redirects;
  - replaces the placeholder with the maintainer's subscription login (a `claude setup-token` token);
  - forwards to the Anthropic API.
- One live request (`claude -p "Reply with OK" --model haiku`, with the maintainer's OK) returned `OK`, exit 0.
- The token was never in the box and was never seen by the session running the probe.
- **The first choice of decision 11 works.** The fallback (a token inside the box) is not needed.
- The path limit and the redirect setting were added after that request. The build story's proxy keeps both.

## Accepted risk (maintainer, 2026-10-21)

On the host-only network the Mac is the box's neighbour, so a box can reach services on the Mac that listen on all interfaces. The web proxy does not give this access; the direct network link does. Blocking it needs a firewall:
- inside the box: the maintainer's chosen option, a rule set at box start that the worker cannot change;
- or on the Mac.

It could not be built in this session. The maintainer accepted the risk for now.

## Measurements

| What | Result |
|---|---|
| First box start (one-time download of the 66 MB init image) | about 18.6 s |
| Box start with a warm image | about 1 s |
| Copy of the dipo code (14 MB, no `.git`) into a box with `container cp` | under 1 s |
| Memory of an idle box | 7.2 MiB, of a **1 GiB default limit** that Apple `container` sets unless told otherwise |
| Stop and start a box again | about 0 s; the files are kept |

## Findings for the stories

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
