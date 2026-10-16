// Shared setup for the worktree setup tests (DIPO-39): a claim setup with a fake step runner in
// place of the sandbox, a slot table, a run profile, and the fixture product with an ignored `.env`.
// Used by setup.test.ts and its CI-only sibling setup-claim.ci.test.ts.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TempRepo, TempRepoWithRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config/schema";
import type { DiskProbe } from "../../src/platform/disk";
import type { StepRequest, StepResult } from "../../src/sandbox/step";
import type { CommandSpec, Resolution, RunProfile } from "../../src/scan/detect";
import {
  type ClaimOutcome,
  type ClaimRecord,
  type ClaimSkip,
  claimStory,
  releaseClaim,
  type SetupDone,
  type SetupOutcome,
  type SetupRequest,
  setupWorktree,
  SlotTable,
} from "../../src/worktree";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { BACKLOG_FIXTURE, claimSetup, type ClaimSetup, publish, ROOMY } from "./helpers";

export const SECRET = "DEV-SECRET-77b2e0";
export const FIXTURE = { fixture: BACKLOG_FIXTURE };
export const ONE_GB: DiskProbe = { freeBytes: () => Promise.resolve(1_000_000_000) };

const resolved = (...commands: string[][]): Resolution<CommandSpec> => ({
  status: "resolved",
  value: { commands, cwd: "." },
  source: "standard",
  confidence: "high",
  evidence: "package.json",
});

function profile(): RunProfile {
  const none: Resolution<CommandSpec> = { status: "unresolved" };
  return {
    fingerprint: "f",
    toolchain: {
      packageManager: { status: "unresolved" },
      runtimeVersion: { status: "unresolved" },
      workspaces: [],
    },
    capabilities: {
      install: resolved(["bun", "install", "--frozen-lockfile"]),
      setup: resolved(["bun", "run", "setup"]),
      dev: none,
      test: none,
      lint: none,
      typecheck: none,
      verify: resolved(["bun", "run", "verify"]),
      build: none,
    },
    extraScripts: [],
    envFiles: [{ example: ".env.example", path: ".env", present: true, ignored: true }],
    devPorts: [
      {
        port: 5173,
        dir: ".",
        fixedInCode: false,
        honoursPort: true,
        source: "default",
        confidence: "low",
        evidence: "vite",
      },
    ],
    conformance: { level: "conforming", deviations: [] },
    runRefusal: null,
  };
}

export const exited = (code: number, stderr = ""): StepResult => ({
  outcome: "exited",
  code,
  signal: null,
  timedOut: false,
  stdout: { text: code === 0 ? "" : "seeding...\n", truncated: false },
  stderr: { text: stderr, truncated: false },
  warnings: [],
});

/** A step runner that records each request and answers per script (exit 0 by default). */
export function fakeSteps(answers: Record<string, StepResult> = {}, onStep?: () => Promise<void>) {
  const requests: StepRequest[] = [];
  const runStep = async (request: StepRequest): Promise<StepResult> => {
    requests.push(request);
    await onStep?.();
    return answers[request.script] ?? exited(0);
  };
  return { requests, runStep };
}

/** Publishes the fixture with `.env` ignored, then creates the ignored `.env`. */
export async function product(repo: TempRepoWithRemote): Promise<void> {
  writeFileSync(join(repo.dir, ".gitignore"), ".env\n");
  writeFileSync(join(repo.dir, "bun.lock"), "{}\n");
  await publish(repo);
  writeFileSync(join(repo.dir, ".env"), `TOKEN=${SECRET}\n`);
  chmodSync(join(repo.dir, ".env"), 0o600);
}

export interface Options {
  readonly disk?: DiskProbe;
  readonly steps?: ReturnType<typeof fakeSteps>;
  readonly profile?: RunProfile | null;
  readonly worktree?: Partial<SetupRequest["config"]["worktree"]>;
  /** Receives setup's warn lines. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

export interface Harness {
  readonly s: ClaimSetup;
  readonly slots: SlotTable;
  /** `setupWorktree` for `claim`. */
  setup(claim: ClaimRecord, options?: Options): Promise<SetupOutcome>;
  /** `claimStory` with `setup` as its setup. */
  claim(key: ReturnType<ClaimSetup["key"]>, options?: Options): Promise<ClaimOutcome<SetupDone>>;
}

export async function harness(repo: TempRepo): Promise<Harness> {
  const s = await claimSetup(repo);
  const slots = SlotTable.inState(join(repo.root, "state-dir"));
  const setup = (claim: ClaimRecord, options: Options = {}) =>
    setupWorktree(
      {
        ...s.deps({ disk: options.disk ?? ROOMY }),
        slots,
        runStep: (options.steps ?? fakeSteps()).runStep,
        localSettings: CLAUDE_LOCAL_SETTINGS,
        ...(options.warn === undefined ? {} : { warn: options.warn }),
      },
      {
        claim,
        config: {
          worktree: {
            ...OFFICE_DEFAULTS.worktree,
            files: [{ path: ".env", mode: "copy", required: true }],
            env: { VITE_HMR_PORT: "{port:24678}" },
            post_create: [
              ["bun", "run", "db:seed"],
              ["echo", "$HOME;", "rm -rf /"],
            ],
            ...options.worktree,
          },
          timeouts: OFFICE_DEFAULTS.timeouts,
          sandbox: OFFICE_DEFAULTS.sandbox,
        },
        profile: options.profile === undefined ? profile() : options.profile,
        host: { home: repo.home, uid: 501, env: { PATH: "/usr/bin:/bin", HOME: repo.home } },
      },
    );
  return {
    s,
    slots,
    setup,
    claim: (key, options = {}) =>
      claimStory<SetupDone>(s.deps(), {
        ...s.request(key),
        setup: (claim) => setup(claim, options),
      }),
  };
}

export function skipped(outcome: ClaimOutcome<SetupDone>): ClaimSkip {
  if (outcome.ok) throw new Error("expected the claim to be skipped");
  return outcome;
}

/** Releases the claim the way an amend would, keeping its branch for the story. */
export function releaseNow(h: Harness, claim: ClaimRecord): void {
  h.s.office.immediate(() =>
    releaseClaim(h.s.office, claim.runId, {
      at: h.s.t.clock.now(),
      reason: "amend",
      keepBranch: true,
    }),
  );
}
