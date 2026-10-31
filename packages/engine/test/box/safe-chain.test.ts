// The pure parts of Safe-Chain in a box (DIPO-343): the registries and the hosts Safe-Chain itself
// reaches, the one machine-wide Safe-Chain image (pinned binary, no npm install, its tag), the
// start script and the holder, and the CA bundle check. The box itself is tested on fakes in
// safe-chain-box.test.ts and on the real backend in safe-chain-box.ci.test.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  BOX_DEFAULTS,
  BUILD_BOOTSTRAP_SCRIPT,
  BUILD_STEPS_SCRIPT,
  BUILD_SYSTEM_SCRIPT,
  bootstrapLines,
  boxBuildScripts,
  describeBox,
} from "../../src/box/image";
import {
  ecosystemOf,
  holderScript,
  SAFE_CHAIN_DEADLINE_LINE,
  SAFE_CHAIN_FAIL_FUNCTION,
  SAFE_CHAIN_LOAD_SECONDS_ENV,
  SAFE_CHAIN_LOAD_URLS,
  safeChainLoadLines,
  isCertificateBundle,
  addSafeChainFound,
  boxClockOffset,
  cleanLogText,
  EMPTY_SAFE_CHAIN_RECORD,
  MINIMUM_AGE_REASON,
  parseSafeChainRecord,
  type RegistryClients,
  refusalsOfBox,
  SAFE_CHAIN_CLOCK_DRIFT_MS,
  SAFE_CHAIN_RECORD_MAX,
  SAFE_CHAIN_TIME_SLACK_MS,
  type SafeChainLogRefusal,
  sessionClockOffset,
  uniqueFound,
  SAFE_CHAIN_BOX_PORTS,
  SAFE_CHAIN_BUILD_FILES,
  SAFE_CHAIN_MALWARE_LIST_HOST,
  SAFE_CHAIN_REGISTRY_HOSTS,
  SAFE_CHAIN_RELEASE,
  SAFE_CHAIN_UPSTREAM_HOSTS,
  safeChainBuildPlan,
  safeChainImageTag,
  safeChainLogFile,
  safeChainRefusalsOf,
  safeChainStartScript,
} from "../../src/box/safe-chain";

const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";

describe("the hosts of Safe-Chain", () => {
  it("sends each registry to the Safe-Chain process of its ecosystem, and nothing else", () => {
    expect(ecosystemOf("registry.npmjs.org")).toBe("npm");
    expect(ecosystemOf("Registry.Yarnpkg.com")).toBe("npm");
    expect(ecosystemOf("pypi.org")).toBe("pypi");
    expect(ecosystemOf("files.pythonhosted.org")).toBe("pypi");
    for (const host of ["registry.npmjs.com", "example.com", SAFE_CHAIN_MALWARE_LIST_HOST, ""]) {
      expect(ecosystemOf(host)).toBeNull();
    }
    expect(SAFE_CHAIN_BOX_PORTS).toEqual({ npm: 8101, pypi: 8102 });
  });

  it("reaches upstream only the registries it checks and its malware lists", () => {
    expect([...SAFE_CHAIN_UPSTREAM_HOSTS].toSorted()).toEqual(
      [...SAFE_CHAIN_REGISTRY_HOSTS, "malware-list.aikido.dev"].toSorted(),
    );
  });
});

describe("the Safe-Chain image", () => {
  const plan = safeChainBuildPlan();
  const system = plan.files[BUILD_SYSTEM_SCRIPT] ?? "";
  const build = plan.files[BUILD_STEPS_SCRIPT] ?? "";

  it("is built from Debian's slim image and the box network tools, as every box image is", () => {
    // The default release pinned by its digest (DIPO-367): the same base as a default office image.
    expect(plan.base).toBe(
      `docker.io/library/debian:${BOX_DEFAULTS.debian}-slim@sha256:${BOX_DEFAULTS.debianSha256}`,
    );
    expect(plan.base).toBe(boxBuildScripts(describeBox({}, {}).image).base);
    expect(plan.files[BUILD_BOOTSTRAP_SCRIPT]).toContain(bootstrapLines().join("\n"));
    expect(Object.keys(plan.files).toSorted()).toEqual(
      [
        BUILD_BOOTSTRAP_SCRIPT,
        BUILD_SYSTEM_SCRIPT,
        BUILD_STEPS_SCRIPT,
        SAFE_CHAIN_BUILD_FILES.start,
        SAFE_CHAIN_BUILD_FILES.holder,
      ].toSorted(),
    );
  });

  it("holds the official linux-arm64 release binary, checked against its pinned sha256", () => {
    expect(SAFE_CHAIN_RELEASE.arm64Sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(system).toContain(
      `https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_RELEASE.version}/safe-chain-linux-arm64`,
    );
    expect(system).toContain(`arm64) sum=${SAFE_CHAIN_RELEASE.arm64Sha256} ;;`);
    expect(system).toContain('echo "$sum  safe-chain" | sha256sum -c -');
    // Any other architecture is refused, never fetched unchecked.
    expect(system).toContain(
      '*) echo "no pinned Safe-Chain binary for this architecture" >&2; exit 1 ;;',
    );
    expect(build).toContain(
      `"$check/bin/safe-chain" --version | grep -F "${SAFE_CHAIN_RELEASE.version}"`,
    );
  });

  it("installs nothing from a registry, so building it needs no Safe-Chain", () => {
    // The build steps only; the start script runs Safe-Chain with its holders later, in the box.
    for (const name of [BUILD_BOOTSTRAP_SCRIPT, BUILD_SYSTEM_SCRIPT, BUILD_STEPS_SCRIPT]) {
      const text = plan.files[name] ?? "";
      expect(text).not.toMatch(/\bnpm (install|i)\b|\bpip3? install\b|NODE_EXTRA_CA_CERTS=\//);
      expect(text).not.toContain("registry.npmjs.org");
    }
  });

  it("has one tag for one plan, and a new one when anything in it changes", () => {
    expect(safeChainImageTag()).toBe(safeChainImageTag(plan));
    expect(safeChainImageTag()).toMatch(/^dipo-box:[0-9a-f]{64}$/);
    const changed = {
      ...plan,
      files: { ...plan.files, [SAFE_CHAIN_BUILD_FILES.start]: "#!/bin/sh\n" },
    };
    expect(safeChainImageTag(changed)).not.toBe(safeChainImageTag(plan));
    // The base's digest is part of the tag (DIPO-367).
    const moved = {
      ...plan,
      base: plan.base.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${"a".repeat(64)}`),
    };
    expect(moved.base).not.toBe(plan.base);
    expect(safeChainImageTag(moved)).not.toBe(safeChainImageTag(plan));
  });
});

describe("the Safe-Chain box's start script", () => {
  const start = safeChainStartScript();

  it("refuses to start without an upstream proxy, and starts a fresh Safe-Chain each time", () => {
    expect(start).toContain('[ -n "${HTTPS_PROXY:-}" ] || fail "no upstream proxy"');
    expect(start).toContain('rm -rf "$dir"');
    expect(start).toContain('cp /opt/safe-chain/bin/safe-chain "$dir/bin/safe-chain"');
  });

  it("forwards each ecosystem's port on the box network to its Safe-Chain on the loopback only", () => {
    expect(start).toContain('socat TCP-LISTEN:8101,fork,reuseaddr TCP:127.0.0.1:"$port" &');
    expect(start).toContain('socat TCP-LISTEN:8102,fork,reuseaddr TCP:127.0.0.1:"$port" &');
    expect(start).toContain(" bun install < /dev/null");
    expect(start).toContain(" pip3 install dipo-safe-chain-holder < /dev/null");
    // A report that names anything but a loopback port starts no forwarder.
    expect(start).toContain("s|^http://127\\.0\\.0\\.1:\\([0-9][0-9]*\\)$|\\1|p");
  });

  it("reports ready only with a CA bundle in Safe-Chain's own temp folder", () => {
    expect(start).toContain('case "$bundle" in "$dir/tmp/"*) ;; *) fail');
    expect(start).toContain('printf \'{"ready":true,"bundle":"%s"}\\n\' "$bundle"');
  });

  it("has each Safe-Chain write its log file as it goes, every level, as JSON lines (DIPO-376)", () => {
    expect(safeChainLogFile("npm")).toBe("/home/dipo/sc/log/npm.ndjson");
    expect(safeChainLogFile("pypi")).toBe("/home/dipo/sc/log/pypi.ndjson");
    expect(start).toContain('mkdir -p "$dir/bin" "$dir/out" "$dir/tmp" "$dir/log"');
    for (const ecosystem of ["npm", "pypi"] as const) {
      expect(start).toContain(
        `SAFE_CHAIN_LOG_FILE="/home/dipo/sc/log/${ecosystem}.ndjson" SAFE_CHAIN_LOG_FILE_FORMAT=json SAFE_CHAIN_LOG_FILE_VERBOSITY=verbose PATH=`,
      );
    }
  });

  it("has a holder that reports the proxy and CA, then waits", () => {
    const holder = holderScript();
    expect(holder).toContain('printf \'%s\\n%s\\n\' "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS"');
    expect(holder).toContain("exec tail -f /dev/null");
  });
});

describe("the CA bundle check", () => {
  it("takes PEM certificates with comment lines, and nothing else", () => {
    expect(isCertificateBundle(PEM)).toBe(true);
    expect(isCertificateBundle(`# roots\n${PEM}\n${PEM}`)).toBe(true);
    expect(isCertificateBundle(PEM.replaceAll("\n", "\r\n"))).toBe(true);
    for (const text of ["", "hello", `${PEM}export X=1\n`, "x".repeat(5 * 1024 * 1024)]) {
      expect(isCertificateBundle(text)).toBe(false);
    }
  });
});

// The start script's load of each Safe-Chain process's malware list (DIPO-383), run in `sh` with a
// stand-in curl that fails its first `fails` calls: Safe-Chain answers 500 while its list does not
// load, which curl -f fails on.
describe("the start script's load of the malware lists (DIPO-383)", () => {
  const STAND_IN_CURL = [
    "#!/bin/sh",
    'n=$(cat "$CALLS" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CALLS"',
    'echo "$*" >> "$ARGS"',
    'if [ "$n" -le "$FAILS" ]; then echo \'curl: (22) The requested URL returned error: 500 "x\\y"\' >&2; exit 22; fi',
    "exit 0",
    "",
  ].join("\n");

  function load(tmp: string, fails: number, seconds: number) {
    const bin = join(tmp, "bin");
    const dir = join(tmp, "sc");
    mkdirSync(bin);
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(bin, "curl"), STAND_IN_CURL, { mode: 0o755 });
    writeFileSync(join(dir, "out", "npm"), "http://127.0.0.1:41000\n/x/ca.pem\n");
    writeFileSync(join(dir, "out", "pypi"), "http://127.0.0.1:42000\n\n");
    const script = [
      "set -eu",
      SAFE_CHAIN_FAIL_FUNCTION,
      SAFE_CHAIN_DEADLINE_LINE,
      `dir="${dir}"`,
      'bundle="$dir/tmp/ca.pem"',
      ...safeChainLoadLines(),
      "echo loaded",
    ].join("\n");
    const run = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CALLS: join(tmp, "calls"),
        ARGS: join(tmp, "args"),
        FAILS: String(fails),
        [SAFE_CHAIN_LOAD_SECONDS_ENV]: String(seconds),
      },
    });
    const args = readFileSync(join(tmp, "args"), "utf8").trim().split("\n");
    return { code: run.exitCode, stdout: run.stdout.toString(), args };
  }

  it("tries each process's request again until it passes, through that process's own proxy", () =>
    withTempDir((tmp) => {
      const result = load(tmp, 2, 30);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("loaded\n");
      const npm = `-fsS -m 15 -o /dev/null --proxy http://127.0.0.1:41000 --cacert ${tmp}/sc/tmp/ca.pem ${SAFE_CHAIN_LOAD_URLS.npm}`;
      const pypi = `-fsS -m 15 -o /dev/null --proxy http://127.0.0.1:42000 --cacert ${tmp}/sc/tmp/ca.pem ${SAFE_CHAIN_LOAD_URLS.pypi}`;
      expect(result.args).toEqual([npm, npm, npm, pypi]);
    }));

  it("prints no ready line but why, when a list does not load before the deadline", () =>
    withTempDir((tmp) => {
      const result = load(tmp, 1_000, 1);
      expect(result.code).toBe(1);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        ready: false,
        reason:
          "the npm Safe-Chain process could not load its malware list in time: curl: (22) The requested URL returned error: 500 xy ",
      });
      expect(result.args.every((line) => line.includes(SAFE_CHAIN_LOAD_URLS.npm))).toBe(true);
    }));

  it("loads both lists after the forwarders and before the ready line", () => {
    const start = safeChainStartScript();
    const loadAt = start.indexOf(`load npm ${SAFE_CHAIN_LOAD_URLS.npm}`);
    expect(start.indexOf("socat TCP-LISTEN:8102")).toBeLessThan(loadAt);
    expect(start.indexOf(`load pypi ${SAFE_CHAIN_LOAD_URLS.pypi}`)).toBeGreaterThan(loadAt);
    expect(start.indexOf('printf \'{"ready":true')).toBeGreaterThan(loadAt);
    expect(start.indexOf(SAFE_CHAIN_DEADLINE_LINE)).toBeLessThan(start.indexOf('rm -rf "$dir"'));
  });
});

const LOGGED_AT = "2026-10-30T10:57:30.565Z";

/** One line of Safe-Chain 1.5.12's log file, as it wrote them in a box (DIPO-376). */
function logLine(message: string, level = "verbose", timestamp: unknown = LOGGED_AT): string {
  return JSON.stringify({ timestamp, level, message });
}

/** The refusals of a log, without their times. */
const refusalsIn = (ecosystem: "npm" | "pypi", log: string) =>
  safeChainRefusalsOf(ecosystem, log).map((logged) => logged.refusal);

describe("Safe-Chain's refusals in its log (DIPO-376)", () => {
  it("reads a malware refusal from the two lines Safe-Chain 1.5.12 writes for it", () => {
    // The npm log as measured in a box: the route's check and an install of safe-chain-test.
    const log = [
      logLine("Log started, command: bun install", "info"),
      logLine("Safe-chain: Set up MITM tunnel for registry.npmjs.org:443"),
      logLine("Safe-chain: Package is-number@7.0.0 is clean"),
      logLine(
        "Safe-chain: Finished proxying request to /is-number/-/is-number-7.0.0.tgz for registry.npmjs.org",
      ),
      logLine("Safe-chain: Package safe-chain-test@0.0.1-security is marked as malware: MALWARE"),
      logLine(
        "Safe-chain: Blocking request to https://registry.npmjs.org/safe-chain-test/-/safe-chain-test-0.0.1-security.tgz",
      ),
      "",
    ].join("\n");
    expect(safeChainRefusalsOf("npm", log)).toEqual([
      {
        refusal: {
          ecosystem: "npm",
          package: "safe-chain-test@0.0.1-security",
          reason: "Aikido's malware list marks it MALWARE",
        },
        at: Date.parse(LOGGED_AT),
      },
    ]);
  });

  it("takes each refusal's time from its Blocking line, and none from a line without one (DIPO-396)", () => {
    const url = "https://registry.npmjs.org/x/-/x-1.0.0.tgz";
    const log = [
      logLine(
        "Safe-chain: Package x@1.0.0 is marked as malware: MALWARE",
        "verbose",
        "2026-10-30T10:00:00.000Z",
      ),
      logLine(`Safe-chain: Blocking request to ${url}`, "verbose", "2026-10-30T10:00:01.250Z"),
      logLine(`Safe-chain: Blocking request to ${url}`, "verbose", null),
      logLine(`Safe-chain: Blocking request to ${url}`, "verbose", "yesterday"),
      JSON.stringify({ level: "verbose", message: `Safe-chain: Blocking request to ${url}` }),
    ].join("\n");
    expect(safeChainRefusalsOf("npm", log).map((logged) => logged.at)).toEqual([
      Date.parse("2026-10-30T10:00:01.250Z"),
      null,
      null,
      null,
    ]);
  });

  it("names a refusal with no malware line as the minimum package age check's", () => {
    // The PyPI log as measured: one malware refusal, one by the minimum package age.
    const log = [
      logLine("Safe-chain: Package ghostrules@0.4.1 is marked as malware: MALWARE"),
      logLine(
        "Safe-chain: Blocking request to https://files.pythonhosted.org/packages/xx/yy/ghostrules-0.4.1.tar.gz",
      ),
      logLine("Safe-chain: Package autowebx@4.1.0 is clean"),
      logLine(
        "Safe-chain: Blocking request to https://files.pythonhosted.org/packages/xx/yy/autowebx-4.1.0-py3-none-any.whl",
      ),
    ].join("\n");
    expect(refusalsIn("pypi", log)).toEqual([
      {
        ecosystem: "pypi",
        package: "ghostrules@0.4.1",
        reason: "Aikido's malware list marks it MALWARE",
      },
      { ecosystem: "pypi", package: "autowebx-4.1.0-py3-none-any.whl", reason: MINIMUM_AGE_REASON },
    ]);
  });

  it("pairs each refusal with its own package when requests interleave, scoped and PyPI names too", () => {
    const log = [
      logLine("Safe-chain: Package @evil/pkg@1.0.0 is marked as malware: MALWARE"),
      logLine("Safe-chain: Package Foo_Bar@2.0.0 is marked as malware: PROTESTWARE"),
      logLine(
        "Safe-chain: Blocking request to https://files.pythonhosted.org/packages/xx/yy/foo_bar-2.0.0-py3-none-any.whl",
      ),
      logLine(
        "Safe-chain: Blocking request to https://registry.npmjs.org/@evil/pkg/-/pkg-1.0.0.tgz",
      ),
    ].join("\n");
    expect(refusalsIn("npm", log).map((refusal) => [refusal.package, refusal.reason])).toEqual([
      ["Foo_Bar@2.0.0", "Aikido's malware list marks it PROTESTWARE"],
      ["@evil/pkg@1.0.0", "Aikido's malware list marks it MALWARE"],
    ]);
  });

  it("leaves out every other line, a 403 body and text that is not Safe-Chain's JSON", () => {
    const log = [
      "Forbidden - blocked by safe-chain",
      "Safe-chain: Blocking request to https://registry.npmjs.org/x/-/x-1.0.0.tgz",
      logLine("Safe-chain: Tunneling request to example.com:443"),
      "{not json",
      JSON.stringify({ message: 42 }),
    ].join("\n");
    expect(refusalsIn("npm", log)).toEqual([]);
  });

  it("reads a stored record, and keeps a broken one as unknown, never as no refusals", () => {
    const record = {
      refusals: [
        { ecosystem: "npm", package: "a@1.0.0", reason: "r" },
        { ecosystem: "go", package: "b", reason: "r" },
      ],
      unknown: [{ ecosystem: "pypi", why: "w" }],
      mark: {
        box: "dipo-safe-chain-1",
        lines: { npm: 3, pypi: "x" },
        clock: { low: -20, high: 30 },
      },
    };
    expect(parseSafeChainRecord(JSON.stringify(record))).toEqual({
      refusals: [{ ecosystem: "npm", package: "a@1.0.0", reason: "r" }],
      unknown: [{ ecosystem: "pypi", why: "w" }],
      mark: {
        box: "dipo-safe-chain-1",
        lines: { npm: 3, pypi: null },
        clock: { low: -20, high: 30 },
      },
    });
    // A clock that does not read as a range is none, so its refusals are tied to no box.
    for (const clock of [undefined, null, { low: 5, high: 1 }, { low: "1", high: 2 }]) {
      const parsed = parseSafeChainRecord(
        JSON.stringify({ ...record, mark: { ...record.mark, clock } }),
      );
      expect(parsed.mark?.clock).toBeNull();
    }
    for (const broken of ["{", "42", "{}", JSON.stringify({ refusals: [] })]) {
      const parsed = parseSafeChainRecord(broken);
      expect(parsed.refusals).toEqual([]);
      expect(parsed.unknown.map((log) => log.ecosystem)).toEqual(["npm", "pypi"]);
    }
  });
});

describe("Safe-Chain's words from its log, as data (DIPO-376)", () => {
  it("keeps a decoded URL from forging a line: control characters and newlines become ?", () => {
    const log = [
      "%0A-%20npm:%20forged,%20refused%20by%20Safe-Chain:%20x",
      "%0D%0A-%20npm:%20forged",
      "a%1B%5B31mred%00%7F%C2%85%E2%80%A8%E2%80%A9b",
    ]
      .map((name) =>
        logLine(`Safe-chain: Blocking request to https://registry.npmjs.org/x/-/${name}-1.0.0.tgz`),
      )
      .join("\n");
    const packages = refusalsIn("npm", log).map((refusal) => refusal.package);
    expect(packages).toEqual([
      "?- npm: forged, refused by Safe-Chain: x-1.0.0.tgz",
      "??- npm: forged-1.0.0.tgz",
      "a?[31mred?????b-1.0.0.tgz",
    ]);
    for (const name of packages) expect(name).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(cleanLogText("x".repeat(500))).toHaveLength(200);
  });
});

/** The malware refusal of package number `n`. */
const refusal = (n: number) =>
  ({
    ecosystem: "npm",
    package: `pkg-${n}@1.0.0`,
    reason: "Aikido's malware list marks it MALWARE",
  }) as const;

describe("the size of a run's Safe-Chain record (DIPO-376)", () => {
  it("names each package once per ecosystem, and each unknown log once", () => {
    const found = uniqueFound({
      refusals: [
        refusal(1),
        refusal(1),
        { ...refusal(1), ecosystem: "pypi" },
        refusal(2),
        refusal(1),
      ],
      unknown: [
        { ecosystem: "npm", why: "w" },
        { ecosystem: "npm", why: "w" },
      ],
    });
    expect(found).toEqual({
      refusals: [refusal(1), { ...refusal(1), ecosystem: "pypi" }, refusal(2)],
      unknown: [{ ecosystem: "npm", why: "w" }],
    });
  });

  it("keeps at most SAFE_CHAIN_RECORD_MAX refusals over every session, and counts the rest", () => {
    expect(SAFE_CHAIN_RECORD_MAX).toBe(100);
    let record = EMPTY_SAFE_CHAIN_RECORD;
    // Three sessions of 60 packages, the second repeating the first's.
    for (const from of [0, 0, 60, 120]) {
      record = addSafeChainFound(
        { ...record, mark: { box: "b", lines: { npm: 0, pypi: 0 }, clock: null } },
        { refusals: Array.from({ length: 60 }, (_, i) => refusal(from + i)), unknown: [] },
      );
    }
    expect(record.refusals).toHaveLength(100);
    expect(record.refusals[0]).toEqual(refusal(0));
    expect(record.refusals[99]).toEqual(refusal(99));
    expect(record.omitted).toBe(80);
    expect(record.mark).toBeNull();
    expect(parseSafeChainRecord(JSON.stringify(record)).omitted).toBe(80);
  });
});

/** A refusal Safe-Chain logged at `at` (the box's ms), of `pkg`. */
const logged = (
  pkg: string,
  at: number | null,
  ecosystem: "npm" | "pypi" = "npm",
): SafeChainLogRefusal => ({
  refusal: { ecosystem, package: pkg, reason: "Aikido's malware list marks it MALWARE" },
  at,
});

/** Tunnels as `[client, ecosystem, opened, closed]`, by the Mac's ms. */
function clientsFrom(
  tunnels: ReadonlyArray<readonly [string | null, "npm" | "pypi", number, number | null]>,
  forgottenUntil = Number.NEGATIVE_INFINITY,
) {
  return (ecosystem: "npm" | "pypi", from: number, to: number): RegistryClients =>
    from <= forgottenUntil
      ? { kind: "forgotten" }
      : {
          kind: "seen",
          boxes: tunnels
            .filter(
              ([, of, opened, closed]) =>
                of === ecosystem && opened <= to && (closed === null || closed >= from),
            )
            .map(([client]) => client),
        };
}

const untied = (ecosystem: "npm" | "pypi", why: string) => ({
  ecosystem,
  why: `Safe-Chain refused a package ${why}, so dipo cannot tell which box asked for it`,
});

describe("which box asked for each refusal (DIPO-396)", () => {
  it("reads the box's clock against the Mac's from what date printed during one command", () => {
    // The box printed 10.5 s while the Mac's clock read 10,400 to 10,700 ms.
    expect(boxClockOffset("10.500000000", 10_400, 10_700)).toEqual({ low: -200, high: 101 });
    // Coarser output is known only to its own resolution.
    expect(boxClockOffset("10.5", 10_400, 10_700)).toEqual({ low: -200, high: 200 });
    for (const bad of ["", "N", "10.N", "10", "-1.5", "1.2.3", "clock 10.5"]) {
      expect(boxClockOffset(bad, 0, 1)).toBeNull();
    }
    expect(boxClockOffset("10.5", 2, 1)).toBeNull();
  });

  it("takes the range the start and the end of a session both allow, and none when the clock moved", () => {
    expect(sessionClockOffset({ low: -100, high: 100 }, { low: 0, high: 300 })).toEqual({
      low: -SAFE_CHAIN_CLOCK_DRIFT_MS,
      high: 100 + SAFE_CHAIN_CLOCK_DRIFT_MS,
    });
    expect(sessionClockOffset({ low: -100, high: 100 }, { low: 5_000, high: 5_100 })).toBe(
      "while the Safe-Chain box's clock moved against the Mac's",
    );
    for (const [mark, read] of [
      [null, { low: 0, high: 1 }],
      [{ low: 0, high: 1 }, null],
    ] as const) {
      expect(sessionClockOffset(mark, read)).toBe(
        "while the Safe-Chain box's clock could not be read",
      );
    }
  });

  it("keeps a refusal on the box that alone had a registry tunnel of its ecosystem open then", () => {
    // The box's clock runs 2 s ahead of the Mac's.
    const offset = { low: 2_000, high: 2_000 };
    const clients = clientsFrom([
      ["dipo-a", "npm", 10_000, 11_000],
      ["dipo-b", "npm", 20_000, 21_000],
      ["dipo-b", "pypi", 10_000, 11_000],
    ]);
    const a = logged("a@1", 12_500);
    const b = logged("b@1", 22_500);
    const read = [a, b];
    expect(refusalsOfBox(read, "dipo-a", offset, clients)).toEqual({
      refusals: [a.refusal],
      unknown: [],
    });
    expect(refusalsOfBox(read, "dipo-b", offset, clients)).toEqual({
      refusals: [b.refusal],
      unknown: [],
    });
    // A box with no tunnel then gets neither: each is another box's.
    expect(refusalsOfBox(read, "dipo-c", offset, clients)).toEqual({ refusals: [], unknown: [] });
  });

  it("ties the same package to each box that asked for it at its own time", () => {
    const offset = { low: 0, high: 0 };
    const clients = clientsFrom([
      ["dipo-a", "npm", 10_000, 11_000],
      ["dipo-b", "npm", 20_000, 21_000],
    ]);
    const a = logged("same@1", 10_500);
    const b = logged("same@1", 20_500);
    expect(refusalsOfBox([a, b], "dipo-a", offset, clients).refusals).toEqual([a.refusal]);
    expect(refusalsOfBox([a, b], "dipo-b", offset, clients).refusals).toEqual([b.refusal]);
    // At the same time: neither box's, unknown on both.
    const both = clientsFrom([
      ["dipo-a", "npm", 10_000, 11_000],
      ["dipo-b", "npm", 10_200, 10_900],
    ]);
    for (const box of ["dipo-a", "dipo-b"]) {
      expect(refusalsOfBox([logged("same@1", 10_500)], box, offset, both)).toEqual({
        refusals: [],
        unknown: [untied("npm", "while more than one box had a registry tunnel open")],
      });
    }
  });

  it("widens each refusal's span by the clock's range and the slack, so a near tunnel makes it unknown", () => {
    const offset = { low: -300, high: 300 };
    // dipo-b's tunnel closed just inside the span of a refusal in dipo-a's.
    const edge = 10_500 - 300 - SAFE_CHAIN_TIME_SLACK_MS;
    const clients = clientsFrom([
      ["dipo-b", "npm", 9_000, edge],
      ["dipo-a", "npm", 10_400, 11_000],
    ]);
    expect(refusalsOfBox([logged("x@1", 10_500)], "dipo-a", offset, clients).unknown).toEqual([
      untied("npm", "while more than one box had a registry tunnel open"),
    ]);
    const apart = clientsFrom([
      ["dipo-b", "npm", 9_000, edge - 1],
      ["dipo-a", "npm", 10_400, 11_000],
    ]);
    expect(refusalsOfBox([logged("x@1", 10_500)], "dipo-a", offset, apart).refusals).toHaveLength(
      1,
    );
  });

  it("keeps a refusal whose box cannot be told as unknown, naming no package, never as one box's", () => {
    const offset = { low: 0, high: 0 };
    const cases: ReadonlyArray<readonly [ReturnType<typeof clientsFrom>, string]> = [
      [clientsFrom([]), "while no box had a registry tunnel open"],
      [
        clientsFrom([
          ["dipo-a", "npm", 10_000, 11_000],
          [null, "npm", 10_000, 11_000],
        ]),
        "while a registry tunnel that named no box dipo admitted was open",
      ],
      [
        clientsFrom([[null, "npm", 10_000, 11_000]]),
        "while a registry tunnel that named no box dipo admitted was open",
      ],
      [
        clientsFrom([["dipo-a", "npm", 10_000, 11_000]], 20_000),
        "longer ago than dipo keeps its registry tunnels",
      ],
    ];
    for (const [clients, why] of cases) {
      const found = refusalsOfBox([logged("secret-name@1", 10_500)], "dipo-a", offset, clients);
      expect(found).toEqual({ refusals: [], unknown: [untied("npm", why)] });
      expect(JSON.stringify(found)).not.toContain("secret-name");
    }
    const alone = clientsFrom([["dipo-a", "npm", 10_000, 11_000]]);
    expect(refusalsOfBox([logged("x@1", null)], "dipo-a", offset, alone).unknown).toEqual([
      untied("npm", "on a log line that names no time"),
    ]);
    for (const why of [
      "while the Safe-Chain box's clock could not be read",
      "while the Safe-Chain box's clock moved against the Mac's",
    ]) {
      expect(refusalsOfBox([logged("x@1", 10_500, "pypi")], "dipo-a", why, alone)).toEqual({
        refusals: [],
        unknown: [untied("pypi", why)],
      });
    }
    // Nothing read, nothing unknown.
    expect(
      refusalsOfBox([], "dipo-a", "while the Safe-Chain box's clock could not be read", alone),
    ).toEqual({
      refusals: [],
      unknown: [],
    });
  });
});
