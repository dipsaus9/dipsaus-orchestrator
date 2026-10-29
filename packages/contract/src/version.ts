// Contract version of 0005 section 11, independent of the binary version. Same major means
// compatible; a minor adds only.

import { z } from "zod";

export const ContractVersion = z.object({
  major: z.int().nonnegative(),
  minor: z.int().nonnegative(),
});
export type ContractVersion = z.infer<typeof ContractVersion>;

// Minor 1 (DIPO-27): `office.reloadConfig` ships and `office.open` replies with `warnings`.
// Also in minor 1 (DIPO-72): `scan.finished` carries `trigger`, `level`, `deviations`, `diff` and
// `error`.
// DIPO-65 adds the read `office.stats` to the same, still unreleased, minor.
// DIPO-71 adds the read `story.gate` and the error codes `config.invalid` and `backlog.unreadable`
// to the same, still unreleased, minor.
// DIPO-36 ships the command `office.init` in the same, still unreleased, minor.
// DIPO-48 adds the optional `from` of `work.run`, the retryable `git.fetchFailed` and the office
// code `run.refused` to the same, still unreleased, minor.
// DIPO-74 adds the read `work.preview` (the dry run of `work.run`) to the same, still unreleased,
// minor.
// DIPO-52 adds the read `office.switch`, the optional `view` (a `WorkView`) on the work events and
// `usage.updated`, `work.observed.clearedAt`, and `Verdict.failures` with `Verdict.run` optional
// to the same, still unreleased, minor.
// DIPO-59 ships `work.answer` (with `decision` for permission questions), `question.asked` and
// `question.closed`, adds the optional `questions` of `story.detail` and the office code
// `question.closed` to the same, still unreleased, minor.
// DIPO-61 ships the command `work.resume` (for runs held by a plan limit) in the same, still
// unreleased, minor.
// DIPO-76 ships the command `office.purge` in the same, still unreleased, minor.
// DIPO-75 adds the optional `run` of the `work.answer` result (the run an answer to a
// `needs-permission` park resumed) to the same, still unreleased, minor.
// DIPO-81 adds `OfficeSummary.ready` to the same, still unreleased, minor.
// DIPO-83 adds the optional `optIns` of `OfficeSummary` (the privacy opt-ins that are on) to the
// same, still unreleased, minor.
// DIPO-95 adds `OutputMarker` and the optional `markers` of `work.output` and of the
// `work.outputRange` result (engine phase markers flagged in the worker output) to the same, still
// unreleased, minor.
// DIPO-97 adds the optional `outputRetentionDays` of `OfficeSummary` (the stored-output retention
// period) and `StoryView.gateFailures` (the failed Ready gate rules with their rule ids) to the
// same, still unreleased, minor.
// DIPO-111 adds the generic code `database.unavailable` (not retryable) and its
// `DatabaseUnavailableDetails` to the same, still unreleased, minor.
// DIPO-140 ships the commands `gate.approve` and `gate.reject`, adds `Verdict.review`,
// `gate.decided.review`, `StoryView.pr`, `Progress.reviewRoundCap` and `Progress.reviewRoundsFailed`,
// the event `story.pr` and the office codes `gate.notWaitingOnMaintainer`, `gate.handMergeOnly` and
// `gate.noteRequired` to the same, still unreleased, minor.
// DIPO-179 adds the optional `waitingOn` of `story.gate` (the dependencies that are not Done) to the
// same, still unreleased, minor.
// DIPO-228 adds the read `story.losses` (the commits and files `story.drop` with `deleteBranch`
// loses) to the same, still unreleased, minor.
// DIPO-198 adds the optional `buildCommit` and `engineBehind` of `daemon.status` to the same, still
// unreleased, minor.
// DIPO-137 adds the read `work.prompt` (the stored prompt text of an agent's session) to the same,
// still unreleased, minor.
// DIPO-142 adds the optional `cause` of `story.parked` (0020 section 2) to the same, still
// unreleased, minor.
// DIPO-163 ships the commands `work.steer` (its `delivered` also says `on-resume`) and `work.pause`,
// the optional `queued` of the `work.resume` result and the office code `story.notSteerable` in the
// same, still unreleased, minor.
// DIPO-136 ships the command `office.setPrivacy` and adds the optional `privacy` of `OfficeSummary`
// (each privacy setting with its value and source) to the same, still unreleased, minor.
// DIPO-251 adds the optional `warnings` of `story.gate` (rules that warn without failing, R29) to
// the same, still unreleased, minor.
// DIPO-271 adds the optional `box` of `work.run` (run the developer in its own box, 0021) to the
// same, still unreleased, minor.
// DIPO-150 adds the optional `gates` of `story.detail` (the story's open gates that wait for the
// maintainer, 0019 section 11) to the same, still unreleased, minor.
// DIPO-161 ships the command `work.discard` and the office codes `story.prMerged` and
// `story.notDiscardable` in the same, still unreleased, minor.
// DIPO-161 also adds the optional `command` of `story.losses` and its optional `kept` result to the
// same, still unreleased, minor.
// DIPO-158 adds the read `office.desk` (what waits on the maintainer, ordered by the engine) and its
// `DeskItem` shape to the same, still unreleased, minor.
// DIPO-311 adds the optional `monthUsage` of `OfficeSummary`, fills `dayUsage` and adds the
// capability flag `usage.alerts` in the same, still unreleased, minor.
// DIPO-310 ships the commands `office.infer` and `office.confirm` and the read `office.profile` (the
// run profile's fallback and confirmation, 0013 section 6), the `ScanTrigger` values `infer` and
// `confirm` and the office codes `scan.noProfile`, `scan.noProposal`, `scan.resolvedByCode`,
// `scan.notConflict`, `scan.noCandidate`, `scan.notConfirmed`, `scan.invalidCommand` and
// `scan.staleProposal` in the same, still unreleased, minor.
// DIPO-308 ships the read `office.digest`, with `since` made optional (the engine then counts from
// when the office's last TUI client disconnected), and so its capability flag `digest`, in the same,
// still unreleased, minor.
// DIPO-344 replaces `work.stop`, `work.pause` and `story.hold` with `story.park`, cuts the park
// reasons to the eight of 0001, and removes `cause` from `story.parked` and the desk item,
// `decision` from `work.answer`, the `held` column and the office code `resume.decisionRequired`,
// in the same, still unreleased, minor.
// DIPO-359 replaces the plan-limit hold with the office's starts paused: it adds the desk kind
// `STARTS PAUSED`, `daemon.resumeScheduling` also lifts every office's starts paused, `work.resume`
// no longer continues a held run, and the health values `limited` and `paused`, the watchdog
// signal `plan-limit` and the skip reason `planLimit` go, in the same, still unreleased, minor.
// DIPO-309 ships the commands `test.start` and `test.record` (and so the capability flag
// `test.sessions`), adds `TestStep`, the `head`, `steps`, `url` and `shell` of `TestView`, the
// event `test.ended` and the office codes `story.notTestable`, `test.notInReview`,
// `test.refused`, `test.startFailed` and `test.closed`, and replaces the `script` of the
// `test.start` result with `steps`, in the same, still unreleased, minor.
// DIPO-349 removes the story worktree: `worktree` of `WorkerLaunchPreview`, `files` and `kept` of
// the `story.losses` result, the office code `story.dirtyWorktree` and the `run.refused` check
// `slots` go, and the desk kind `LEFTOVER WORKTREE` is added, in the same, still unreleased, minor.
export const CONTRACT_VERSION = Object.freeze({ major: 1, minor: 1 }) satisfies ContractVersion;
