// The reviewer's session in its read-only box (0002, 0008, DIPO-347): read, glob, grep, web search
// and web fetch, and no shell, no write and no gh; the tool list refuses anything else. Claude Code
// runs in the box's empty session folder beside the copy, reaches the copy as an added directory,
// and loads only the box user's settings, so no settings, hooks or MCP servers of the copy load.
// Its environment is the box session's: the model proxy and the box web proxy, nothing of the Mac.
// The adapter plans it only in the box its caller made; on the Mac it is refused.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { uncontained } from "../../src/box/firewall";
import { REVIEW_CODE_DIR, REVIEW_SESSION_DIR } from "../../src/box/review-box";
import type { BoxSession } from "../../src/box/workers";
import { claudeWorkerPort } from "../../src/workers/claude-cli/adapter";
import { BOX_CLAUDE, planInBox } from "../../src/workers/claude-cli/box-plan";
import { plan, REVIEWER_ON_MAC_REFUSED } from "../../src/workers/claude-cli/plan";
import { REVIEW_REPORT_JSON_SCHEMA } from "../../src/workers/claude-cli/report-schema";
import { allowedTools, REVIEW_TOOLS } from "../../src/workers/claude-cli/tools";
import { AdapterHolds } from "../../src/workers/hold";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError, type WorkerSpec } from "../../src/workers/types";
import { FAKE_CONTAINER, FakeBoxes } from "../box/fake-boxes";
import {
  context,
  HOME,
  MAIN,
  reviewSpec,
  RUN_DIR,
  SHORT_TMP_DIR,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";

const BOX = "dipo-review-agt-0001";
const ROUTES = {
  ANTHROPIC_API_KEY: "placeholder",
  ANTHROPIC_BASE_URL: "http://192.0.2.10:4000",
  NO_PROXY: "192.0.2.10",
  HTTPS_PROXY: "http://dipo:pw@192.0.2.10:3128",
  HTTP_PROXY: "http://dipo:pw@192.0.2.10:3128",
  NODE_EXTRA_CA_CERTS: "/dipo/safe-chain-ca.pem",
};
const PATHS: RunLaunchPaths = {
  workdir: WORKDIR,
  mainCheckout: MAIN,
  runDir: RUN_DIR,
  hostSocket: `${RUN_DIR}/host.sock`,
  tmpDir: TMP_DIR,
  shortTmpDir: SHORT_TMP_DIR,
};

/** The reviewer box's session, as `BoxWorkers.review` returns it. */
function reviewBox(): BoxSession {
  const boxes = new FakeBoxes();
  return {
    box: BOX,
    workdir: REVIEW_SESSION_DIR,
    env: ROUTES,
    systemFile: "/dipo/system.md",
    exec: (command, env) => boxes.execLiveCommand(BOX, command, { cwd: REVIEW_SESSION_DIR, env }),
    stop: boxes.stopCommand(BOX),
  };
}

/** The command that runs in the box, uncontained. */
function inBox(argv: readonly string[]): string[] {
  const inner = uncontained(argv.slice(argv.indexOf(BOX) + 1));
  if (inner === null) throw new Error(`the box command is not contained: ${argv.join(" ")}`);
  return [...inner];
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

describe("the reviewer's tool set (0002)", () => {
  it("is Read, Glob, Grep, WebSearch and WebFetch for the reviewer role", () => {
    expect(REVIEW_TOOLS).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
  });

  it("passes only those tools, the review model and effort and the ReviewReport schema", () => {
    const argv = inBox(planInBox(reviewSpec(), reviewBox(), RUN_DIR).argv);
    expect(argv[0]).toBe(BOX_CLAUDE);
    expect(flag(argv, "--tools")).toBe("Read,Glob,Grep,WebSearch,WebFetch");
    expect(flag(argv, "--model")).toBe("opus");
    expect(flag(argv, "--effort")).toBe("high");
    expect(flag(argv, "--json-schema")).toBe(JSON.stringify(REVIEW_REPORT_JSON_SCHEMA));
    expect(argv).toContain("--session-id");
    expect(argv).not.toContain("--resume");
  });

  it("gives a review session only those tools, whatever its spec carries (bypass: a tool asked for)", () => {
    // A spec names no tools (DIPO-318): the adapter takes the review set from the kind. A spec
    // carrying a tool list as an older caller would, as its own field or on its prototype, still
    // gets exactly the review set: no shell, no write tool, nothing else.
    const asked = ["Bash", "Edit", "Write", "Task", "Agent"];
    const polluted = Object.assign(
      Object.create({ tools: { allow: asked, deny: [] } }) as WorkerSpec,
      reviewSpec(),
    );
    for (const spec of [{ ...reviewSpec(), tools: { allow: asked, deny: [] } }, polluted]) {
      const argv = inBox(planInBox(spec, reviewBox(), RUN_DIR).argv);
      expect(flag(argv, "--tools")).toBe(REVIEW_TOOLS.join(","));
    }
  });

  it("refuses the web switch on a review spec, also when it comes from the prototype", () => {
    // `web` is the developer's switch (0020 section 11b); the reviewer's web tools come with its kind.
    expect(() => planInBox(reviewSpec({ web: true }), reviewBox(), RUN_DIR)).toThrow(PlanError);
    const { web: _web, ...own } = reviewSpec();
    const inherited = Object.assign(Object.create({ web: true }) as WorkerSpec, own);
    expect(inherited.web).toBe(true);
    expect(() => planInBox(inherited, reviewBox(), RUN_DIR)).toThrow(/developer's switch/);
  });

  it("refuses a kind it names no tools for, never giving it the developer's", () => {
    const unknown = reviewSpec({ kind: "plan" });
    expect(() => planInBox(unknown, reviewBox(), RUN_DIR)).toThrow(PlanError);
    expect(() => allowedTools(unknown)).toThrow(/no tools are named for worker kind "plan"/);
  });
});

describe("the reviewer's box session (0002, 0008)", () => {
  it("runs in its empty session folder, reaches the copy as an added directory and loads only the box user's settings", () => {
    const launch = planInBox(reviewSpec(), reviewBox(), RUN_DIR);
    expect(flag(launch.argv, "--workdir")).toBe(REVIEW_SESSION_DIR);
    const argv = inBox(launch.argv);
    expect(flag(argv, "--add-dir")).toBe(REVIEW_CODE_DIR);
    expect(flag(argv, "--setting-sources")).toBe("user");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    expect(flag(argv, "--append-system-prompt-file")).toBe("/dipo/system.md");
  });

  it("plans no settings file, hooks or socket of dipo's, and nothing of the Mac", () => {
    const launch = planInBox(reviewSpec(), reviewBox(), RUN_DIR);
    expect(launch.files).toEqual([]);
    const text = JSON.stringify(launch);
    expect(text).not.toContain("DIPO_HOST_SOCKET");
    expect(text).not.toContain("hooks");
    expect(text).not.toContain(" hook ");
    expect(JSON.stringify(launch.argv)).not.toContain(HOME);
    expect(launch.argv[0]).toBe(FAKE_CONTAINER);
    expect(launch.stopCommand).toEqual([FAKE_CONTAINER, "stop", BOX]);
  });

  it("goes out only through the box session's proxies", () => {
    const argv = planInBox(reviewSpec(), reviewBox(), RUN_DIR).argv;
    const env = Object.fromEntries(
      argv.flatMap((part, at) => {
        if (argv[at - 1] !== "--env") return [];
        const [key, ...value] = part.split("=");
        return [[key ?? "", value.join("=")]];
      }),
    );
    expect(env["HTTPS_PROXY"]).toBe(ROUTES.HTTPS_PROXY);
    expect(env["HTTP_PROXY"]).toBe(ROUTES.HTTP_PROXY);
    expect(env["ANTHROPIC_BASE_URL"]).toBe(ROUTES.ANTHROPIC_BASE_URL);
  });
});

describe("the adapter's reviewer launch (DIPO-347)", () => {
  const clock = new ManualClock();
  const port = (holds: AdapterHolds) =>
    claudeWorkerPort({
      claudePath: `${HOME}/.local/bin/claude`,
      home: HOME,
      env: { PATH: "/usr/bin:/bin", HOME },
      spawn: () => {
        throw new Error("no Mac launch check may run for a reviewer");
      },
      clock,
      holds,
      pluginFiles: { read: () => undefined, dirs: () => [] },
    });

  it("plans it only in the box its caller made, with no Mac launch check", async () => {
    const holds = new AdapterHolds({ clock, notify: () => {} });
    const id = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const prepared = await port(holds).prepare(
      reviewSpec(),
      PATHS,
      OFFICE_DEFAULTS,
      id,
      reviewBox(),
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(inBox(prepared.plan.argv)[0]).toBe(BOX_CLAUDE);
    const refused = await port(holds)
      .prepare(reviewSpec(), PATHS, OFFICE_DEFAULTS, id)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PlanError);
    expect(String(refused)).toContain(REVIEWER_ON_MAC_REFUSED);
  });

  it("is never planned on the Mac", () => {
    expect(() => plan(reviewSpec(), context())).toThrow(REVIEWER_ON_MAC_REFUSED);
  });
});
