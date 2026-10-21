// The image build's proxy (DIPO-271; 0021 amendment of 2026-10-21 for DIPO-266). `ensureBoxImage`
// takes the proxy a build reaches the network through from its caller; this is that caller:
//
// - an image that already exists is reused and no proxy starts;
// - otherwise the builder is started, the Mac's address on its network found (`buildNetwork`, as
//   the box network's address is found), dipo's web route started there (the web proxy with
//   Safe-Chain behind it, so the box web proxy's address rules apply: only public internet
//   addresses, never the Mac's own addresses, its on-link prefixes or the builder's network), the
//   image built through it, and the route stopped again, whatever the build's result.
//
// The builder runs on Apple `container`'s default network, not the host-only box network (`container
// build` has no network option), so the proxy listens on that network's host address.

import type { BoxBuildProxy, BoxImageDescription, BoxImageResult } from "./image";
import { boxImageTag, ensureBoxImage } from "./image";
import { BoxError, type BoxBuildNetwork, type BoxCallOptions, type BoxPort } from "./port";
import type { BoxWebRouteStart } from "./web-proxy";

export interface BuildProxyDeps {
  readonly boxes: Pick<BoxPort, "hasImage" | "buildImage" | "buildNetwork">;
  /** Starts the web route on `network`'s host address (`startBoxWebRoute` in the daemon). */
  readonly startRoute: (network: BoxBuildNetwork) => Promise<BoxWebRouteStart>;
  /** dipo's private folder for build folders, outside any repository. */
  readonly scratchRoot: string;
  readonly options?: BoxCallOptions;
}

/** Builds in flight by tag, so two runs that need one image start one proxy and one build. */
const inFlight = new Map<string, Promise<BoxImageResult>>();

async function buildThroughProxy(
  deps: BuildProxyDeps,
  image: BoxImageDescription,
  tag: string,
): Promise<BoxImageResult> {
  if (await deps.boxes.hasImage(tag, deps.options)) return { tag, built: false };
  const network = await deps.boxes.buildNetwork(deps.options);
  const started = await deps.startRoute(network);
  if (!started.ok) {
    throw new BoxError(
      "box.buildProxyFailed",
      `the build proxy did not start on ${network.name}: ${started.reason}`,
      false,
      { network: network.name },
    );
  }
  const proxy: BoxBuildProxy = { url: started.route.url, caFile: started.route.caFile };
  try {
    return await ensureBoxImage({
      boxes: deps.boxes,
      image,
      proxy,
      scratchRoot: deps.scratchRoot,
      ...(deps.options === undefined ? {} : { options: deps.options }),
    });
  } finally {
    await started.route.stop();
  }
}

/**
 * The office image of `image`: reused when it exists, otherwise built with a build proxy that
 * runs only for the length of the build.
 */
export function ensureImageWithBuildProxy(
  deps: BuildProxyDeps,
  image: BoxImageDescription,
): Promise<BoxImageResult> {
  const tag = boxImageTag(image);
  const pending = inFlight.get(tag);
  if (pending !== undefined) return pending;
  const started = buildThroughProxy(deps, image, tag).finally(() => inFlight.delete(tag));
  inFlight.set(tag, started);
  return started;
}
