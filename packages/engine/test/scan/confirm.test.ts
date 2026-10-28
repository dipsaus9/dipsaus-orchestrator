// The confirmations laid over the code profile (DIPO-310, 0013 sections 2 to 6): a confirmation
// resolves only what code left unresolved or in conflict and gives the source it was made with;
// a pending proposal never enters the effective profile; a confirmation made at another
// fingerprint is stale and keeps working; code that now resolves a capability replaces its
// confirmation with a diff line; the refusals name the fallback command.

import { describe, expect, it } from "bun:test";

import {
  confirmationFix,
  type Confirmation,
  deviationFix,
  effectiveProfile,
  levelOf,
  mootProposals,
  NO_MARKS,
  type Proposal,
  type ScanMarks,
  staleLines,
  supersededConfirmations,
} from "../../src/scan/confirm";
import { detect, type Probe, type RunProfile } from "../../src/scan/detect";

const json = (value: unknown) => JSON.stringify(value);

function probe(scripts: Record<string, string>, extra: Partial<Probe> = {}): Probe {
  return {
    texts: { "package.json": json({ name: "app", scripts }) },
    lockfiles: ["bun.lock"],
    workspaceDirs: [],
    envFiles: [],
    ...extra,
  };
}

/** Verify composed by code from the `test` script alone. */
const COMPOSED = detect(probe({ test: "bun test", dev: "vite" }));
/** No test, lint or typecheck to compose verify from: code leaves it unresolved. */
const BARE = detect(probe({ dev: "vite" }));

const confirmation = (over: Partial<Confirmation> = {}): Confirmation => ({
  capability: "verify",
  source: "maintainer",
  spec: { commands: [["make", "check"]], cwd: "." },
  evidence: "set by the maintainer",
  fingerprint: BARE.fingerprint,
  confirmedAt: 1_000,
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  capability: "verify",
  spec: { commands: [["make", "check"]], cwd: "." },
  modelConfidence: "medium",
  evidence: ["Makefile: target check runs the tests"],
  fingerprint: BARE.fingerprint,
  runId: "run_01",
  proposedAt: 2_000,
  ...over,
});

const marks = (over: Partial<ScanMarks>): ScanMarks => ({ ...NO_MARKS, ...over });

describe("effectiveProfile", () => {
  it("leaves the code profile as it is without marks, with the infer command in the refusal", () => {
    expect(COMPOSED.capabilities.verify.status).toBe("resolved");
    expect(BARE.capabilities.verify.status).toBe("unresolved");
    const effective = effectiveProfile(BARE, NO_MARKS);
    expect(effective.profile.capabilities).toEqual(BARE.capabilities);
    expect(effective.profile.runRefusal).toContain(BARE.runRefusal ?? "missing");
    expect(effective.profile.runRefusal).toContain("`dipo office infer`");
    expect(effective.profile.runRefusal).toContain("`dipo office confirm set verify -- <command>`");
  });

  it("resolves an unresolved capability from a maintainer confirmation and clears the run refusal", () => {
    const effective = effectiveProfile(BARE, marks({ confirmations: [confirmation()] }));
    expect(effective.profile.capabilities.verify).toMatchObject({
      status: "resolved",
      value: { commands: [["make", "check"]], cwd: "." },
      source: "maintainer",
    });
    expect(effective.marks.verify).toMatchObject({ confirmed: true, stale: false, pending: null });
    expect(effective.profile.runRefusal).toBeNull();
  });

  it("gives an accepted proposal the source inferred", () => {
    const effective = effectiveProfile(
      BARE,
      marks({ confirmations: [confirmation({ source: "inferred" })] }),
    );
    const verify = effective.profile.capabilities.verify;
    expect(verify.status === "resolved" ? verify.source : null).toBe("inferred");
  });

  it("never puts a pending proposal into the effective profile, so run still refuses", () => {
    const effective = effectiveProfile(BARE, marks({ proposals: [proposal()] }));
    expect(effective.profile.capabilities.verify.status).toBe("unresolved");
    expect(effective.marks.verify.pending).toMatchObject({
      spec: { commands: [["make", "check"]] },
    });
    expect(effective.marks.verify.confirmed).toBe(false);
    expect(effective.profile.runRefusal).not.toBeNull();
  });

  it("marks a confirmation made at another fingerprint stale and keeps it working", () => {
    const effective = effectiveProfile(
      BARE,
      marks({ confirmations: [confirmation({ fingerprint: "sha256:older" })] }),
    );
    expect(effective.marks.verify).toMatchObject({ confirmed: true, stale: true });
    expect(effective.profile.capabilities.verify.status).toBe("resolved");
    expect(effective.profile.runRefusal).toBeNull();
  });

  it("ignores a confirmation of a capability code resolves", () => {
    const effective = effectiveProfile(
      COMPOSED,
      marks({ confirmations: [confirmation({ fingerprint: COMPOSED.fingerprint })] }),
    );
    expect(effective.profile.capabilities.verify).toEqual(COMPOSED.capabilities.verify);
    expect(effective.marks.verify.confirmed).toBe(false);
  });

  it("drops the missing-dev deviation and counts toward Conforming when nothing is to start", () => {
    const cli = detect(probe({ test: "bun test", verify: "bun test" }));
    expect(cli.conformance.level).toBe("partial");
    expect(cli.conformance.deviations.map((d) => d.code)).toContain("missing-dev");
    const effective = effectiveProfile(cli, marks({ nothingToStart: true }));
    expect(effective.profile.conformance.level).toBe("conforming");
    expect(effective.profile.conformance.deviations.map((d) => d.code)).not.toContain(
      "missing-dev",
    );
    expect(effective.testRefusal).toBeNull();
  });

  it("refuses the test command while dev is unresolved and names the fallback", () => {
    const cli = detect(probe({ test: "bun test", verify: "bun test" }));
    const refusal = effectiveProfile(cli, NO_MARKS).testRefusal;
    expect(refusal).toContain('"dev" is unresolved');
    expect(refusal).toContain("`dipo office infer`");
    expect(refusal).toContain("`dipo office confirm nothing-to-start`");
  });

  it("lets a stale confirmed dev keep the test command working", () => {
    const cli = detect(probe({ test: "bun test", verify: "bun test" }));
    const effective = effectiveProfile(
      cli,
      marks({
        confirmations: [
          confirmation({
            capability: "dev",
            spec: { commands: [["bun", "src/server.ts"]], cwd: "." },
            fingerprint: "sha256:older",
          }),
        ],
      }),
    );
    expect(effective.marks.dev.stale).toBe(true);
    expect(effective.testRefusal).toBeNull();
  });

  it("refuses the test command while install is unresolved", () => {
    const none = detect({ ...probe({}), texts: {} });
    expect(effectiveProfile(none, NO_MARKS).testRefusal).toContain("Install is unresolved");
  });
});

describe("a rescan's view of the confirmations", () => {
  it("names a confirmation code now resolves, with a diff line, and the proposals it makes moot", () => {
    const stored = marks({ confirmations: [confirmation()], proposals: [proposal()] });
    const superseded = supersededConfirmations(COMPOSED, stored);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.capability).toBe("verify");
    expect(superseded[0]?.line).toContain("~ verify confirmation: make check [maintainer]");
    expect(superseded[0]?.line).toContain("code resolves it: bun run test");
    expect(superseded[0]?.line).toContain("the confirmation is removed");
    expect(mootProposals(COMPOSED, stored)).toEqual(["verify"]);
    expect(supersededConfirmations(BARE, stored)).toEqual([]);
    expect(mootProposals(BARE, stored)).toEqual([]);
  });

  it("reports a confirmation turning stale on a fingerprint change, once", () => {
    const stored = marks({ confirmations: [confirmation()] });
    expect(staleLines(BARE.fingerprint, BARE.fingerprint, stored)).toEqual([]);
    expect(staleLines(null, "sha256:new", stored)).toEqual([]);
    const lines = staleLines(BARE.fingerprint, "sha256:new", stored);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("! verify confirmation is stale");
    expect(lines[0]).toContain("`dipo office confirm keep verify`");
    // Already stale at the earlier fingerprint: no second line.
    expect(staleLines("sha256:new", "sha256:newer", stored)).toEqual([]);
  });
});

describe("levelOf", () => {
  it("keeps non-standard and reads Conforming from the code profile", () => {
    const none = detect({ ...probe({}), texts: {} });
    expect(levelOf(none, true)).toBe("non-standard");
    const full = detect(probe({ test: "bun test", dev: "vite", verify: "bun test" }));
    expect(levelOf(full, false)).toBe(full.conformance.level);
  });
});

describe("fixes", () => {
  it("names the standard script that removes a deviation", () => {
    const profile: RunProfile = BARE;
    const fixes = Object.fromEntries(
      profile.conformance.deviations.map((d) => [d.code, deviationFix(d)]),
    );
    expect(fixes["missing-test"]).toBe('add a "test" script');
    expect(fixes["missing-lint"]).toBe('add a "lint" script');
    expect(deviationFix({ code: "verify-conflict", conflict: true, message: "" })).toContain(
      "verify:puzzle",
    );
    expect(deviationFix({ code: "something-else", conflict: false, message: "" })).toBeNull();
    expect(confirmationFix("verify")).toBe(
      'add a "verify" script, so code resolves it and the confirmation can go',
    );
  });
});
