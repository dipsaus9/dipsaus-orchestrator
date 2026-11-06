// The audit of incoming ideas (0022, DIPO-452): code first, then one short audit session per batch,
// so only an idea that is needed reaches the maintainer.
//
// - When. A run's ideas are audited together once that run is merged or parked (`dueIdeas`: its
//   run has ended), so the audit sees the finished change and never competes with the worker; an
//   idea without a run, or of a planning session, is audited when it arrives. Each change of an
//   office (`poke`) looks for such ideas never audited, and the daemon's start (`retryAll`) takes
//   every held idea whose run ended, the ones an earlier audit missed and the proposals the
//   upgrade held included. One audit runs per office at a time; a trigger during it runs again
//   after it. An idea is never audited while its run runs.
// - Code first (`codeRejections`): an idea equal to one already held, or whose title is that of an
//   open or Done story, is rejected with that reason and no model call. A batch code rejects whole
//   starts no session.
// - Then one audit session for the rest (`AuditSessionRunner`; the real one is `audit-session.ts`):
//   its own session kind with the planning session's tools, in a read-only box of its own, the
//   office's `audit.model`. It holds no run slot and is not the office's planning session. Its
//   first message quotes each idea's title and text as data, inside an `<idea>` tag.
// - Its answer must match the contract's `AuditAnswer` and, for a pass, a Story line in the 0012
//   shape (R05). A pass keeps the proposed user story, with the source story code knows; a reject
//   keeps its reason. An idea whose audit failed, was cut off, or whose answer or verdict was
//   refused by schema stays held, one attempt more, and is audited again at the next trigger: no
//   idea is ever dropped.
// - `office.ideas` lists the held, passed and rejected ideas with their reasons.

import {
  AuditAnswer,
  type AuditVerdict,
  type IdeaState,
  type OfficeId,
  officeIdeas,
  type ProposedStory,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { REVIEW_CODE_DIR } from "../box/review-box";
import type { FeatureModule } from "../commands/registry";
import type { OfficeConfig } from "../config";
import type { OfficeHandle } from "../db/office";
import { checkStoryLine } from "../gate/rules";
import { renderSystemFile } from "../prompts/system";
import { rendered, renderTemplate, TASK_TEMPLATES } from "../prompts/templates";
import {
  auditMissed,
  codeRejections,
  dueIdeas,
  type HeldIdea,
  holdIdea,
  ideaViews,
  passIdea,
  rejectIdea,
} from "../records/ideas";

/** The characters of an idea's id its `<idea>` tag gives the session. */
export const AUDIT_ID_CHARS = 12;
/** The most ideas one audit session takes; the rest wait for the next batch. */
export const AUDIT_BATCH_MAX = 20;

/** What one audit session is started with. */
export interface AuditSessionRequest {
  readonly office: OfficeId;
  readonly handle: OfficeHandle;
  readonly settings: OfficeConfig["audit"];
  readonly ideas: readonly HeldIdea[];
  /** The L1+L2 system file text. */
  readonly systemFile: string;
  /** The first message, for the base branch's commit the session's copy holds. */
  readonly taskMessage: (commit: string) => string;
}

/** How one audit session ended. */
export type AuditSessionResult =
  | { readonly kind: "answered"; readonly runId: string; readonly answer: unknown }
  | { readonly kind: "failed"; readonly runId: string | null; readonly reason: string };

/** Starts and follows one audit session to its end (the worker adapter behind it). */
export interface AuditSessionRunner {
  run(request: AuditSessionRequest): Promise<AuditSessionResult>;
}

export interface IdeaAuditsDeps {
  readonly clock: { now(): number };
  readonly offices: {
    get(office: OfficeId): OfficeHandle | undefined;
    config(office: OfficeId): OfficeConfig | undefined;
  };
  /** The audit session runner; without one, held ideas wait. */
  readonly runner: () => AuditSessionRunner | undefined;
  /** True while audits may start (the daemon runs); a trigger before that waits for `retryAll`. */
  readonly active?: () => boolean;
  readonly onChanged?: (office: OfficeId) => void;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The id an idea's tag gives the session: its first `AUDIT_ID_CHARS` characters. */
export const auditRef = (idea: Pick<HeldIdea, "id">) => idea.id.slice(0, AUDIT_ID_CHARS);

/** Pure: the audit session's system file (L1 audit contract, L2 auditor role). */
export function auditSystemFile(): string {
  return renderSystemFile("audit-box", "auditor");
}

/**
 * Pure: the audit session's first message. Each idea is quoted as data in its own `<idea>` tag,
 * with its id, origin and source story: its title and text are slot values, so no tag in them can
 * close the idea or the list.
 */
export function auditTaskMessage(ideas: readonly HeldIdea[], commit: string): string {
  const items = ideas.map((idea) =>
    renderTemplate(TASK_TEMPLATES.auditIdea, {
      id: auditRef(idea),
      origin: idea.origin,
      source: idea.story ?? (idea.key === null ? "none" : `key ${idea.key}`),
      title: idea.title,
      text: idea.text,
    }),
  );
  return renderTemplate(TASK_TEMPLATES.audit, {
    ideas: rendered(items.join("\n\n")),
    commit: rendered(commit),
    dir: rendered(REVIEW_CODE_DIR),
  });
}

/** What the engine made of a validated answer, per idea of the batch. */
export interface AuditDecisions {
  readonly passed: ReadonlyMap<string, ProposedStory>;
  readonly rejected: ReadonlyMap<string, string>;
  /** The ideas the answer did not decide, with why: left out, or a verdict refused. */
  readonly missed: ReadonlyMap<string, string>;
}

/** Pure: the proposed user story of a pass, or why the engine refuses it. */
function proposedStory(
  idea: HeldIdea,
  verdict: Extract<AuditVerdict, { verdict: "pass" }>,
): ProposedStory | string {
  const problems = checkStoryLine(verdict.storyLine, false);
  if (problems.length > 0) return `its Story line fails 0012 R05: ${problems.join("; ")}`;
  return {
    found: verdict.found,
    evidence: verdict.evidence,
    ...(idea.story === null ? {} : { sourceStory: idea.story }),
    storyLine: verdict.storyLine,
    proposed: verdict.proposed,
    why: verdict.why,
    serves: verdict.serves,
  };
}

/**
 * Pure: the audit session's answer, validated by the contract's `AuditAnswer`, as decisions on the
 * ideas of `batch`; a string when the answer as a whole is refused by schema. The first verdict
 * for an idea decides; a verdict for an idea not in the batch is ignored.
 */
export function decideAnswer(batch: readonly HeldIdea[], answer: unknown): AuditDecisions | string {
  const parsed = AuditAnswer.safeParse(answer);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return `the audit's answer was refused by its schema: ${problems.join("; ")}`;
  }
  const byRef = new Map(batch.map((idea) => [auditRef(idea), idea]));
  const passed = new Map<string, ProposedStory>();
  const rejected = new Map<string, string>();
  const missed = new Map<string, string>();
  const decided = new Set<string>();
  for (const verdict of parsed.data.ideas) {
    const idea = byRef.get(verdict.idea.trim().toLowerCase().slice(0, AUDIT_ID_CHARS));
    if (idea === undefined || decided.has(idea.id)) continue;
    decided.add(idea.id);
    if (verdict.verdict === "reject") {
      rejected.set(idea.id, verdict.reason);
      continue;
    }
    const story = proposedStory(idea, verdict);
    if (typeof story === "string") missed.set(idea.id, `the audit's pass was refused: ${story}`);
    else passed.set(idea.id, story);
  }
  for (const idea of batch) {
    if (!decided.has(idea.id)) missed.set(idea.id, "the audit's answer gave it no verdict");
  }
  return { passed, rejected, missed };
}

/** The audits of every office: see the file comment. */
export class IdeaAudits {
  readonly #deps: IdeaAuditsDeps;
  /** The offices whose audit runs now. */
  readonly #running = new Map<OfficeId, Promise<void>>();
  /** The offices triggered while their audit ran, and whether a retry was asked. */
  readonly #again = new Map<OfficeId, boolean>();

  constructor(deps: IdeaAuditsDeps) {
    this.#deps = deps;
  }

  /** `office.ideas`: the held, passed and rejected ideas of the office. */
  get feature(): FeatureModule {
    return {
      name: "run",
      register: (registry) => {
        registry.addRead({
          definition: officeIdeas,
          handle: (ctx, args) => {
            if (ctx.office === undefined) throw new Error("office.ideas runs with its office");
            return ideaViews(ctx.office, args.state as IdeaState | undefined);
          },
        });
      },
    };
  }

  /** A change of `office`: audits its ideas that are due and were never audited. */
  poke(office: OfficeId): void {
    if (this.#deps.active?.() === false) return;
    this.#trigger(office, false);
  }

  /** The daemon runs: every held idea whose run ended is audited, missed ones included. */
  retryAll(offices: readonly OfficeId[]): void {
    for (const office of offices) this.#trigger(office, true);
  }

  /**
   * Holds the maintainer's quick idea (its command is DIPO-454's), with the story it is about if
   * any, and audits it at once. Returns its id, or null when the same idea is held already.
   */
  holdQuick(
    office: OfficeId,
    idea: { readonly title: string; readonly text: string; readonly key?: StoryKey },
  ): string | null {
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) return null;
    const at = this.#deps.clock.now();
    const id = handle.immediate(() =>
      holdIdea(handle, {
        origin: "quick",
        key: idea.key ?? null,
        runId: null,
        title: idea.title,
        text: idea.text,
        at,
      }),
    );
    if (id !== null) this.poke(office);
    return id;
  }

  /** Resolves once no audit runs (tests and daemon stop). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values());
  }

  #trigger(office: OfficeId, retry: boolean): void {
    if (this.#running.has(office)) {
      this.#again.set(office, retry || (this.#again.get(office) ?? false));
      return;
    }
    const running = this.#loop(office, retry).finally(() => {
      this.#running.delete(office);
      // A trigger that came after the loop's last look runs now.
      const again = this.#again.get(office);
      if (again === undefined) return;
      this.#again.delete(office);
      this.#trigger(office, again);
    });
    this.#running.set(office, running);
  }

  async #loop(office: OfficeId, retry: boolean): Promise<void> {
    // After the caller's call stack: a change may be told from inside another write.
    await Promise.resolve();
    let force = retry;
    // An idea is taken once per loop: each round decides its batch or counts a missed attempt.
    const tried = new Set<string>();
    for (;;) {
      try {
        const more = await this.#round(office, force, tried);
        if (more) continue;
      } catch (error) {
        this.#deps.warn?.("auditing ideas failed", { office, reason: messageOf(error) });
      }
      const again = this.#again.get(office);
      if (again === undefined) return;
      this.#again.delete(office);
      force = again;
    }
  }

  /**
   * One batch: the due ideas (with `force`, also the ones an audit missed before), code first,
   * then one session. True when due ideas this loop has not taken are left beyond this batch.
   */
  async #round(office: OfficeId, force: boolean, tried: Set<string>): Promise<boolean> {
    const handle = this.#deps.offices.get(office);
    const settings = this.#deps.offices.config(office)?.audit;
    if (handle === undefined || settings === undefined) return false;
    const due = handle.deferred(() => dueIdeas(handle, true)).filter((idea) => !tried.has(idea.id));
    if (!force && !due.some((idea) => idea.attempts === 0)) return false;
    const batch = due.slice(0, AUDIT_BATCH_MAX);
    for (const idea of batch) tried.add(idea.id);
    const left = due.length > batch.length;
    const rest = this.#codeFirst(office, handle, batch);
    if (rest.length > 0) await this.#session(office, handle, settings, rest);
    return left;
  }

  /** Writes code's rejections of `batch`; returns the ideas left for the session. */
  #codeFirst(office: OfficeId, handle: OfficeHandle, batch: readonly HeldIdea[]): HeldIdea[] {
    const at = this.#deps.clock.now();
    const rejected = handle.immediate(() => {
      const reasons = codeRejections(handle, batch);
      for (const [id, reason] of reasons) {
        rejectIdea(handle, id, { by: "code", reason, auditRun: null, at });
      }
      return reasons;
    });
    if (rejected.size > 0) this.#deps.onChanged?.(office);
    return batch.filter((idea) => !rejected.has(idea.id));
  }

  async #session(
    office: OfficeId,
    handle: OfficeHandle,
    settings: OfficeConfig["audit"],
    ideas: readonly HeldIdea[],
  ): Promise<void> {
    const runner = this.#deps.runner();
    const ids = ideas.map((idea) => idea.id);
    if (runner === undefined) {
      this.#missed(office, handle, ids, "no audit session can run in this daemon", null);
      return;
    }
    let result: AuditSessionResult;
    try {
      result = await runner.run({
        office,
        handle,
        settings,
        ideas,
        systemFile: auditSystemFile(),
        taskMessage: (commit) => auditTaskMessage(ideas, commit),
      });
    } catch (error) {
      result = { kind: "failed", runId: null, reason: messageOf(error) };
    }
    if (result.kind === "failed") {
      this.#missed(office, handle, ids, `the audit session failed: ${result.reason}`, result.runId);
      return;
    }
    const decisions = decideAnswer(ideas, result.answer);
    if (typeof decisions === "string") {
      this.#missed(office, handle, ids, decisions, result.runId);
      return;
    }
    this.#apply(office, handle, decisions, result.runId);
  }

  #apply(office: OfficeId, handle: OfficeHandle, decisions: AuditDecisions, run: string): void {
    const at = this.#deps.clock.now();
    handle.immediate(() => {
      for (const [id, proposal] of decisions.passed)
        passIdea(handle, id, { proposal, auditRun: run, at });
      for (const [id, reason] of decisions.rejected) {
        rejectIdea(handle, id, { by: "audit", reason, auditRun: run, at });
      }
      for (const [id, problem] of decisions.missed) {
        auditMissed(handle, [id], { problem, auditRun: run, at });
      }
    });
    this.#deps.onChanged?.(office);
  }

  #missed(
    office: OfficeId,
    handle: OfficeHandle,
    ids: readonly string[],
    problem: string,
    run: string | null,
  ): void {
    const at = this.#deps.clock.now();
    handle.immediate(() => auditMissed(handle, ids, { problem, auditRun: run, at }));
    this.#deps.warn?.("an audit left ideas held", { office, ideas: ids.length, reason: problem });
    this.#deps.onChanged?.(office);
  }
}
