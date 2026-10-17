---
id: DIPO-180
title: Say the daemon is recovering when a command gets no answer after a restart
status: Refined
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 17:00'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/daemon-commands.test.ts
  - packages/client/src/recovery.ts
  - packages/client/test/unit/recovery.test.ts
  - packages/client/src/node/lifecycle/
  - packages/daemon/src/lifecycle.ts
priority: medium
type: bug
ordinal: 169000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a CLI command sent right after `dipo daemon restart` either waits for the recovering daemon and succeeds, or says the daemon is still recovering and to try again, never only that the daemon did not answer.

Context: gap (b) from the first M1a setup (2026-10-17). Right after `dipo daemon restart`, a CLI command failed with `dipo: the daemon did not answer within 10 s.` while the daemon was still recovering. DIPO-86 made commands wait out engine.recovering: withDaemon (packages/cli/src/daemon-commands.ts) wraps the session in waitForRecovery (packages/client/src/recovery.ts), which polls daemon.status after a refused request, and on the deadline prints `the daemon was still recovering after 10 s; try again shortly` when it was waiting. The plain did-not-answer line prints when the session was not waiting: the request got no reply at all, not even engine.recovering, so the client never learned the daemon was recovering. Why the daemon gave no reply is not known yet; candidates are recovery work holding the daemon's event loop, or the request reaching the daemon that the restart was stopping (packages/client/src/node/lifecycle/, packages/daemon/src/lifecycle.ts). DIPO-120 changes the TUI's recovering banner and also touches packages/client/src/recovery.ts.

```dipo
branch: "DIPO-180/say-recovering-after-restart"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a silent fake daemon whose daemon.status says recovering gives the recovering line; one that answers nothing gives the did-not-answer line"
    - kind: "manual"
      check: "(live) in this repository run dipo daemon restart and at once dipo gate with a story id"
      expect: "the command waits and prints the gate result, or prints the recovering line; never the did-not-answer line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The task notes state why the request got no reply within 10 s, from a reproduction: dipo daemon restart followed at once by an office command, with a recovery longer than the reply timeout
- [ ] #2 When the reply deadline passes with no reply, the client asks daemon.status on a new connection and, when the daemon is starting or recovering, prints that the daemon is still recovering, to try again shortly or see `dipo daemon status`, instead of the did-not-answer line
- [ ] #3 A command sent while the daemon is recovering still waits within the reply deadline as DIPO-86 decided, and succeeds when recovery ends in time
- [ ] #4 Tests cover a fake daemon that accepts the request and sends no reply while its status says recovering (the recovering line), and one that sends no reply and answers no status either (the did-not-answer line stays)
<!-- AC:END -->
