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
  SAFE_CHAIN_BOX_PORTS,
  SAFE_CHAIN_BUILD_FILES,
  SAFE_CHAIN_MALWARE_LIST_HOST,
  SAFE_CHAIN_REGISTRY_HOSTS,
  SAFE_CHAIN_RELEASE,
  SAFE_CHAIN_UPSTREAM_HOSTS,
  safeChainBuildPlan,
  safeChainImageTag,
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
