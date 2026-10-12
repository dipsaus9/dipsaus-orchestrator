import { describe, expect, it } from "bun:test";

import { HELP, main, packageName, type CliDeps, type ClientCheck } from "./index";

type Captured = { out: string[]; err: string[]; daemonCalls: string[][] };

function fakeDeps(overrides: { daemonCode?: number; clientChecks?: ClientCheck[] } = {}): {
  deps: CliDeps;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], daemonCalls: [] };
  const deps: CliDeps = {
    writeLine: (line) => captured.out.push(line),
    writeError: (line) => captured.err.push(line),
    runDaemon: async (argv) => {
      captured.daemonCalls.push([...argv]);
      captured.out.push("ok   sqlite-wal");
      return overrides.daemonCode ?? 0;
    },
    clientChecks: overrides.clientChecks ?? [{ name: "ink", run: () => undefined }],
    stamp: { version: "0.0.0-dev", commit: "0123456789ab", commitDate: "2026-10-12" },
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
  };
  return { deps, captured };
}

describe("cli", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/cli");
  });

  it("prints the version", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version"], deps)).toBe(0);
    expect(captured.out).toEqual([
      "dipo 0.0.0-dev (0123456789ab 2026-10-12) bun 1.4.2 linux-arm64",
    ]);
  });

  it("prints the version as JSON", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version", "--json"], deps)).toBe(0);
    expect(JSON.parse(captured.out[0] ?? "")).toMatchObject({ version: "0.0.0-dev", os: "linux" });
  });

  it("prints help without the hidden self-check", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--help"], deps)).toBe(0);
    expect(captured.out).toEqual([HELP]);
    expect(HELP).not.toContain("self-check");
  });

  it("rejects unknown arguments", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["--version", "--yaml"], deps)).toBe(2);
    expect(captured.err.join("\n")).toContain("unknown arguments");
  });

  it("runs the daemon-side checks through runDaemon, then the client checks", async () => {
    const { deps, captured } = fakeDeps();
    expect(await main(["self-check"], deps)).toBe(0);
    expect(captured.daemonCalls).toEqual([["self-check"]]);
    expect(captured.out).toEqual(["ok   sqlite-wal", "ok   ink"]);
  });

  it("names the failing check and exits non-zero when a probe throws", async () => {
    let laterRan = false;
    const { deps, captured } = fakeDeps({
      clientChecks: [
        {
          name: "ink",
          run: () => {
            throw new Error("yoga did not load");
          },
        },
        { name: "later", run: () => void (laterRan = true) },
      ],
    });
    expect(await main(["self-check"], deps)).toBe(1);
    expect(captured.out.at(-1)).toBe("fail ink: yoga did not load");
    expect(laterRan).toBe(false);
  });

  it("stops before the client checks when a daemon-side check fails", async () => {
    let inkRan = false;
    const { deps } = fakeDeps({
      daemonCode: 1,
      clientChecks: [{ name: "ink", run: () => void (inkRan = true) }],
    });
    expect(await main(["self-check"], deps)).toBe(1);
    expect(inkRan).toBe(false);
  });
});
