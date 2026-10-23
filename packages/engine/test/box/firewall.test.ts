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
  checkFirewallListing,
  CONTAINED_KEEPALIVE,
  containedCommand,
  DROPPED_CAPABILITIES,
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

  it("is not a contained command: every other command loses the capabilities that reach around the rule", () => {
    const command = containedCommand(["claude", "-p", "hi"]);
    expect(command.slice(0, 4)).toEqual(netToolCommand("setpriv", []));
    expect(command).toContain("--no-new-privs");
    expect(command).toContain("--inh-caps=-all");
    expect(command).toContain(
      `--bounding-set=${DROPPED_CAPABILITIES.map((cap) => `-${cap}`).join(",")}`,
    );
    expect(DROPPED_CAPABILITIES).toEqual([
      "net_admin",
      "net_raw",
      "sys_admin",
      "sys_module",
      "sys_ptrace",
      "sys_rawio",
    ]);
    expect(command.slice(command.indexOf("--") + 1)).toEqual(["claude", "-p", "hi"]);
    expect(uncontained(command)).toEqual(["claude", "-p", "hi"]);
    expect(uncontained(["claude"])).toBeNull();
    expect(isFirewallCommand(command)).toBe(false);
    // The box keeps itself running with the mounted tail, never one of its own.
    expect(CONTAINED_KEEPALIVE).toEqual(netToolCommand("tail", ["-f", "/dev/null"]));
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
