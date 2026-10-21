// The web tools' PreToolUse check and count (DIPO-164; 0020 section 11b): a URL or query holding a
// value from the copied env files, plain or percent-encoded, is denied naming the file and key and
// never the value; a clean one is let through; a failure to check denies; and the run's web calls
// are counted by tool in `runs` and copied to its outcome row. A WebFetch whose host is not on the
// public internet is denied by the box web proxy's address rule (DIPO-276), on a fake resolver.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import {
  decodedForms,
  type EnvSecret,
  FETCH_RESOLVE_TIMEOUT_MS,
  type FetchAddressDeps,
  fetchAddressRefusal,
  fetchRefusalText,
  findSecret,
  lenientDecode,
  MIN_SECRET_CHARS,
  parseEnvText,
  readEnvSecrets,
  refusalText,
  UNCHECKED_TEXT,
  WebGuard,
} from "../../src/hooks/web-guard";
import { endRun, insertRun, runOutcome } from "../../src/run";
import type { RunSteering } from "../../src/run/control";
import { addStory } from "../../src/stories/keys";
import { encode } from "../../src/workers/claude-cli/encode";
import { PRE_TOOL_USE_NO_DECISION_MARKER } from "../../src/workers/claude-cli/hooks";
import type { HostOp, SteerOp, WorkerEvent } from "../../src/workers/types";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

const RUN = "run_01JZ0000000000000000000164" as RunId;
const VALUE = "sk-live-9f8e7d6c5b4a";
const SECRETS: EnvSecret[] = [
  { file: ".env", key: "STRIPE_KEY", value: VALUE },
  { file: ".env", key: "MODE", value: "dev" },
  { file: "config/.env.local", key: "DB_PASSWORD", value: "p@ss word/1" },
];

describe("env files as KEY=value lines", () => {
  it("reads plain, exported, quoted and commented values", () => {
    const text = [
      "# a comment",
      "A=1",
      "export B = two words # trailing",
      'C="quoted # not a comment"',
      "D='single'",
      "E=",
      "not a line",
      "F=has#hash",
    ].join("\n");
    expect(parseEnvText(text)).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "quoted # not a comment" },
      { key: "D", value: "single" },
      { key: "F", value: "has#hash" },
    ]);
  });
});

describe("findSecret (pure)", () => {
  it("finds a value as written, naming the file and key and not the value", () => {
    const hit = findSecret(`https://api.example/v1?token=${VALUE}`, SECRETS);
    expect(hit).toEqual({ file: ".env", key: "STRIPE_KEY" });
    expect(JSON.stringify(hit)).not.toContain(VALUE);
  });

  it("finds a percent-encoded value, in either hex case, and a plus for a space", () => {
    const encoded = encodeURIComponent("p@ss word/1");
    expect(encoded).toBe("p%40ss%20word%2F1");
    const wanted = { file: "config/.env.local", key: "DB_PASSWORD" };
    expect(findSecret(`https://x.test/?p=${encoded}`, SECRETS)).toEqual(wanted);
    expect(findSecret(`https://x.test/?p=${encoded.toLowerCase()}`, SECRETS)).toEqual(wanted);
    expect(findSecret("https://x.test/?p=p%40ss+word%2F1", SECRETS)).toEqual(wanted);
  });

  it("finds a value that is percent-encoded in the target character by character", () => {
    const every = [...VALUE].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    expect(findSecret(`https://x.test/${every}`, SECRETS)).toEqual({
      file: ".env",
      key: "STRIPE_KEY",
    });
  });

  it("decodes leniently: a stray %, an invalid UTF-8 escape and a double encoding hide nothing (review)", () => {
    const secrets: EnvSecret[] = [{ file: ".env", key: "TOKEN", value: "abcd1234" }];
    const hit = { file: ".env", key: "TOKEN" };
    // A stray '%' makes decodeURIComponent throw for the whole target.
    expect(findSecret("https://x.test/?a=%&k=%61bcd1234", secrets)).toEqual(hit);
    // An invalid UTF-8 escape elsewhere in the target, and right next to the value.
    expect(findSecret("https://x.test/?x=%C0&k=%61bcd1234", secrets)).toEqual(hit);
    expect(findSecret("https://x.test/?k=%C0%61bcd1234", secrets)).toEqual(hit);
    // Encoded twice, and three times.
    expect(findSecret("https://x.test/?k=%2561bcd1234", secrets)).toEqual(hit);
    expect(findSecret("https://x.test/?k=%252561bcd1234", secrets)).toEqual(hit);
    // The invalid escape is kept as written, the valid one decoded.
    expect(lenientDecode("%C0%61%&%zz%e2%82%ac")).toBe("%C0a%&%zz€");
    expect(decodedForms("%2561")).toEqual(["%2561", "%61", "a"]);
  });

  it("allows a clean URL or query and ignores values under the minimum length", () => {
    expect(findSecret("https://docs.example/api/reference", SECRETS)).toBeNull();
    expect(findSecret("how to configure a dev server mode", SECRETS)).toBeNull();
    expect("dev".length).toBeLessThan(MIN_SECRET_CHARS);
    expect(findSecret("https://x.test/%zz", SECRETS)).toBeNull();
  });

  it("words the refusal with the file and key, for a URL and for a query", () => {
    const hit = { file: ".env", key: "STRIPE_KEY" };
    expect(refusalText("WebFetch", hit)).toBe(
      "The URL contains a value from .env (STRIPE_KEY); never send env values in a web call. Remove it and try again.",
    );
    expect(refusalText("WebSearch", hit)).toContain("The query contains");
  });
});

describe("readEnvSecrets", () => {
  it("reads the copy entries of worktree.files, files and directories, and skips links and absent files", () =>
    withTempDir((dir) => {
      mkdirSync(join(dir, "apps/web"), { recursive: true });
      writeFileSync(join(dir, ".env"), "STRIPE_KEY=sk-live-9f8e7d6c5b4a\n");
      writeFileSync(join(dir, "apps/web/.env.local"), "DB_PASSWORD=hunter2hunter2\n");
      writeFileSync(join(dir, "linked.env"), "LINKED=should-not-be-read\n");
      const files: OfficeConfig["worktree"]["files"] = [
        { path: ".env", mode: "copy", required: false },
        { path: "apps/", mode: "copy", required: false },
        { path: "missing/.env", mode: "copy", required: false },
        { path: "linked.env", mode: "link", required: false },
      ];
      expect(readEnvSecrets(dir, files)).toEqual([
        { file: ".env", key: "STRIPE_KEY", value: "sk-live-9f8e7d6c5b4a" },
        { file: "apps/web/.env.local", key: "DB_PASSWORD", value: "hunter2hunter2" },
      ]);
    }));
});

interface World {
  readonly t: TestState;
  readonly office: OfficeHandle;
  readonly guard: WebGuard;
  readonly ops: SteerOp[];
  readonly outputs: HostOp[][];
  readonly warnings: string[];
}

/** The Mac's interfaces in the tests: documentation prefixes standing in for public ones. */
const INTERFACES = [
  { address: "192.0.2.50", cidr: "192.0.2.48/29" },
  // The box network's interface on the Mac.
  { address: "192.0.2.129", cidr: "192.0.2.128/25" },
  { address: "2001:db8::50", cidr: "2001:db8::/64" },
];

/** A resolver over fixed answers; a name it does not know does not resolve. */
const ANSWERS: Readonly<Record<string, readonly string[]>> = {
  "docs.example": ["192.0.2.10"],
  "docs6.example": ["2001:db8:1::10"],
  "loop.example": ["127.0.0.1"],
  "loop6.example": ["::1"],
  "lan.example": ["192.168.0.0"],
  "lan10.example": ["10.0.0.0"],
  "ula.example": ["fc00::1"],
  "shared.example": ["100.64.0.0"],
  "link.example": ["169.254.0.0"],
  "link6.example": ["fe80::1"],
  "multicast.example": ["224.0.0.0"],
  "doc.example": ["198.51.100.7"],
  "mac.example": ["192.0.2.50"],
  "onlink.example": ["192.0.2.49"],
  "onlink6.example": ["2001:db8::99"],
  "box.example": ["192.0.2.130"],
  "mixed.example": ["192.0.2.10", "10.0.0.0"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "empty.example": [],
};

const FETCH: FetchAddressDeps = {
  resolve: async (host) => {
    const found = ANSWERS[host];
    if (found === undefined) throw new Error(`ENOTFOUND ${host}`);
    return found;
  },
  interfaces: () => INTERFACES,
  boxHostAddress: () => "192.0.2.129",
  // Only these documentation prefixes pass as public; 198.51.100.0/24 stays refused.
  publicStandIns: ["192.0.2.0/24", "2001:db8::/32"],
};

async function withWorld(
  fn: (w: World) => Promise<void> | void,
  secrets: () => EnvSecret[] = () => SECRETS,
  fetchAddresses: FetchAddressDeps = FETCH,
): Promise<void> {
  await withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      const office = addOffice(t);
      const at = t.clock.now();
      const { key } = office.immediate(() =>
        addStory(office, t.ids, { story: StoryId.parse("DIPO-1") }, at),
      );
      office.immediate(() =>
        insertRun(office, {
          runId: RUN,
          kind: "story",
          key,
          story: "DIPO-1",
          tier: "M",
          role: "developer",
          model: "haiku",
          startSha: "c".repeat(40),
          branch: "DIPO-1/x",
          worktree: join(dir, "tree"),
          slot: 1,
          budgetUnit: "tokens",
          budgetLimit: 1000,
          loopCap: 3,
          reviewRoundCap: null,
          configHash: "h",
          overrideKeys: null,
          runProfileId: null,
          startedAt: at,
          scope: null,
        }),
      );
      const ops: SteerOp[] = [];
      const outputs: HostOp[][] = [];
      const warnings: string[] = [];
      const steering: RunSteering = {
        send: async (_office, _run, host) => {
          outputs.push([...host]);
          return { ok: true };
        },
      };
      const guard = new WebGuard({
        clock: t.clock,
        offices: { config: () => OFFICE_DEFAULTS },
        steering,
        encode: (op) => {
          ops.push(op);
          return encode(op);
        },
        secrets,
        fetchAddresses,
        warn: (message) => warnings.push(message),
      });
      await fn({ t, office, guard, ops, outputs, warnings });
    } finally {
      t.state.close();
    }
  });
}

const call = (id: number, tool: string, target: string): WorkerEvent => ({
  t: "hook",
  hook: { kind: "webCall", id, tool, target },
});
const activity = (tool: string, agentId?: string): WorkerEvent => ({
  t: "activity",
  kind: "tool",
  tool,
  ...(agentId === undefined ? {} : { agentId }),
});

async function pass(w: World, ...events: WorkerEvent[]): Promise<void> {
  w.guard.onWorkerEvents(w.office, RUN, "agt-1", events);
  await w.guard.idle();
}

describe("WebGuard (DIPO-164)", () => {
  it("denies a URL holding an env value, naming the file and key and never the value", () =>
    withWorld(async (w) => {
      await pass(w, call(10, "WebFetch", `https://api.example/?k=${VALUE}`));
      expect(w.ops).toEqual([
        {
          kind: "toolGate",
          reply: {
            hook: 10,
            decision: "deny",
            reason: refusalText("WebFetch", { file: ".env", key: "STRIPE_KEY" }),
          },
        },
      ]);
      const sent = JSON.stringify(w.outputs);
      expect(sent).toContain("permissionDecision");
      expect(sent).toContain(".env (STRIPE_KEY)");
      expect(sent).not.toContain(VALUE);
    }));

  it("denies a percent-encoded value in a query", () =>
    withWorld(async (w) => {
      await pass(w, call(11, "WebSearch", `why does ${encodeURIComponent(VALUE)} fail`));
      expect(w.ops[0]).toMatchObject({ kind: "toolGate", reply: { hook: 11, decision: "deny" } });
    }));

  it("lets a clean URL proceed: a reply the adapter encodes as its marker without a decision, never empty", () =>
    withWorld(async (w) => {
      await pass(w, call(12, "WebFetch", "https://docs.example/guide"));
      expect(w.ops).toEqual([{ kind: "toolGate", reply: { hook: 12, decision: null } }]);
      expect(w.outputs).toEqual([[{ hookReply: 12, output: PRE_TOOL_USE_NO_DECISION_MARKER }]]);
    }));

  it("denies when the env files cannot be read: it fails closed", () =>
    withWorld(
      async (w) => {
        await pass(w, call(13, "WebFetch", "https://docs.example/guide"));
        expect(w.ops).toEqual([
          { kind: "toolGate", reply: { hook: 13, decision: "deny", reason: UNCHECKED_TEXT } },
        ]);
        expect(w.warnings).toEqual(["a web call could not be checked"]);
      },
      () => {
        throw new Error("EACCES");
      },
    ));

  it("ignores a call with no hook id: no host holds it", () =>
    withWorld(async (w) => {
      await pass(w, {
        t: "hook",
        hook: { kind: "webCall", id: null, tool: "WebFetch", target: "https://x.test" },
      });
      expect(w.ops).toEqual([]);
    }));

  it("counts a run's web calls by tool, a subagent's and a refused one included, and copies them to the outcome", () =>
    withWorld(async (w) => {
      await pass(w, activity("WebSearch"), activity("Read"), activity("WebFetch"));
      await pass(w, activity("WebSearch", "toolu-9"));
      const row = w.office.get<{ web_searches: number; web_fetches: number }>(
        "select web_searches, web_fetches from runs where office_id = $office_id and run_id = $run",
        { run: RUN },
      );
      expect(row).toEqual({ web_searches: 2, web_fetches: 1 });
      w.office.immediate(() => endRun(w.office, RUN, w.t.clock.now() + 60_000, "in-review"));
      const outcome = runOutcome(w.office, RUN);
      expect(outcome?.webSearches).toBe(2);
      expect(outcome?.webFetches).toBe(1);
    }));
});

/** The address rule's refusal of a WebFetch of `target` on the fake resolver. */
const refusal = (target: string) => fetchAddressRefusal(target, FETCH);

describe("the WebFetch address rule (DIPO-276)", () => {
  it("lets a name whose every answer is public through", async () => {
    expect(await refusal("https://docs.example/guide")).toBeUndefined();
    expect(await refusal("http://docs6.example/")).toBeUndefined();
  });

  it("refuses IP literals in every form, before any lookup", async () => {
    const looked: string[] = [];
    const deps = { ...FETCH, resolve: async (host: string) => (looked.push(host), ["192.0.2.10"]) };
    for (const target of [
      "https://192.0.2.10/",
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://017700000001/",
    ]) {
      expect(await fetchAddressRefusal(target, deps)).toContain("an IP address or no host name");
    }
    // The URL parser does not take a zone: refused as a URL dipo cannot read.
    expect(await fetchAddressRefusal("http://[fe80::1%25en0]/", deps)).toBe(
      fetchRefusalText("cannot be read"),
    );
    expect(looked).toEqual([]);
  });

  it("refuses names that resolve to loopback, private, shared, link-local, multicast or documentation ranges", async () => {
    const cases: Array<[string, string]> = [
      ["loop.example", "loopback"],
      ["loop6.example", "loopback"],
      ["mapped.example", "loopback"],
      ["lan.example", "a private range"],
      ["lan10.example", "a private range"],
      ["ula.example", "a unique local range"],
      ["shared.example", "the shared address space"],
      ["link.example", "link-local"],
      ["link6.example", "link-local"],
      ["multicast.example", "multicast"],
      ["doc.example", "a documentation range"],
    ];
    for (const [host, why] of cases) {
      const text = await refusal(`https://${host}/x`);
      expect(text).toContain(`names ${host}, which resolves to`);
      expect(text).toContain(why);
    }
  });

  it("refuses the Mac's own addresses, its on-link prefixes and the box network", async () => {
    expect(await refusal("https://mac.example/")).toContain("one of the Mac's own addresses");
    expect(await refusal("https://onlink.example/")).toContain("in an on-link prefix of the Mac");
    expect(await refusal("https://onlink6.example/")).toContain("in an on-link prefix of the Mac");
    expect(await refusal("https://box.example/")).toContain("on the box network");
    // Without the box host address the box network's interface on the Mac still refuses it.
    const unknownBox = { ...FETCH, boxHostAddress: () => null };
    expect(await fetchAddressRefusal("https://box.example/", unknownBox)).toContain(
      "in an on-link prefix of the Mac",
    );
  });

  it("refuses a name if any one of its answers is not public", async () => {
    expect(await refusal("https://mixed.example/")).toContain("10.0.0.0 is a private range");
  });

  it("refuses a name that does not resolve, has no answer, a URL it cannot read and other schemes", async () => {
    expect(await refusal("https://unknown.example/")).toBe(
      fetchRefusalText("names unknown.example, which does not resolve"),
    );
    expect(await refusal("https://empty.example/")).toContain("which does not resolve");
    expect(await refusal("not a url")).toBe(fetchRefusalText("cannot be read"));
    expect(await refusal("file:///etc/hosts")).toContain("uses file:, not http or https");
    expect(await refusal("ftp://docs.example/")).toContain("uses ftp:");
  });

  it("denies such a WebFetch through the guard, and resolves nothing for a search", () =>
    withWorld(async (w) => {
      await pass(w, call(20, "WebFetch", "https://loop.example/admin"));
      await pass(w, call(21, "WebFetch", "https://docs.example/guide"));
      await pass(w, call(22, "WebSearch", "loop.example"));
      expect(w.ops).toEqual([
        {
          kind: "toolGate",
          reply: {
            hook: 20,
            decision: "deny",
            reason: fetchRefusalText("names loop.example, which resolves to 127.0.0.1 is loopback"),
          },
        },
        { kind: "toolGate", reply: { hook: 21, decision: null } },
        { kind: "toolGate", reply: { hook: 22, decision: null } },
      ]);
    }));

  it("denies a WebFetch whose name does not resolve in time", () =>
    withWorld(
      async (w) => {
        w.guard.onWorkerEvents(w.office, RUN, "agt-1", [
          call(23, "WebFetch", "https://slow.example/"),
        ]);
        await Bun.sleep(0);
        w.t.clock.advance(FETCH_RESOLVE_TIMEOUT_MS);
        await w.guard.idle();
        expect(w.ops).toEqual([
          {
            kind: "toolGate",
            reply: {
              hook: 23,
              decision: "deny",
              reason: fetchRefusalText("names slow.example, which did not resolve in time"),
            },
          },
        ]);
      },
      () => SECRETS,
      { ...FETCH, resolve: () => new Promise<readonly string[]>(() => {}) },
    ));
});
