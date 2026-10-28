// The box firewall's pure parts (DIPO-281, from DIPO-283): the rule a box gets, the check that it
// took, the one command that may run with a box's capabilities, the contained form of every other
// command, and the check of the box network tools folder before it is mounted. The rule itself in
// a real box is tested in box-network.ci.test.ts.
//
// Addresses are documentation addresses (RFC 5737, RFC 3849).

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  BOX_NET_TOOLS_PATH,
  BOX_USER_GID,
  BOX_USER_UID,
  BOX_NPM_PREFIX,
  BOX_USER_ENV,
  BOX_USER_HOME,
  boundingSet,
  checkFirewallListing,
  CONTAINED_KEEPALIVE,
  containedCommand,
  isRootStepWrapped,
  ROOT_STEP_CAPABILITIES,
  rootStepCommand,
  USER_CAPABILITIES,
  firewallCommand,
  firewallListCommand,
  firewallRules,
  isFirewallCommand,
  netToolCommand,
  netToolsDir,
  resolveNetToolsMount,
  uncontained,
} from "../../src/box/firewall";
import { BoxError } from "../../src/box/port";

/** The box user's environment a contained command sets in the box, by key. */
function envOf(command: readonly string[]): Record<string, string> {
  const inner = command.slice(command.indexOf("--") + 1);
  return Object.fromEntries(
    inner
      .slice(9, 13)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

const TAG = `dipo-box:${"ab".repeat(32)}`;

/** What `nft list chain inet dipo output` prints for the rule of `ports` on `address`. */
function listing(address: string, ports: string, priority = "filter", policy = "drop"): string {
  const match = address.includes(":") ? "ip6 daddr" : "ip daddr";
  return [
    "table inet dipo {",
    "\tchain output {",
    `\t\ttype filter hook output priority ${priority}; policy ${policy};`,
    '\t\toifname "lo" accept',
    `\t\t${match} ${address} tcp dport ${ports} accept`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

describe("the rule a box gets", () => {
  it("drops every packet out but to loopback and the Mac's box address on dipo's ports", () => {
    expect(firewallRules({ hostAddress: "192.0.2.1", ports: [4000, 3128, 4000] })).toBe(
      'flush ruleset ; add table inet dipo ; add chain inet dipo output { type filter hook output priority 0 ; policy drop ; } ; add rule inet dipo output oifname "lo" accept ; add rule inet dipo output ip daddr 192.0.2.1 tcp dport { 3128, 4000 } accept',
    );
    expect(firewallRules({ hostAddress: "2001:db8::1", ports: [3128] })).toContain(
      "ip6 daddr 2001:db8::1 tcp dport { 3128 } accept",
    );
    expect(firewallCommand({ hostAddress: "192.0.2.1", ports: [3128] })).toEqual([
      `${BOX_NET_TOOLS_PATH}/ld.so`,
      "--library-path",
      `${BOX_NET_TOOLS_PATH}/lib`,
      `${BOX_NET_TOOLS_PATH}/bin/nft`,
      firewallRules({ hostAddress: "192.0.2.1", ports: [3128] }),
    ]);
  });

  it("refuses an address that is no IP literal and ports out of range, none or too many", () => {
    for (const hostAddress of ["mac.example", "", "192.0.2.1; flush ruleset", "::1 accept"]) {
      expect(() => firewallRules({ hostAddress, ports: [3128] })).toThrow(BoxError);
    }
    for (const ports of [[], [0], [65_536], [1.5], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      expect(() => firewallRules({ hostAddress: "192.0.2.1", ports })).toThrow(BoxError);
    }
  });

  it("shows as set only when nft lists the drop policy, loopback and each port of the address", () => {
    const firewall = { hostAddress: "192.0.2.1", ports: [3128, 4000] };
    expect(checkFirewallListing(listing("192.0.2.1", "{ 3128, 4000 }"), firewall)).toBe(true);
    expect(checkFirewallListing(listing("192.0.2.1", "{ 3128, 4000 }", "0"), firewall)).toBe(true);
    // A set of one port prints as the port alone.
    const one = { hostAddress: "192.0.2.1", ports: [3128] };
    expect(checkFirewallListing(listing("192.0.2.1", "3128"), one)).toBe(true);
    expect(checkFirewallListing(listing("192.0.2.1", "{ 3128 }"), one)).toBe(true);
    const six = { hostAddress: "2001:db8::1", ports: [3128] };
    expect(checkFirewallListing(listing("2001:db8::1", "3128"), six)).toBe(true);
    // What a box could have changed it to, or a listing of something else, is no rule.
    for (const text of [
      listing("192.0.2.1", "{ 3128, 4000 }", "filter", "accept"),
      listing("192.0.2.1", "{ 3128 }"),
      listing("192.0.2.99", "{ 3128, 4000 }"),
      listing("192.0.2.1", "{ 3128, 4000, 22 }"),
      "",
      "Error: No such file or directory",
    ]) {
      expect(checkFirewallListing(text, firewall)).toBe(false);
    }
  });
});

/** What `nft list table inet dipo` prints for the Safe-Chain box's rule (DIPO-343). */
function safeChainListing(address: string, out: string, inbound: string, policy = "drop"): string {
  return [
    "table inet dipo {",
    "\tchain output {",
    "\t\ttype filter hook output priority filter; policy drop;",
    '\t\toifname "lo" accept',
    "\t\tct state established,related accept",
    `\t\tip daddr ${address} tcp dport ${out} accept`,
    "\t}",
    "",
    "\tchain input {",
    `\t\ttype filter hook input priority filter; policy ${policy};`,
    '\t\tiifname "lo" accept',
    "\t\tct state established,related accept",
    `\t\tip saddr ${address} tcp dport ${inbound} accept`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

describe("the rule the Safe-Chain box gets (DIPO-343)", () => {
  const firewall = { hostAddress: "192.0.2.1", ports: [41000], inbound: [8102, 8101] };

  it("lets out only what it answers and the upstream listener, and in only the Mac's address on its ports", () => {
    expect(firewallRules(firewall)).toBe(
      [
        "flush ruleset",
        "add table inet dipo",
        "add chain inet dipo output { type filter hook output priority 0 ; policy drop ; }",
        'add rule inet dipo output oifname "lo" accept',
        "add rule inet dipo output ct state established,related accept",
        "add rule inet dipo output ip daddr 192.0.2.1 tcp dport { 41000 } accept",
        "add chain inet dipo input { type filter hook input priority 0 ; policy drop ; }",
        'add rule inet dipo input iifname "lo" accept',
        "add rule inet dipo input ct state established,related accept",
        "add rule inet dipo input ip saddr 192.0.2.1 tcp dport { 8101, 8102 } accept",
      ].join(" ; "),
    );
    expect(firewallListCommand(firewall)).toEqual(
      netToolCommand("nft", ["list", "table", "inet", "dipo"]),
    );
    for (const inbound of [[], [0], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      expect(() => firewallRules({ ...firewall, inbound })).toThrow(BoxError);
    }
  });

  it("shows as set only with both chains, their drop policies and every rule", () => {
    expect(
      checkFirewallListing(safeChainListing("192.0.2.1", "41000", "{ 8101, 8102 }"), firewall),
    ).toBe(true);
    for (const text of [
      safeChainListing("192.0.2.1", "41000", "{ 8101, 8102 }", "accept"),
      safeChainListing("192.0.2.1", "41000", "{ 8101, 8102, 22 }"),
      safeChainListing("192.0.2.99", "41000", "{ 8101, 8102 }"),
      listing("192.0.2.1", "41000"),
    ]) {
      expect(checkFirewallListing(text, firewall)).toBe(false);
    }
  });

  it("runs with the box's capabilities only exactly as dipo writes it, and its table's list", () => {
    const rule = firewallCommand(firewall);
    expect(isFirewallCommand(rule)).toBe(true);
    expect(isFirewallCommand(firewallListCommand(firewall))).toBe(true);
    const tool = netToolCommand("nft", []);
    for (const args of [
      [rule.at(-1)!.replace("dport { 8101, 8102 }", "dport { 1-65535 }")],
      [rule.at(-1)!.replace("ip saddr 192.0.2.1", "ip saddr 0.0.0.0/0")],
      [
        rule
          .at(-1)!
          .replace(
            " ; add chain inet dipo input { type filter hook input priority 0 ; policy drop ; }",
            " ; add chain inet dipo input { type filter hook input priority 0 ; policy accept ; }",
          ),
      ],
      [`${rule.at(-1)!} ; add rule inet dipo input accept`],
      ["list", "table", "inet", "other"],
    ]) {
      expect(isFirewallCommand([...tool, ...args])).toBe(false);
    }
  });
});

describe("what runs with a box's capabilities", () => {
  it("is only the rule exactly as dipo writes it, and the list of its chain", () => {
    const rule = firewallCommand({ hostAddress: "192.0.2.1", ports: [3128, 4000] });
    expect(isFirewallCommand(rule)).toBe(true);
    expect(isFirewallCommand(firewallListCommand())).toBe(true);
    const tool = netToolCommand("nft", []);
    for (const args of [
      ["flush ruleset"],
      ["flush ruleset ; add table inet dipo"],
      [rule.at(-1)!.replace("policy drop", "policy accept")],
      [rule.at(-1)!.replace("{ 3128, 4000 }", "{ 1-65535 }")],
      [`${rule.at(-1)!} ; flush ruleset`],
      [rule.at(-1)!, "extra"],
      ["list", "ruleset"],
      ["-f", "/tmp/rules"],
    ]) {
      expect(isFirewallCommand([...tool, ...args])).toBe(false);
    }
    // The rule through the box's own nft, or another tool, is not it either.
    expect(isFirewallCommand(["nft", rule.at(-1)!])).toBe(false);
    expect(isFirewallCommand(netToolCommand("setpriv", [rule.at(-1)!]))).toBe(false);
  });

  it("is not a contained command: every other command runs as the box user with no capability (DIPO-334)", () => {
    const command = containedCommand(["claude", "-p", "hi"]);
    expect(command.slice(0, 4)).toEqual(netToolCommand("setpriv", []));
    // The fixed non-root uid and gid by number, no other group, and an allow list of none.
    expect(command.slice(4, command.indexOf("--"))).toEqual([
      `--reuid=${BOX_USER_UID}`,
      `--regid=${BOX_USER_GID}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
    ]);
    expect(BOX_USER_UID).not.toBe(0);
    expect(BOX_USER_GID).not.toBe(0);
    expect(USER_CAPABILITIES).toEqual([]);
    // The image's env sets the box user's environment before the program is looked up.
    expect(command.slice(command.indexOf("--") + 1)).toEqual([
      "/usr/bin/env",
      ...["HOME", "USER", "LOGNAME", "PATH"].flatMap((key) => ["-u", key]),
      `HOME=${BOX_USER_HOME}`,
      "USER=dipo",
      "LOGNAME=dipo",
      `PATH=${BOX_NPM_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "claude",
      "-p",
      "hi",
    ]);
    expect(uncontained(command)).toEqual(["claude", "-p", "hi"]);
    expect(uncontained(["claude"])).toBeNull();
    expect(isFirewallCommand(command)).toBe(false);
    expect(isRootStepWrapped(command)).toBe(false);
    // The tools folder sits directly under `/`, where the box user cannot rename its parent.
    expect(BOX_NET_TOOLS_PATH).toBe("/dipo-net");
    // The box keeps itself running with the mounted tail, never one of its own.
    expect(CONTAINED_KEEPALIVE).toEqual(netToolCommand("tail", ["-f", "/dev/null"]));
  });

  it("keeps the box user's environment and lets a command's own value replace one key only (DIPO-334)", () => {
    // Without an environment, and with one that names none of the keys: the box user's, whole.
    expect(envOf(containedCommand(["claude", "--version"]))).toEqual({ ...BOX_USER_ENV });
    expect(
      envOf(containedCommand(["claude", "--version"], { DISABLE_AUTOUPDATER: "1", A: "x" })),
    ).toEqual({ ...BOX_USER_ENV });
    // A command's own PATH replaces PATH, and HOME stays the box user's.
    expect(envOf(containedCommand(["bun", "install"], { PATH: "/opt/x/bin" }))).toEqual({
      ...BOX_USER_ENV,
      PATH: "/opt/x/bin",
    });
    // Claude Code and the package managers are found through the npm prefix, first on PATH.
    expect(BOX_USER_ENV["PATH"]?.split(":")[0]).toBe(`${BOX_NPM_PREFIX}/bin`);
    // A command that only looks like the wrapper is no contained command.
    expect(uncontained(netToolCommand("setpriv", ["--", "/usr/bin/env", "claude"]))).toBeNull();
  });

  it("runs dipo's root steps as root with an allow list that never holds the network (DIPO-334)", () => {
    const command = rootStepCommand(["/bin/chmod", "0755", "/usr/local/bin/dipo-part"]);
    expect(command.slice(0, 4)).toEqual(netToolCommand("setpriv", []));
    const options = command.slice(4, command.indexOf("--"));
    expect(options).toEqual([
      "--inh-caps=-all",
      "--ambient-caps=-all",
      boundingSet(ROOT_STEP_CAPABILITIES),
      "--no-new-privs",
    ]);
    expect(options.some((option) => option.startsWith("--reuid"))).toBe(false);
    // An allow list: everything is dropped first, then only the listed ones kept.
    expect(boundingSet(ROOT_STEP_CAPABILITIES)).toBe(
      "--bounding-set=-all,+audit_write,+chown,+dac_override,+dac_read_search,+fowner,+fsetid,+kill,+setgid,+setuid,+sys_chroot",
    );
    for (const cap of [
      "net_admin",
      "net_raw",
      "sys_admin",
      "sys_module",
      "sys_ptrace",
      "sys_rawio",
      "setpcap",
      "setfcap",
      "mknod",
    ]) {
      expect(ROOT_STEP_CAPABILITIES).not.toContain(cap);
    }
    expect(uncontained(command)).toEqual(["/bin/chmod", "0755", "/usr/local/bin/dipo-part"]);
    expect(isRootStepWrapped(command)).toBe(true);
    expect(isFirewallCommand(command)).toBe(false);
  });
});

/** A tools folder holding each tool, under `root`. */
function tools(root: string): string {
  const dir = netToolsDir(root, TAG);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  for (const file of ["ld.so", "bin/nft", "bin/setpriv", "bin/tail"]) {
    writeFileSync(join(dir, file), "x");
  }
  return dir;
}

describe("the box network tools folder", () => {
  it("is named by the image's hash, and only a dipo box image tag names one", () => {
    expect(netToolsDir("/state/tools", TAG)).toBe(`/state/tools/${"ab".repeat(32)}`);
    expect(() => netToolsDir("/state/tools", "alpine")).toThrow(BoxError);
  });

  it("mounts only a folder under dipo's tools root that holds every tool as a regular file", () =>
    withTempDir(async (tmp) => {
      const root = join(tmp, "box-net-tools");
      const dir = tools(root);
      expect(await resolveNetToolsMount(dir, root)).toBe(dir);
      const missing = async (path: string, under = root) => {
        const error = await resolveNetToolsMount(path, under).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BoxError);
        expect((error as BoxError).code).toBe("box.netToolsMissing");
      };
      await missing("relative/tools");
      await missing(join(root, "absent"));
      await missing(dir, join(tmp, "no-root"));
      // A folder outside the root, also through a symlink in it.
      const outside = tools(join(tmp, "elsewhere"));
      await missing(outside);
      symlinkSync(outside, join(root, "link"));
      await missing(join(root, "link"));
      // A tool that is a symlink, or missing.
      const linked = netToolsDir(root, `dipo-box:${"cd".repeat(32)}`);
      mkdirSync(join(linked, "bin"), { recursive: true });
      writeFileSync(join(linked, "ld.so"), "x");
      symlinkSync("/bin/sh", join(linked, "bin", "nft"));
      writeFileSync(join(linked, "bin", "setpriv"), "x");
      writeFileSync(join(linked, "bin", "tail"), "x");
      await missing(linked);
    }));
});
