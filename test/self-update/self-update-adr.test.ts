// The decision lines the update from the base changes (DIPO-485): 0016's install line, 0005's
// Upgrades line, and one Replaced line each, so no ADR still says dipo never updates itself.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string) => readFileSync(join(root, "docs", "decisions", file), "utf8");

describe("the self-update decision lines (DIPO-485)", () => {
  it("0016 describes the update from the base and keeps its replaced line", () => {
    const text = read("0016-ci-release-and-versioning.md");
    expect(text).toContain(
      "dipo updates itself only from the base commit of an office whose repository is dipo's source, when idle, on the maintainer's confirm; a release install updates with the install script.",
    );
    expect(text).not.toContain("There is no self-update. ");
    const replaced = text.slice(text.indexOf("## Replaced"));
    expect(replaced).toContain('"There is no self-update."');
  });

  it("0005 describes the update in Upgrades and in a Replaced line beside the auto-restart one", () => {
    const text = read("0005-command-and-event-model.md");
    expect(text).toContain(
      "An update from the desk (DIPO-485) pauses new starts, swaps the binary and runs `dipo daemon restart` itself.",
    );
    const replaced = text.slice(text.indexOf("## Replaced")).split("\n");
    const auto = replaced.findIndex((line) => line.startsWith("- Auto-restart on upgrade"));
    expect(auto).toBeGreaterThan(-1);
    expect(replaced[auto]).toContain("`daemon.update`, DIPO-485");
    expect(replaced[auto]).toContain("`dipo daemon restart`");
  });

  it("upgrade.ts no longer says the daemon never restarts itself", () => {
    const header = readFileSync(join(root, "packages", "daemon", "src", "upgrade.ts"), "utf8")
      .split("\n")
      .slice(0, 6)
      .join("\n");
    expect(header).not.toContain("never restarts itself");
    expect(header).toContain("DIPO-485");
  });
});
