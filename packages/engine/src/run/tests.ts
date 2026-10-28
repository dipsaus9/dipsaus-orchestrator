// Testing a story (DIPO-309, 0002): `test.start` runs the story's pushed head in a test box and
// shows the manual steps, `test.record` records the maintainer's pass or fail, and the sweep closes
// tests nobody records.
//
// - `test.start { story }`. The story must be In Review in phase review, test or merge, with its
//   claim live and a pushed head (`test.notInReview` otherwise), and have at least one manual
//   test-plan entry (`story.notTestable`); flagged test-before-merge or not. The run profile's
//   fingerprint is checked first (scan trigger `test`), and an office whose install or `dev` is
//   unresolved is refused (`test.refused`, naming the capability). Then a new test box per test
//   (`box/test-box.ts`): the office image at the pushed head, install, setup and `dev`, reached
//   through a forwarder on the Mac's loopback. The reply carries the test id, the head, the steps
//   in order, `checkout` (the box's name), `url` and `shell`; `test.started` shows it in
//   `office.snapshot`. One open test per story: a story whose open test is for its head gets it
//   back unchanged; one for an older head is closed first. Several stories may each have one.
// - `test.record { test, result, note? }`. A test that is no longer open, or whose head is older
//   than the story's current head, is refused (`test.closed`; the older one is closed). The result
//   and note are stored for the head, the story's test gate for it is decided by the maintainer
//   (`test-records.ts`), and the box is deleted. A pass decides an open merge gate of the head that
//   waits only on the test-before-merge flag (`decideTestedMergeGates`), and the merge gate of a
//   head with a pass never waits on the flag. A fail sends the note once to the same builder as a
//   fix round item keyed on the test id, with no cap (`FixRounds.testFail`, the one feedback path).
//   The story PR's status block is rewritten with the result.
// - The sweep (`sweep`, on the daemon's box tick): an open test closes, its box deleted, once a new
//   head is pushed, its story is dropped, discarded or merged (its claim released), it is no
//   longer In Review, or `timeouts.testIdleMinutes` passed since it started with no record, read on
//   the engine's clock. A test whose start this daemon does not run any more (a restart during the
//   start) closes too.
// - `recover` (daemon start): an open test whose box still runs gets its firewall and forwarder
//   again (`TestBoxes.reattach`), on the same port when it is free; one whose box is gone closes.
//   Then every test box no open test names is deleted (`TestBoxes.sweep`).

import { mkdirSync, rmSync } from "node:fs";

import {
  type Clock,
  type IdSource,
  type OfficeId,
  type RunId,
  type StoryKey,
  type TestEndReason,
  type TestStep,
  testRecord,
  testStart,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { TestBoxRequest, TestBoxRunning, TestBoxTarget } from "../box/test-box";
import { TEST_DEV_START_MINUTES_DEFAULT, TestBoxes } from "../box/test-box";
import { BOX_WORKDIR } from "../box/code";
import { boxInstallInput } from "../box/lifetime";
import { appendEntries, type NewEntry } from "../changelog/log";
import { CommandError } from "../commands/errors";
import type { AsyncCommandContext, CommandOutcome, FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";
import type { Logger } from "../log/logger";
import { decideTestedMergeGates } from "../merge/gates";
import { currentProfile, type StoredProfile } from "../scan/store";
import { findStoryPr } from "../story-pr/records";
import { storyView } from "../views/story";
import { withWorkViews } from "../views/work";
import { DISCARD_RELEASE_REASON, DROP_RELEASE_REASON } from "../worktree/release";
import { DONE_RELEASE_REASON } from "../worktree/teardown";
import { findClaim, liveClaimOf } from "../worktree/records";

import { holdTestNote } from "./fix-rounds";
import { heldByPark } from "./park-state";
import { findRun, IN_REVIEW_END, REVIEWED_END, type StoredRun } from "./records";
import type { RunStoryFacts } from "./resume";
import {
  endTest,
  findTest,
  insertTest,
  markTestReady,
  moveTestForward,
  openTestOf,
  openTests,
  recordTestResult,
  shellLine,
  type StoredTest,
} from "./test-records";

type StartArgs = z.output<typeof testStart.args>;
type StartResult = z.input<typeof testStart.result>;
type RecordArgs = z.output<typeof testRecord.args>;
type RecordResult = z.input<typeof testRecord.result>;

/** The folder of dipo's state folder that holds each open test box's record, by test id. */
export const TEST_BOX_DIR = "test-boxes";

/** The daemon's recovery step that takes open tests up again (`StoryTests.recover`). */
export const TEST_RECOVERY_STEP = "tests-recover";

/** The phases a story In Review may be tested in (0002). */
export const TESTABLE_PHASES: readonly string[] = ["review", "test", "merge"];

/** The test box steps a `TestBoxes` gives; a seam for the tests. */
export type TestBoxPort = Pick<TestBoxes, "start" | "close" | "reattach" | "sweep" | "holds">;

export interface StoryTestsDeps {
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
    loadedOffices(): readonly OfficeId[];
  };
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly git: (office: OfficeId) => OfficeGit | undefined;
  /** The run profile's fingerprint check before a test (`RunProfiles.ensureFreshProfile`). */
  readonly freshProfile: (office: OfficeId, trigger: "test") => Promise<unknown>;
  /** The story's facts on the base: its manual test-plan entries. */
  readonly story: (office: OfficeId, run: StoredRun) => Promise<RunStoryFacts>;
  /** The test boxes; null when this daemon runs no boxes. */
  readonly boxes: TestBoxPort | null;
  /** The folder of a test box's record, by test id. */
  readonly testDir: (testId: string) => string;
  /**
   * Sends a failed test's note to the same builder (`FixRounds.testFail`): a round now, or held for
   * the run's next session and round; null when the run is unknown.
   */
  readonly testFail?: (
    office: OfficeId,
    runId: RunId,
    test: { readonly testId: string; readonly head: string; readonly note: string },
  ) => Promise<"queued" | "held" | null>;
  /** Lets the auto-merge act on a decided merge gate at once (`AutoMerge.kick`). */
  readonly kick?: (office: OfficeId) => void;
  /** Rewrites the story PR's body (`StoryPrs.sync`): its status block shows the test. */
  readonly prSync?: (office: OfficeId, runId: RunId) => Promise<void>;
  /** A write outside a command appended entries; subscribers catch up. */
  readonly onChanged?: (office: OfficeId) => void;
  readonly logger?: Pick<Logger, "warn" | "info">;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notInReview(story: string, why: string): CommandError {
  return new CommandError(
    "test.notInReview",
    `${story} cannot be tested: ${why}. A story is tested In Review, in phase review, test or merge.`,
    { story },
  );
}

/** The phase the run's last phase step names, or null. */
function phaseOf(office: OfficeHandle, runId: string): string | null {
  return (
    office.get<{ value: string }>(
      `select value from run_steps where office_id = $office_id and run_id = $run
        and kind = 'phase' order by step desc limit 1`,
      { run: runId },
    )?.value ?? null
  );
}

/**
 * The story's run and pushed head when it may be tested now (In Review, phase review, test or
 * merge, claim live, not parked, a pushed head); otherwise why not.
 */
export function testableRun(
  office: OfficeHandle,
  key: StoryKey | string,
): { readonly run: StoredRun; readonly head: string } | { readonly why: string } {
  const view = storyView(office, key as StoryKey);
  if (view?.lifecycle !== "In Review") return { why: `it is ${view?.lifecycle ?? "unknown"}` };
  const claim = liveClaimOf(office, key as StoryKey);
  const run = claim === null ? null : findRun(office, claim.runId);
  if (run === null || run.kind !== "story") return { why: "it has no live claim" };
  if (run.endedAt === null || (run.endKind !== IN_REVIEW_END && run.endKind !== REVIEWED_END)) {
    return { why: "its run is working" };
  }
  if (heldByPark(office, key)) return { why: "it is parked" };
  const phase = phaseOf(office, run.runId);
  if (phase === null || !TESTABLE_PHASES.includes(phase)) {
    return { why: `its run is in phase ${phase ?? "none"}` };
  }
  const head = findStoryPr(office, run.runId)?.headSha ?? "";
  if (head === "") return { why: "it has no pushed head" };
  return { run, head };
}

/** The manual steps of the story's test plan, in order. */
export function manualSteps(facts: RunStoryFacts): TestStep[] {
  return (facts.fields.test_plan?.entries ?? [])
    .filter((entry) => entry.kind === "manual")
    .map((entry) => ({
      check: entry.check,
      ...(entry.expect === undefined ? {} : { expect: entry.expect }),
    }));
}

/** The command lists of a resolved capability, with its folder in the box; null otherwise. */
function resolved(
  profile: StoredProfile,
  name: "setup" | "dev",
): { readonly commands: readonly (readonly string[])[]; readonly cwd: string } | null {
  const capability = profile.profile.capabilities[name];
  if (capability.status !== "resolved" || capability.value.commands.length === 0) return null;
  return capability.value;
}

/** The box folder of a repo-relative `cwd`. */
function boxDir(cwd: string): string {
  return cwd === "." || cwd === "" ? BOX_WORKDIR : `${BOX_WORKDIR}/${cwd.replace(/^\.\//, "")}`;
}

/** The test box's install, setup and `dev` from the run profile and the office config. */
export function testBoxScripts(input: {
  readonly profile: StoredProfile;
  readonly config: OfficeConfig;
  readonly story: string;
}): Pick<TestBoxRequest, "install" | "setup" | "dev"> {
  const { profile, config } = input;
  const install = boxInstallInput({
    profile: profile.profile,
    config,
    story: input.story,
    slot: null,
  });
  if (install !== null && "refused" in install) {
    throw new CommandError("test.refused", `${input.story} cannot be tested: ${install.refused}.`, {
      capability: "install",
    });
  }
  const env = install?.env ?? {};
  const minutes = (name: string, fallback: number) =>
    (config.timeouts.scriptMinutes[name] ?? fallback) * 60_000;
  const setup = resolved(profile, "setup");
  const dev = profile.nothingToStart ? null : resolved(profile, "dev");
  const devCommand = dev?.commands[0];
  return {
    install,
    setup: setup === null ? null : { ...setup, env, timeoutMs: minutes("setup", 10) },
    dev:
      dev === null || devCommand === undefined || devCommand.length === 0
        ? null
        : {
            command: devCommand as [string, ...string[]],
            cwd: boxDir(dev.cwd),
            env,
            startTimeoutMs: minutes("dev", TEST_DEV_START_MINUTES_DEFAULT),
          },
  };
}

/** Why the office's run profile refuses a test (0013): install or `dev` unresolved; else null. */
export function profileRefusal(
  profile: StoredProfile | null,
): { readonly capability: "install" | "dev" | "profile"; readonly message: string } | null {
  if (profile === null) {
    return {
      capability: "profile",
      message: "The office has no run profile yet. Run `dipo office rescan`.",
    };
  }
  if (profile.testRefusal === null) return null;
  const capability = profile.profile.capabilities.install.status !== "resolved" ? "install" : "dev";
  return { capability, message: profile.testRefusal };
}

/** The test end reason of a released claim. */
function endOfRelease(reason: string | null): TestEndReason {
  if (reason === DROP_RELEASE_REASON) return "dropped";
  if (reason === DISCARD_RELEASE_REASON) return "discarded";
  if (reason === DONE_RELEASE_REASON) return "merged";
  return "not-in-review";
}

/** The `test.start` result of a ready open test. */
function startResult(test: StoredTest, story: string): StartResult {
  return {
    test: test.testId,
    head: test.head,
    checkout: test.box,
    steps: [...test.steps],
    ...(test.url === null ? {} : { url: test.url }),
    shell: shellLine(story),
  };
}

export class StoryTests {
  readonly #deps: StoryTestsDeps;
  /** The starts in flight, by office and story key: a second waits for the first. */
  readonly #starting = new Map<string, Promise<unknown>>();
  /** The tests whose start runs in this daemon now. */
  readonly #startingTests = new Set<string>();

  constructor(deps: StoryTestsDeps) {
    this.#deps = deps;
  }

  /** `test.start` and `test.record` on the waiting command path. */
  get feature(): FeatureModule {
    return {
      name: "run/tests",
      register: (registry) => {
        registry.addAsyncOfficeCommand({
          definition: testStart,
          handle: (ctx, args) => this.start(ctx, args),
        });
        registry.addAsyncOfficeCommand({
          definition: testRecord,
          handle: (ctx, args) => this.record(ctx, args),
        });
      },
    };
  }

  async start(ctx: AsyncCommandContext, args: StartArgs): Promise<CommandOutcome<StartResult>> {
    const slot = `${ctx.office.officeId}:${args.story}`;
    const before = this.#starting.get(slot);
    if (before !== undefined) await before.catch(() => undefined);
    const started = this.#start(ctx, args);
    this.#starting.set(slot, started);
    try {
      return await started;
    } finally {
      if (this.#starting.get(slot) === started) this.#starting.delete(slot);
    }
  }

  async #start(ctx: AsyncCommandContext, args: StartArgs): Promise<CommandOutcome<StartResult>> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    const key = args.story as StoryKey;
    const story = ctx.stories.get(key)?.story ?? key;
    const testable = testableRun(office, key);
    if ("why" in testable) throw notInReview(story, testable.why);
    const { run, head } = testable;
    const open = openTestOf(office, key);
    if (open !== null && open.head === head && open.readyAt !== null) {
      return { result: startResult(open, story), changed: false };
    }
    if (open !== null)
      await this.#close(officeId, open, open.head === head ? "start-failed" : "new-head");
    const steps = manualSteps(await this.#deps.story(officeId, run));
    if (steps.length === 0) {
      throw new CommandError(
        "story.notTestable",
        `${story} has no manual test-plan entry, so there is nothing to test by hand.`,
        { story },
      );
    }
    const request = await this.#request(ctx, { run, head, story });
    const boxes = this.#deps.boxes;
    if (boxes === null) {
      throw new CommandError(
        "test.startFailed",
        "This daemon runs no boxes (Apple container is not on its PATH), so it cannot start a test box.",
        { story },
      );
    }
    ctx.commit(() => {
      mkdirSync(request.runDir, { recursive: true, mode: 0o700 });
      insertTest(office, {
        testId: request.testId,
        key,
        runId: run.runId,
        head,
        box: TestBoxes.boxOf(request.testId),
        steps,
        at: ctx.now,
      });
    });
    return this.#run(ctx, { boxes, request, key, story, run });
  }

  /** The fingerprint check, the refusal, and the box request of the test. */
  async #request(
    ctx: AsyncCommandContext,
    input: { readonly run: StoredRun; readonly head: string; readonly story: string },
  ): Promise<TestBoxRequest> {
    const officeId = ctx.office.officeId as OfficeId;
    try {
      await this.#deps.freshProfile(officeId, "test");
    } catch (error) {
      this.#deps.logger?.warn("the run profile check before a test failed", {
        office: officeId,
        reason: messageOf(error),
      });
    }
    const profile = currentProfile(ctx.office);
    const refusal = profileRefusal(profile);
    if (refusal !== null || profile === null) {
      throw new CommandError(
        "test.refused",
        `${input.story} cannot be tested: ${refusal?.message ?? "the office has no run profile"}`,
        { story: input.story, capability: refusal?.capability ?? "profile" },
      );
    }
    const config = this.#deps.offices.config(officeId);
    const git = this.#deps.git(officeId);
    if (config === undefined || git === undefined) {
      throw new CommandError(
        "test.startFailed",
        "The office has not loaded its configuration and git.",
      );
    }
    const testId = this.#deps.ids.next("tst");
    return {
      office: officeId,
      testId,
      runDir: this.#deps.testDir(testId),
      git,
      head: input.head,
      ...testBoxScripts({ profile, config, story: input.story }),
    };
  }

  /** The test box made and its product started; the test marked ready or closed. */
  async #run(
    ctx: AsyncCommandContext,
    input: {
      readonly boxes: TestBoxPort;
      readonly request: TestBoxRequest;
      readonly key: StoryKey;
      readonly story: string;
      readonly run: StoredRun;
    },
  ): Promise<CommandOutcome<StartResult>> {
    const { boxes, request } = input;
    const office = ctx.office;
    this.#startingTests.add(request.testId);
    let running: TestBoxRunning;
    try {
      running = await boxes.start(request);
    } catch (error) {
      ctx.commit(() => endTest(office, request.testId, "start-failed", this.#deps.clock.now()));
      removeDir(request.runDir);
      throw new CommandError("test.startFailed", `${input.story}: ${messageOf(error)}`, {
        story: input.story,
      });
    } finally {
      this.#startingTests.delete(request.testId);
    }
    let ready: NewEntry[] = [];
    ctx.commit(() => {
      ready = markTestReady(office, request.testId, {
        url: running.url,
        forwardPort: running.forward?.port ?? null,
        target: running.forward?.target ?? null,
        at: this.#deps.clock.now(),
      });
      return ready;
    });
    const test = findTest(office, request.testId);
    if (ready.length === 0 || test === null) {
      // Closed while it started (the sweep found a new head): its box goes too.
      await boxes.close(request.testId);
      removeDir(request.runDir);
      throw new CommandError("test.closed", `${input.story}'s test closed while it started.`, {
        story: input.story,
      });
    }
    return { result: startResult(test, input.story) };
  }

  async record(ctx: AsyncCommandContext, args: RecordArgs): Promise<CommandOutcome<RecordResult>> {
    const office = ctx.office;
    const officeId = office.officeId as OfficeId;
    const test = findTest(office, args.test);
    if (test === null || test.endedAt !== null || test.readyAt === null) {
      throw new CommandError(
        "test.closed",
        `The test ${args.test} is not open${test?.result == null ? "" : `: it was recorded as a ${test.result}`}.`,
        { test: args.test },
      );
    }
    const current = findStoryPr(office, test.runId)?.headSha ?? "";
    if (current !== test.head) {
      await this.#close(officeId, test, "new-head");
      throw new CommandError(
        "test.closed",
        `The test ${test.testId} tested ${test.head.slice(0, 12)}, an older head than the story's ${current.slice(0, 12) || "current one"}; start a new test.`,
        { test: test.testId },
      );
    }
    const note = args.note?.trim() ?? "";
    ctx.commit(() => {
      const recorded = recordTestResult(office, this.#deps.ids, test.testId, {
        result: args.result,
        note: note === "" ? null : note,
        at: ctx.now,
      });
      if (recorded.length === 0) {
        throw new CommandError("test.closed", `The test ${test.testId} closed meanwhile.`, {
          test: test.testId,
        });
      }
      // A fail's note is held on the run in the same transaction, so it is never lost (0002).
      if (args.result === "fail") {
        holdTestNote(office, test.runId, { testId: test.testId, head: test.head, note }, ctx.now);
      }
      const decided =
        args.result === "pass"
          ? decideTestedMergeGates(office, test.key, test.head, {
              testId: test.testId,
              at: ctx.now,
            })
          : [];
      return withWorkViews(office, [...recorded, ...decided]);
    });
    await this.#teardown(test);
    if (args.result === "fail") {
      await this.#deps
        .testFail?.(officeId, test.runId, { testId: test.testId, head: test.head, note })
        .catch((error: unknown) =>
          this.#deps.logger?.warn("the fix round of a failed test did not start", {
            test: test.testId,
            reason: messageOf(error),
          }),
        );
    } else {
      this.#deps.kick?.(officeId);
    }
    await this.#deps.prSync?.(officeId, test.runId).catch(() => undefined);
    return { result: { test: test.testId, result: args.result } };
  }

  /** Closes the open test `test` with `reason`, then deletes its box. */
  async #close(officeId: OfficeId, test: StoredTest, reason: TestEndReason): Promise<void> {
    const office = this.#deps.offices.get(officeId);
    if (office === undefined) return;
    this.#write(office, () => endTest(office, test.testId, reason, this.#deps.clock.now()));
    this.#deps.logger?.info("a test closed", { test: test.testId, reason });
    await this.#teardown(test);
  }

  async #teardown(test: StoredTest): Promise<void> {
    await this.#deps.boxes?.close(test.testId).catch(() => undefined);
    removeDir(this.#deps.testDir(test.testId));
  }

  #write(office: OfficeHandle, fn: () => readonly NewEntry[]): void {
    const at = this.#deps.clock.now();
    const appended = office.immediate(() => {
      const entries = withWorkViews(office, fn());
      appendEntries(office, entries, { at });
      return entries.length;
    });
    if (appended > 0) this.#deps.onChanged?.(office.officeId as OfficeId);
  }

  /** Why the open test `test` closes now, or null while it stays open (see the file comment). */
  #closing(office: OfficeHandle, officeId: OfficeId, test: StoredTest): TestEndReason | null {
    if (test.readyAt === null) {
      return this.#startingTests.has(test.testId) ? null : "start-failed";
    }
    const claim = findClaim(office, test.runId);
    if (claim === null || claim.releasedAt !== null)
      return endOfRelease(claim?.releaseReason ?? null);
    const testable = testableRun(office, test.key);
    if ("why" in testable) return "not-in-review";
    if (testable.run.runId !== test.runId || testable.head !== test.head) return "new-head";
    const idle = this.#deps.offices.config(officeId)?.timeouts.testIdleMinutes ?? 240;
    if (this.#deps.clock.now() - test.startedAt >= idle * 60_000) return "idle";
    return null;
  }

  /** Closes every open test that should close now (see the file comment). Never rejects. */
  async sweep(): Promise<void> {
    for (const officeId of this.#deps.offices.loadedOffices()) {
      const office = this.#deps.offices.get(officeId);
      if (office === undefined) continue;
      for (const test of openTests(office)) {
        try {
          const reason = this.#closing(office, officeId, test);
          if (reason !== null) await this.#close(officeId, test, reason);
        } catch (error) {
          this.#deps.logger?.warn("closing a test failed", {
            test: test.testId,
            reason: messageOf(error),
          });
        }
      }
    }
  }

  /** Daemon start: every open test taken up again or closed, then leftover test boxes deleted. */
  async recover(): Promise<void> {
    const boxes = this.#deps.boxes;
    const open = new Set<string>();
    for (const officeId of this.#deps.offices.loadedOffices()) {
      const office = this.#deps.offices.get(officeId);
      if (office === undefined) continue;
      for (const test of openTests(office)) {
        const kept =
          boxes !== null && test.readyAt !== null && (await this.#reattach(office, test, boxes));
        if (kept) open.add(test.testId);
        else await this.#close(officeId, test, test.readyAt === null ? "start-failed" : "box-lost");
      }
    }
    if (boxes !== null) {
      const deleted = await boxes.sweep(open);
      if (deleted.length > 0)
        this.#deps.logger?.info("deleted test boxes no open test names", { deleted });
    }
  }

  /** Takes the open test's box up again; false when it is gone. */
  async #reattach(office: OfficeHandle, test: StoredTest, boxes: TestBoxPort): Promise<boolean> {
    const target: TestBoxTarget | null = test.target;
    const again = await boxes.reattach({
      testId: test.testId,
      target,
      port: test.forwardPort,
      runDir: this.#deps.testDir(test.testId),
    });
    if (again === null) return false;
    if (again.port !== null && again.port !== test.forwardPort && test.url !== null) {
      const url = movedUrl(test.url, again.port);
      this.#write(office, () =>
        moveTestForward(office, test.testId, { port: again.port as number, url }),
      );
    }
    return true;
  }
}

/** The test URL with its port moved to `port`. */
function movedUrl(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return `http://localhost:${port}/`;
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover record folder holds no secret; the next start of the test id never comes.
  }
}
