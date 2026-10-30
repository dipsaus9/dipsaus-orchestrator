import { describe, expect, it } from "bun:test";

import { ClientError } from "@dipsaus-orchestrator/client";
import { OtherVersionError } from "@dipsaus-orchestrator/client/node";
import type { OfficeId } from "@dipsaus-orchestrator/contract";

import { main } from "./index";
import { connectFailure, releaseStdin, resolveTypedPath, workspaceOffice } from "./tui-command";
import { fakeWorkspace } from "../test/support/fake-workspace";

describe("dipo tui", () => {
  it("hands its arguments to the TUI", async () => {
    const seen: (readonly string[])[] = [];
    const deps = {
      tui: async (args: readonly string[]) => {
        seen.push(args);
        return 0;
      },
    };
    expect(await main(["tui", "--ascii"], deps as never)).toBe(0);
    expect(seen).toEqual([["--ascii"]]);
  });

  it("resolves a typed path against the current directory and the home directory", () => {
    expect(resolveTypedPath("/work", "app", "/home/me")).toBe("/work/app");
    expect(resolveTypedPath("/work", "/srv/app", "/home/me")).toBe("/srv/app");
    expect(resolveTypedPath("/work", "~/code/app", "/home/me")).toBe("/home/me/code/app");
    expect(resolveTypedPath("/work", "~", "/home/me")).toBe("/home/me");
  });

  it("says which version the daemon runs when it refuses this client (0005)", () => {
    expect(connectFailure(new OtherVersionError("2.0.0", "0.1.0")).message).toBe(
      "daemon runs v2.0.0, this binary is v0.1.0, run `dipo daemon restart`",
    );
    const refused = new ClientError("args.invalid", "bad hello");
    expect(connectFailure(refused).message).toBe("args.invalid: bad hello");
    expect(connectFailure(new Error("autostart is off")).message).toBe("autostart is off");
  });

  it("finds the office of the current directory", async () => {
    const office = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0CAA" as OfficeId;
    const repository = { mainWorktree: "/work", commonDir: "/work/.git", office };
    expect(await workspaceOffice(fakeWorkspace({ repository }))).toBe(office);
    expect(await workspaceOffice(fakeWorkspace())).toBeNull();
  });

  it("is in the help", async () => {
    const lines: string[] = [];
    await main(["--help"], { writeLine: (line: string) => lines.push(line) } as never);
    expect(lines.join("\n")).toContain(
      "dipo tui [--office <id>] [--no-color] [--ascii] [--inline]",
    );
  });

  it("releases stdin only when it can be unreferenced (stdin from /dev/null cannot)", () => {
    let released = 0;
    const tty = {
      unref() {
        released += this === tty ? 1 : 0;
      },
    };
    releaseStdin(tty);
    expect(released).toBe(1);
    expect(() => releaseStdin({})).not.toThrow();
  });
});
