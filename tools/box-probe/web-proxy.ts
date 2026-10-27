// The web route of the escape probe (DIPO-264, DIPO-343; 0008): dipo's own web route, started as
// the daemon starts it, on dipo's host-only box network: the web proxy, the upstream listener and
// Safe-Chain in its own box, made from the machine-wide Safe-Chain image (built on first use).
// Probe code: one route, stopped with Ctrl-C or when stdin closes, which deletes the Safe-Chain box.
// A box must run on the box network first, since the network's address on the Mac exists only
// while one does.
//
// Usage: bun tools/box-probe/web-proxy.ts <work-dir> <ca-file>
// <work-dir> holds the box network tools and the image build folders (a fresh folder, never dipo's
// state folder). The Safe-Chain CA bundle is written to <ca-file>. When ready it prints one line:
//   ready: proxy=<url> safe-chain-box=<name> safe-chain-address=<address> upstream=<url>

import { homedir } from "node:os";
import { join } from "node:path";

import { AppleContainerBoxes } from "../../packages/engine/src/box/apple-container";
import { startBoxWebRoute } from "../../packages/engine/src/box/safe-chain-box";
import type { SafeChainBoxInfo } from "../../packages/engine/src/box/safe-chain-box";
import { systemClock } from "../../packages/engine/src/platform/clock";
import { systemSpawn } from "../../packages/engine/src/platform/process";

const [work, caFile] = process.argv.slice(2);
if (work === undefined || caFile === undefined) {
  console.error("usage: bun tools/box-probe/web-proxy.ts <work-dir> <ca-file>");
  process.exit(2);
}

const toolsRoot = join(work, "box-net-tools");
const boxes = new AppleContainerBoxes({
  spawn: systemSpawn,
  clock: systemClock,
  env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() },
  netToolsRoot: toolsRoot,
});
let safeChain: SafeChainBoxInfo | null = null;
const started = await startBoxWebRoute(
  await boxes.network(),
  {
    boxes,
    clock: systemClock,
    scratchRoot: join(work, "scratch"),
    toolsRoot,
    caFile,
    onSafeChain: (info) => {
      safeChain = info;
    },
  },
  {
    clock: systemClock,
    onEvent: (event) => console.log(`event: ${JSON.stringify(event)}`),
  },
);
if (!started.ok) {
  console.error(`the web route did not start: ${started.reason}`);
  process.exit(1);
}
const route = started.route;
const info = safeChain as SafeChainBoxInfo | null;

async function stop(): Promise<void> {
  try {
    await route.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// Reading stdin is what lets its end be seen.
process.stdin.on("end", () => void stop());
process.stdin.resume();

console.log(
  `ready: proxy=${route.url} safe-chain-box=${info?.name ?? ""} safe-chain-address=${info?.address ?? ""} upstream=${info?.upstreamUrl ?? ""}`,
);
