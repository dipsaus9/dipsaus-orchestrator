// The retro view's numbers (0022, DIPO-453): why stories parked, how many rounds and loops they
// took, what they cost, how long they took from Ready to merged, where they came from, how much of
// it was rework and what the audit and the maintainer turned away. Every number is counted here
// from the state database; no model is asked (0001). The same lines go to the TUI and to a planning
// session's first message, which may explain them and never computes them.
//
// Rework (the maintainer's rule, 2026-11-05): a merged story is rework when more than half of the
// files it changed were changed by another story merged in the 14 days before it.

import type { officeRetro } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import type { OfficeHandle } from "../db/office";

export const REWORK_DAYS = 14;
const DAY_MS = 86_400_000;

type Retro = z.input<typeof officeRetro.result>;
type Group = Retro["groups"][number];

/** The origins a story keeps, then `unknown` for the ones from before dipo kept it. */
export const RETRO_ORIGINS = [
  "planned",
  "proposal",
  "finding",
  "quick",
  "aside",
  "unknown",
] as const;

const ORIGIN_WORDS: Readonly<Record<(typeof RETRO_ORIGINS)[number], string>> = {
  planned: "planned",
  proposal: "worker proposal",
  finding: "reviewer advisory",
  quick: "quick idea",
  aside: "session aside",
  unknown: "unknown",
};

interface OutcomeRow {
  story_key: string;
  tier: string | null;
  park_reasons: string;
  loops: number;
  review_rounds: number;
  review_rounds_failed: number;
  ci_attempts: number;
  conflict_handoffs: number;
  cost_micros: number | null;
  story_type: string | null;
  ready_at: number | null;
  merged_at: number | null;
}

function parkReasons(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Per tier and type: the outcome rows of every run that ended, summed by story group. */
function groups(office: OfficeHandle): Group[] {
  const rows = office.all<OutcomeRow>(
    `select o.story_key, o.tier, o.park_reasons, o.loops, o.review_rounds, o.review_rounds_failed,
            o.ci_attempts, o.conflict_handoffs, o.cost_micros,
            s.story_type, s.ready_at, s.merged_at
       from run_outcomes o
       join stories s on s.office_id = o.office_id and s.key = o.story_key
      where o.office_id = $office_id
      order by o.ended_at, o.run_id`,
  );
  // A story counts in the group of its latest outcome.
  const groupOf = new Map<string, string>();
  for (const row of rows) {
    groupOf.set(row.story_key, JSON.stringify([row.tier ?? "none", row.story_type ?? "unknown"]));
  }
  const built = new Map<string, Group & { spans: number[] }>();
  const seen = new Set<string>();
  for (const row of rows) {
    const id = groupOf.get(row.story_key) as string;
    let group = built.get(id);
    if (group === undefined) {
      const [tier, type] = JSON.parse(id) as [string, string];
      group = {
        tier,
        type,
        stories: 0,
        merged: 0,
        parks: {},
        loops: 0,
        reviewRounds: 0,
        reviewRoundsFailed: 0,
        ciAttempts: 0,
        conflictHandoffs: 0,
        costMicros: null,
        timed: 0,
        readyToMergedMinutes: null,
        spans: [],
      };
      built.set(id, group);
    }
    for (const reason of parkReasons(row.park_reasons)) {
      group.parks[reason] = (group.parks[reason] ?? 0) + 1;
    }
    group.loops += row.loops;
    group.reviewRounds += row.review_rounds;
    group.reviewRoundsFailed += row.review_rounds_failed;
    group.ciAttempts += row.ci_attempts;
    group.conflictHandoffs += row.conflict_handoffs;
    if (row.cost_micros !== null) group.costMicros = (group.costMicros ?? 0) + row.cost_micros;
    if (!seen.has(row.story_key)) {
      seen.add(row.story_key);
      group.stories += 1;
      if (row.merged_at !== null) {
        group.merged += 1;
        if (row.ready_at !== null && row.merged_at >= row.ready_at) {
          group.spans.push((row.merged_at - row.ready_at) / 60_000);
        }
      }
    }
  }
  return [...built.values()]
    .toSorted((a, b) => a.tier.localeCompare(b.tier) || a.type.localeCompare(b.type))
    .map(({ spans, ...group }) => ({
      ...group,
      timed: spans.length,
      readyToMergedMinutes:
        spans.length === 0
          ? null
          : Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10,
    }));
}

function origins(office: OfficeHandle): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(RETRO_ORIGINS.map((o) => [o, 0]));
  const rows = office.all<{ origin: string | null; n: number }>(
    `select origin, count(*) as n from stories
      where office_id = $office_id and removed_at is null group by origin`,
  );
  for (const row of rows) {
    const origin = row.origin ?? "unknown";
    counts[origin] = (counts[origin] ?? 0) + row.n;
  }
  return counts;
}

/**
 * The rework share by the 14-day file rule: of the merged stories with their files kept, those
 * with more than half of their files changed by a story merged in the `REWORK_DAYS` before them.
 */
export function reworkShare(office: OfficeHandle): Retro["rework"] {
  const files = new Map<string, string[]>();
  for (const row of office.all<{ key: string; path: string }>(
    `select key, path from story_files where office_id = $office_id order by key, path`,
  )) {
    const list = files.get(row.key) ?? [];
    list.push(row.path);
    files.set(row.key, list);
  }
  const mergedAt = new Map(
    office
      .all<{ key: string; merged_at: number }>(
        `select key, merged_at from stories where office_id = $office_id and merged_at is not null`,
      )
      .map((row) => [row.key, row.merged_at]),
  );
  let merged = 0;
  let rework = 0;
  for (const [story, at] of mergedAt) {
    const own = files.get(story) ?? [];
    if (own.length === 0) continue;
    merged += 1;
    const before = new Set<string>();
    for (const [key, other] of mergedAt) {
      if (key === story || other >= at || other < at - REWORK_DAYS * DAY_MS) continue;
      for (const path of files.get(key) ?? []) before.add(path);
    }
    const shared = own.filter((path) => before.has(path)).length;
    if (shared * 2 > own.length) rework += 1;
  }
  return { merged, rework };
}

/** The group a rejection reason belongs to: code's two reasons keep their kind, not their ids. */
export function rejectionReason(by: string, reason: string): string {
  if (by !== "code") return reason;
  if (reason.startsWith("its title is that of ")) {
    return "its title is that of a story the office already has";
  }
  if (reason.startsWith("it is the same as idea ")) {
    return "it is the same as an idea held already";
  }
  return reason;
}

function rejections(office: OfficeHandle): Retro["rejected"] {
  const counts = new Map<string, { by: "code" | "audit"; reason: string; count: number }>();
  for (const row of office.all<{ decided_by: "code" | "audit"; reason: string }>(
    `select decided_by, reason from ideas
      where office_id = $office_id and state = 'rejected' order by decided_at, idea_id`,
  )) {
    const reason = rejectionReason(row.decided_by, row.reason);
    const id = `${row.decided_by}:${reason}`;
    const entry = counts.get(id) ?? { by: row.decided_by, reason, count: 0 };
    entry.count += 1;
    counts.set(id, entry);
  }
  return [...counts.values()].toSorted(
    (a, b) => b.count - a.count || a.by.localeCompare(b.by) || a.reason.localeCompare(b.reason),
  );
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/** Pure: the retro as lines, the same for the TUI and for a planning session. */
export function retroLines(parts: Omit<Retro, "lines" | "office">): string[] {
  const lines: string[] = [];
  if (parts.groups.length === 0) lines.push("No story run has ended yet.");
  for (const group of parts.groups) {
    lines.push(
      `Tier ${group.tier}, type ${group.type}: ${group.stories} ${group.stories === 1 ? "story" : "stories"}, ${group.merged} merged`,
    );
    const parks = Object.entries(group.parks).toSorted(
      ([a, x], [b, y]) => y - x || a.localeCompare(b),
    );
    lines.push(
      `  parks: ${parks.length === 0 ? "none" : parks.map(([reason, n]) => `${reason} ${n}`).join(", ")}`,
    );
    lines.push(
      `  fix rounds: review ${group.reviewRoundsFailed} failed of ${group.reviewRounds}, CI ${group.ciAttempts}, conflict hand-offs ${group.conflictHandoffs}; loops ${group.loops}`,
    );
    lines.push(
      `  cost: ${group.costMicros === null ? "not reported" : dollars(group.costMicros)}; Ready to merged: ${group.readyToMergedMinutes === null ? "no data" : `${duration(group.readyToMergedMinutes)} on average over ${group.timed}`}`,
    );
  }
  lines.push(
    `Where stories came from: ${RETRO_ORIGINS.map((origin) => `${ORIGIN_WORDS[origin]} ${parts.origins[origin] ?? 0}`).join(", ")}`,
  );
  const { merged, rework } = parts.rework;
  lines.push(
    merged === 0
      ? `Rework: no merged story has its files kept yet (the rule: most of its files changed by a story merged in the ${REWORK_DAYS} days before)`
      : `Rework: ${rework} of ${merged} merged stories (${Math.round((rework / merged) * 100)}%) changed mostly files another story changed in the ${REWORK_DAYS} days before`,
  );
  const total = parts.rejected.reduce((sum, r) => sum + r.count, 0);
  lines.push(`Ideas the audit rejected: ${total}`);
  for (const r of parts.rejected) lines.push(`  ${r.count} x ${r.reason} (${r.by})`);
  lines.push(`Proposed stories you dismissed: ${parts.dismissed}`);
  return lines;
}

/** The retro of `office`, as `office.retro` returns it. */
export function retro(office: OfficeHandle): Retro {
  return office.deferred(() => {
    const parts = {
      groups: groups(office),
      origins: origins(office),
      rework: reworkShare(office),
      rejected: rejections(office),
      dismissed:
        office.get<{ n: number }>(
          `select count(*) as n from ideas where office_id = $office_id and answer = 'dismissed'`,
        )?.n ?? 0,
    };
    return { office: office.officeId, ...parts, lines: retroLines(parts) };
  });
}
