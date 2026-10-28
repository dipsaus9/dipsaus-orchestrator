// A connection from the Mac into dipo's box network (DIPO-343): bound to the box network's host
// address, the Mac's own address on the box bridge (`BoxNetwork.hostAddress`, the address the box
// firewall lets boxes reach). A VPN may route the box network's subnet into its tunnel; an unbound
// connect then goes there and never reaches the box, while one whose source is the bridge's address
// goes out on the bridge. Every connection dipo opens from the Mac to a box goes through here.

import { connect, isIP, type Socket } from "node:net";

import { BoxError } from "./port";

/** Where a connection into the box network goes, and the bridge address it leaves from. */
export interface BoxConnectTarget {
  /** The box's address on the box network. */
  readonly address: string;
  readonly port: number;
  /** The box network's host address (`BoxNetwork.hostAddress`); null when it is not known. */
  readonly hostAddress: string | null;
}

/** Opens a socket to `target` (the system's `connect`, or a test's). */
export type BoxConnector = (options: {
  readonly host: string;
  readonly port: number;
  readonly localAddress: string;
}) => Socket;

const systemConnector: BoxConnector = (options) => connect(options);

/**
 * Opens a TCP connection from the Mac to a box, its source bound to the box network's host
 * address. Fail-closed: without a host address that is an IP literal of the box's family it opens
 * nothing and throws `box.refused`, so no connection can leave by another route.
 */
export function connectToBox(
  target: BoxConnectTarget,
  open: BoxConnector = systemConnector,
): Socket {
  const family = isIP(target.address);
  if (target.hostAddress === null || family === 0 || isIP(target.hostAddress) !== family) {
    throw new BoxError(
      "box.refused",
      "dipo connects to a box only from the box network's host address, which is not known.",
      false,
      { address: target.address, hostAddress: target.hostAddress },
    );
  }
  return open({ host: target.address, port: target.port, localAddress: target.hostAddress });
}
