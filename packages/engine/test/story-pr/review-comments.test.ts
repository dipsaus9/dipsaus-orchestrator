// The review comments, the review and merge lines, the done report section and the missed PR of
// DIPO-152, with a fake code host and a fake story git on a migrated state database.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type OfficeId,
  type ReviewFinding,
  RunId,
  type RunRecord,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS, type OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import type { OfficeLoadContext } from "../../src/office/steps";
import type { EnvSecret } from "../../src/run/env-secrets";
import { yieldToEventLoop } from "../../src/platform/clock";
import {
  type CodeHost,
  CodeHostError,
  type HostPr,
  type NewPr,
  type PrReviewHost,
} from "../../src/platform/host";
import {
  REVIEW_COMMENT_MAX,
  recordReviewOverride,
  recordReviewVerdict,
  redactComment,
  reviewComment,
  reviewVerdictOfGate,
  reviewVerdictsOf,
  type StoredReviewVerdict,
} from "../../src/review";
import { appendRunStep, insertRun, stopAtInReview } from "../../src/run";
import { doneReportOf, storedDoneReport } from "../../src/run/done-report";
import { storeRunSummary } from "../../src/run/verify-records";
import {
  findStoryPr,
  type StoryPrFacts,
  type StoryPrGit,
  StoryPrs,
  STORY_PR_NOTICES,
  storyPrBody,
} from "../../src/story-pr";
import { storyRuns } from "../../src/views/feature";
import type { WorkerReport } from "../../src/workers/types";
import { insertClaim, updateClaim } from "../../src/worktree/records";
import { loggedEvents } from "../ingest/helpers";
import { pass, task, withOffice } from "../stories/helpers";

const REPO = "o/r";
const BRANCH = "DIPO-1/open-the-pr";
const SECRET = "s3cr3t-token-value";

class FakeHost implements CodeHost, PrReviewHost {
  readonly creates: NewPr[] = [];
  readonly comments: string[] = [];
  readonly bodies: string[] = [];
  open: HostPr | null = null;
  failComment: CodeHostError | null = null;
  async checkVersion(): Promise<string> {
    return "2.50.0";
  }
  async findOpenPr(): Promise<HostPr | null> {
    return this.open;
  }
  async createPr(_repo: string, pr: NewPr): Promise<HostPr> {
    this.creates.push(pr);
    this.bodies.push(pr.body);
    this.open = {
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
      state: "open",
      head: pr.head,
      headSha: "",
      base: pr.base,
      title: pr.title,
      mergeCommit: null,
    };
    return this.open;
  }
  async updatePr(
    _repo: string,
    _number: number,
    change: { title: string; body: string },
  ): Promise<void> {
    this.bodies.push(change.body);
  }
  async viewPr(): Promise<HostPr> {
    return this.open as HostPr;
  }
  async closePr(): Promise<void> {}
  async requiredChecks(): Promise<[]> {
    return [];
  }
  async prLabels(): Promise<string[]> {
    return [];
  }
  async prChecks(): Promise<[]> {
    return [];
  }
  async failedJobLog(): Promise<null> {
    return null;
  }
  async commentPr(_repo: string, _number: number, body: string): Promise<string> {
    if (this.failComment !== null) throw this.failComment;
    this.comments.push(body);
    return `https://github.com/${REPO}/pull/7#issuecomment-${this.comments.length}`;
  }
}

const FACTS: StoryPrFacts = {
  story: {
    id: "DIPO-1",
    title: "Open the PR.",
    type: "feature",
    outcome: "a PR opens",
    criteria: [{ index: 1, text: "It opens", checked: true }],
    testPlan: undefined,
    scope: ["packages/engine/src/story-pr/"],
    taskFile: "backlog/tasks/dipo-1 - Open.md",
  },
  head: "a".repeat(40),
  remoteUrl: `git@github.com:${REPO}.git`,
  base: "main",
};

const FINDING_BLOCKING: ReviewFinding = {
  severity: "blocking",
  kind: "correctness",
  file: "packages/engine/src/x.ts",
  line: 42,
  quote: "const total = a - b;",
  text: "Off by one.",
};
const FINDING_UNVERIFIED: ReviewFinding = {
  severity: "advisory",
  kind: "maintainability",
  file: "packages/engine/src/y.ts",
  line: 7,
  quote: "const y = 1;",
  text: "Name it better.",
  unverified: true,
};

interface World {
  readonly host: FakeHost;
  readonly prs: StoryPrs;
  readonly run: RunId;
  readonly key: StoryKey;
  readonly office: OfficeHandle;
  config: OfficeConfig;
  secrets: () => EnvSecret[];
  round(
    n: number,
    verdict: "approved" | "blocked",
    over?: {
      criteria?: { n: number; status: "met" | "unmet" | "maintainer"; evidence: string }[];
      findings?: ReviewFinding[];
      summary?: string;
      carriedFrom?: string;
      commit?: string;
    },
  ): StoredReviewVerdict;
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

async function inWorld(
  fn: (w: World) => Promise<void>,
  setup: {
    ended?: "in-review" | "reviewed";
    config?: OfficeConfig;
    /** The checkout lookup, read with the default env-file reader instead of `world.secrets`. */
    checkout?: (office: OfficeId) => string | undefined;
  } = {},
): Promise<void> {
  await withOffice(async (t, office) => {
    pass(t, office, [task("DIPO-1", { status: "In Review" })]);
    const key = office.get<{ key: string }>("select key from stories where office_id = $office_id")
      ?.key as StoryKey;
    const run = RunId.parse(t.ids.next("run"));
    office.immediate(() => {
      insertRun(office, {
        runId: run,
        kind: "story",
        key,
        story: "DIPO-1",
        tier: "S",
        role: "developer",
        model: "haiku",
        startSha: "b".repeat(40),
        branch: BRANCH,
        budgetUnit: "tokens",
        budgetLimit: 300_000,
        loopCap: 2,
        reviewRoundCap: null,
        configHash: "h",
        overrideKeys: null,
        runProfileId: null,
        startedAt: t.clock.now(),
        scope: ["packages/engine/src/story-pr/"],
      });
      insertClaim(office, {
        runId: run,
        key,
        story: "DIPO-1",
        branch: BRANCH,
        base: "main",
        baseSha: "b".repeat(40),
        startSha: "b".repeat(40),
        claimSha: "c".repeat(40),
        reused: false,
        claimedAt: t.clock.now(),
      });
      t.clock.advance(60_000);
      updateClaim(office, run, { pushedAt: t.clock.now() });
      stopAtInReview(office, run, t.clock.now());
    });
    const host = new FakeHost();
    const world: World = {
      host,
      run,
      key,
      office,
      config: setup.config ?? OFFICE_DEFAULTS,
      secrets: () => [],
      now: () => t.clock.now(),
      advance: (ms) => t.clock.advance(ms),
      round: (n, verdict, over = {}) => {
        t.clock.advance(1_000);
        const stored = office.immediate(() =>
          recordReviewVerdict(office, t.ids, {
            runId: run,
            key,
            round: n,
            agent: null,
            model: "opus",
            commit: over.commit ?? "a1b2c3d4".repeat(5),
            codeTreeKey: `tree-${n}-${over.commit ?? ""}`,
            judged: {
              verdict,
              criteria: over.criteria ?? [{ n: 1, status: "met", evidence: "the PR opens" }],
              findings: over.findings ?? [],
              summary: over.summary ?? "Fine.",
              notes: [],
            },
            ...(over.carriedFrom === undefined ? {} : { carriedFrom: over.carriedFrom }),
            at: t.clock.now(),
          }),
        );
        return stored;
      },
      prs: new StoryPrs({
        host,
        review: host,
        git: { read: async () => FACTS } satisfies StoryPrGit,
        offices: { get: () => office, config: () => world.config },
        clock: t.clock,
        ...(setup.checkout === undefined
          ? { checkout: () => "/office", secrets: () => world.secrets() }
          : { checkout: setup.checkout }),
      }),
    };
    if (setup.ended === "reviewed") {
      world.round(1, "approved");
      t.clock.advance(60_000);
      office.immediate(() => {
        office.run(
          `update runs set ended_at = $at where office_id = $office_id and run_id = $run`,
          {
            at: t.clock.now(),
            run,
          },
        );
        appendRunStep(office, run, "phase", "merge", t.clock.now());
      });
    }
    try {
      await fn(world);
    } finally {
      world.prs.stop();
    }
  });
}

const notices = (office: OfficeHandle, code: string) =>
  loggedEvents(office).filter(
    (event) => event.type === "engine.notice" && (event.data as { code: string }).code === code,
  );

const verdictOf = (w: World, n: number): StoredReviewVerdict =>
  reviewVerdictsOf(w.office, w.key)[n] as StoredReviewVerdict;

const advisory = (i: number): ReviewFinding => ({
  severity: "advisory",
  kind: "other",
  text: `advisory ${i} ${"x".repeat(900)}`,
});

describe("the review comment", () => {
  it("renders a blocked round with an unverified finding in the section 3 format", async () => {
    await inWorld(async (w) => {
      const stored = w.round(2, "blocked", {
        criteria: [
          { n: 1, status: "met", evidence: "story.detail shows it" },
          { n: 2, status: "unmet", evidence: "no test for the cap" },
          { n: 3, status: "maintainer", evidence: "needs a live run" },
        ],
        findings: [FINDING_BLOCKING, FINDING_UNVERIFIED],
        summary: "One criterion is unmet.",
      });
      const text = reviewComment(
        { ...stored, decidedAt: Date.UTC(2026, 9, 16, 14, 5) },
        { effort: "high" },
      );
      expect(text).toBe(
        [
          "### dipo review, round 2 of the story: blocked",
          "",
          "Commit `a1b2c3d` · reviewer opus (effort high) · 2026-10-16 14:05 UTC",
          "",
          "**Criteria**",
          "- #1 met: story.detail shows it",
          "- #2 unmet: no test for the cap",
          "- #3 maintainer: needs a live run",
          "",
          "**Findings**",
          "- blocking · correctness · `packages/engine/src/x.ts:42`",
          "  > `const total = a - b;`",
          "  Off by one.",
          "- advisory (unverified) · maintainability · `packages/engine/src/y.ts:7`",
          "  > `const y = 1;`",
          "  Name it better.",
          "",
          "**Summary:** One criterion is unmet.",
        ].join("\n"),
      );
    });
  });

  it("cuts advisory findings first over 60,000 characters, with a marker", async () => {
    await inWorld(async (w) => {
      const stored = w.round(1, "blocked", {
        findings: [FINDING_BLOCKING, ...Array.from({ length: 100 }, (_, i) => advisory(i))],
      });
      const text = reviewComment(stored, { effort: null });
      expect(text.length).toBeLessThanOrEqual(REVIEW_COMMENT_MAX);
      expect(text).toContain("Off by one.");
      expect(text).toContain("advisory 0 ");
      expect(text).not.toContain("advisory 99 ");
      expect(text).toMatch(
        /- … \d+ advisory findings cut to keep the comment under 60000 characters/,
      );
      // Never any run id, session or cost.
      expect(text).not.toContain(w.run);
    });
  });
});

describe("posting the review comment", () => {
  it("replaces every copied env value by [redacted] while the stored verdict keeps the text", async () => {
    await inWorld(async (w) => {
      w.secrets = () => [{ file: ".env", key: "TOKEN", value: SECRET }];
      const leaky = w.round(1, "blocked", {
        criteria: [{ n: 1, status: "unmet", evidence: `the file says ${SECRET} here` }],
        findings: [{ ...FINDING_BLOCKING, quote: `const t = "${SECRET}";` }],
        summary: `Do not commit ${SECRET}.`,
      });
      await w.prs.sync(w.office.officeId, w.run);
      await w.prs.retry(w.office.officeId);
      expect(w.host.comments).toHaveLength(1);
      const posted = w.host.comments[0] as string;
      expect(posted).not.toContain(SECRET);
      expect(posted.match(/\[redacted\]/g)?.length).toBe(3);
      const stored = reviewVerdictOfGate(w.office, leaky.gate) as StoredReviewVerdict;
      expect(stored.summary).toBe(`Do not commit ${SECRET}.`);
      expect(stored.criteria[0]?.evidence).toContain(SECRET);
      expect(stored.findings[0]?.quote).toContain(SECRET);
      expect(redactComment(`a ${SECRET} b`, [{ file: "f", key: "K", value: SECRET }])).toBe(
        "a [redacted] b",
      );
    });
  });

  it("holds the comment back with pr.commentFailed when a copied env file is unreadable, then posts", async () => {
    await inWorld(async (w) => {
      let broken = true;
      w.secrets = () => {
        if (broken) throw new Error("EACCES: .env");
        return [];
      };
      w.round(1, "approved");
      await w.prs.sync(w.office.officeId, w.run);
      await w.prs.retry(w.office.officeId);
      await w.prs.retry(w.office.officeId);
      expect(w.host.comments).toHaveLength(0);
      // Once per cause.
      expect(notices(w.office, STORY_PR_NOTICES.commentFailed)).toHaveLength(1);
      broken = false;
      await w.prs.retry(w.office.officeId);
      expect(w.host.comments).toHaveLength(1);
    });
  });

  it("posts once per round, stores the URL, never edits, and posts nothing for a carried approval", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      const first = w.round(1, "blocked", { findings: [FINDING_BLOCKING] });
      await w.prs.sync(id, w.run);
      await w.prs.retry(id);
      await w.prs.retry(id);
      expect(w.host.comments).toHaveLength(1);
      expect(verdictOf(w, 0).commentUrl).toBe(`https://github.com/${REPO}/pull/7#issuecomment-1`);
      const second = w.round(2, "approved", { commit: "d".repeat(40) });
      w.round(3, "approved", { commit: "e".repeat(40), carriedFrom: "d".repeat(40) });
      await w.prs.retry(id);
      expect(w.host.comments).toHaveLength(2);
      expect(w.host.comments[1]).toContain("round 2 of the story: approved");
      expect(reviewVerdictOfGate(w.office, second.gate)?.commentUrl).toContain("issuecomment-2");
      expect(reviewVerdictOfGate(w.office, first.gate)?.commentUrl).toContain("issuecomment-1");
      expect(verdictOf(w, 2).commentUrl).toBeNull();
      await w.prs.retry(id);
      expect(w.host.comments).toHaveLength(2);
    });
  });

  it("raises pr.commentFailed for a failed post, retries it at the next poll and keeps the poll going", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      w.round(1, "approved");
      w.host.failComment = new CodeHostError("failed", "gh: network is down");
      await w.prs.retry(id);
      await w.prs.retry(id);
      expect(notices(w.office, STORY_PR_NOTICES.commentFailed)).toHaveLength(1);
      expect(verdictOf(w, 0).commentUrl).toBeNull();
      // The body still carries the stored verdict: the failed comment held nothing back.
      expect(w.host.bodies.at(-1)).toContain("- review: round 1 approved at `a1b2c3d4`");
      w.host.failComment = null;
      await w.prs.retry(id);
      expect(w.host.comments).toHaveLength(1);
      expect(verdictOf(w, 0).commentUrl).not.toBeNull();
    });
  });

  it("rewrites the body's review line after each round and for an override", async () => {
    await inWorld(async (w) => {
      const id = w.office.officeId;
      await w.prs.sync(id, w.run);
      expect(w.host.bodies.at(-1)).toContain("- review: pending");
      const blocked = w.round(1, "blocked", { findings: [FINDING_BLOCKING, FINDING_UNVERIFIED] });
      await w.prs.retry(id);
      expect(w.host.bodies.at(-1)).toContain(
        "- review: round 1 blocked at `a1b2c3d4` (1 blocking, 1 advisory)",
      );
      w.office.immediate(() =>
        recordReviewOverride(w.office, blocked.gate, { note: "ok", at: w.now() }),
      );
      await w.prs.retry(id);
      expect(w.host.bodies.at(-1)).toContain("approved by the maintainer's override");
      w.round(2, "approved", { commit: "d".repeat(40) });
      await w.prs.retry(id);
      expect(w.host.bodies.at(-1)).toContain("- review: round 2 approved at `dddddddd`");
    });
  });
});

describe("the review comment with the daemon's checkout wiring (DIPO-371)", () => {
  // The office copies `.env`; the env files are read from the main checkout the office's git
  // recorded at its load, as the daemon passes it to StoryPrs.
  const copying: OfficeConfig = {
    ...OFFICE_DEFAULTS,
    worktree: {
      ...OFFICE_DEFAULTS.worktree,
      files: [{ path: "config/.env", mode: "copy", required: false }],
    },
  };
  const daemonWiring = (checkout: string) => {
    const engineGit = new EngineGit({
      exec: async () => ({ code: 0, stdout: "git version 2.50.0\n", stderr: "" }),
      env: {},
    });
    return {
      checkout: (office: OfficeId) => engineGit.forOffice(office)?.mainWorktree,
      load: async (w: World) => {
        const refused = await engineGit.attach({
          officeId: w.office.officeId,
          office: w.office,
          path: checkout,
          commonDir: join(checkout, ".git"),
          config: copying,
          clock: new ManualClock(),
        } as unknown as OfficeLoadContext);
        expect(refused).toBeNull();
      },
    };
  };

  it("posts the comment with the main checkout's env values redacted once the office's git knows it", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "config"));
      writeFileSync(join(dir, "config/.env"), `TOKEN=${SECRET}\n`);
      const wiring = daemonWiring(dir);
      await inWorld(
        async (w) => {
          const id = w.office.officeId;
          w.round(1, "blocked", { summary: `Do not commit ${SECRET}.` });
          await w.prs.sync(id, w.run);
          await w.prs.retry(id);
          // Before the office's git has loaded, the checkout is not known: held back.
          expect(w.host.comments).toHaveLength(0);
          const unknown = notices(w.office, STORY_PR_NOTICES.commentFailed);
          expect(unknown).toHaveLength(1);
          expect((unknown[0]?.data as { text: string } | undefined)?.text).toContain(
            "main checkout is not known",
          );
          await wiring.load(w);
          await w.prs.retry(id);
          expect(w.host.comments).toHaveLength(1);
          const posted = w.host.comments[0] as string;
          expect(posted).not.toContain(SECRET);
          expect(posted).toContain("Do not commit [redacted].");
          expect(verdictOf(w, 0).commentUrl).not.toBeNull();
        },
        { config: copying, checkout: wiring.checkout },
      );
    });
  });

  it("still holds the comment back when the checkout's env file cannot be read", async () => {
    await withTempDir(async (dir) => {
      // `config` is a file, so `config/.env` fails with ENOTDIR (not an absent file), as root too.
      writeFileSync(join(dir, "config"), "not a directory\n");
      const wiring = daemonWiring(dir);
      await inWorld(
        async (w) => {
          const id = w.office.officeId;
          await wiring.load(w);
          w.round(1, "blocked", { summary: `Do not commit ${SECRET}.` });
          await w.prs.sync(id, w.run);
          await w.prs.retry(id);
          expect(w.host.comments).toHaveLength(0);
          const failed = notices(w.office, STORY_PR_NOTICES.commentFailed);
          expect(failed).toHaveLength(1);
          expect((failed[0]?.data as { text: string } | undefined)?.text).toContain("ENOTDIR");
        },
        { config: copying, checkout: wiring.checkout },
      );
    });
  });
});

describe("a story In Review without a story PR", () => {
  it("gets its PR at the next poll, also when its run is past its review", async () => {
    await inWorld(
      async (w) => {
        const id = w.office.officeId;
        expect(findStoryPr(w.office, w.run)).toBeNull();
        expect(await w.prs.retry(id)).toEqual([w.run]);
        expect(findStoryPr(w.office, w.run)).toMatchObject({ number: 7, state: "open" });
        // The stored verdict is in the status block of the PR it opened.
        expect(w.host.creates[0]?.body).toContain("- review: round 1 approved at `a1b2c3d4`");
        await yieldToEventLoop();
      },
      { ended: "reviewed" },
    );
  });
});

describe("the done report", () => {
  const report: WorkerReport = {
    status: "done",
    criteria: [],
    summary: "s",
    commitSubject: "c",
    notes: "Deviated: kept the old key.\u001b[31m\nSecond line.",
    proposals: [
      { kind: "follow-up", title: "T".repeat(300), outcome: "o", why: "w", paths: ["a/b.ts"] },
    ],
  };

  it("is cleaned and capped, and empty when it holds neither notes nor proposals", () => {
    const done = doneReportOf({
      ...report,
      notes: `a\u001b[31mb${"n".repeat(9_000)}`,
      proposals: [...Array(5)].map(() => ({
        kind: "tool",
        title: "t",
        outcome: "o",
        why: "w",
      })),
    });
    expect(done?.notes?.startsWith("ab")).toBe(true);
    expect(done?.notes).toHaveLength(8_000);
    expect(done?.proposals).toHaveLength(3);
    expect(doneReportOf({ status: "done" } as WorkerReport)).toBeNull();
    expect(doneReportOf(null)).toBeNull();
  });

  it("is stored with the run and shown by the story runs, dipo watch and the TUI", async () => {
    await inWorld(async (w) => {
      w.office.immediate(() =>
        storeRunSummary(w.office, w.run, { report, diffstat: "", at: w.now() }),
      );
      const stored = storedDoneReport(w.office, w.run);
      expect(stored?.notes).toBe("Deviated: kept the old key.\nSecond line.");
      expect(stored?.proposals?.[0]?.title).toHaveLength(120);
      const record = storyRuns(w.office, w.key).at(-1) as RunRecord;
      expect(record.doneReport).toEqual(stored as NonNullable<typeof stored>);
    });
  });

  it("gets a section in the PR body, built by code and marked as the worker's words", async () => {
    await inWorld(async (w) => {
      w.office.immediate(() =>
        storeRunSummary(w.office, w.run, { report, diffstat: "", at: w.now() }),
      );
      await w.prs.sync(w.office.officeId, w.run);
      const body = w.host.creates[0]?.body as string;
      expect(body).toContain("## Worker's report\n\nThe worker's own words, not checked by dipo.");
      expect(body).toContain("> Deviated: kept the old key.\n> Second line.");
      expect(body).toContain("- follow-up: ");
      expect(body.indexOf("## Worker's report")).toBeLessThan(body.indexOf("## Status"));
    });
  });

  it("is cut at its cap with a marker and leaves the body under its cap", () => {
    const body = storyPrBody(
      { ...FACTS.story, doneReport: { notes: "n".repeat(30_000) } },
      { head: "a".repeat(40) },
    );
    expect(body.length).toBeLessThan(20_000);
    expect(body).toContain("[dipo: cut to keep the body under 20000 characters]");
  });
});

describe("the status block", () => {
  const status = { head: "a".repeat(40) };
  it("says the maintainer merges until the merge slot merges", () => {
    expect(storyPrBody(FACTS.story, status)).toContain(
      "- merge: the maintainer merges; dipo does not merge story PRs yet",
    );
    expect(storyPrBody(FACTS.story, { ...status, merge: "dipo" })).toContain(
      "- merge: dipo merges after review and green required checks",
    );
  });

  it("shows the stored verdict and round on the review line", () => {
    const review = {
      round: 2,
      verdict: "blocked",
      commit: "f".repeat(40),
      blocking: 1,
      advisory: 3,
      overridden: false,
    } as const;
    expect(storyPrBody(FACTS.story, { ...status, review })).toContain(
      "- review: round 2 blocked at `ffffffff` (1 blocking, 3 advisory)",
    );
    expect(
      storyPrBody(FACTS.story, { ...status, review: { ...review, verdict: "approved" } }),
    ).toContain("- review: round 2 approved at `ffffffff`");
    expect(storyPrBody(FACTS.story, status)).toContain("- review: pending");
  });
});
