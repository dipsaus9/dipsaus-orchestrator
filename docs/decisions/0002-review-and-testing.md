# 0002 Review and testing

Status: accepted (grill session, 2026-10-09).

## Two separate gates

1. **Code review is done by a bot.** A reviewer is spawned for a given PR and judges the diff against the story goal, acceptance criteria and declared scope. It runs as a separate session from the implementer and never sees the implementer's reasoning. The same pattern applies to building this repository and to what the program does for its users.
2. **Acceptance testing is done by the human, and only when chosen.** The human tests behavior by running the software, not by reading code. Code is opened only by exception.

## Rules

- A story passes review when the reviewer returns no blocking finding. A blocking finding is an unmet acceptance criterion or a scope violation. Advisory findings never block.
- The author fixes reviewer feedback, up to a capped number of rounds. When the cap is reached the story parks with reason `review-blocked`.
- A story can be flagged **test before merge**. Flagged stories wait in `In Review` until the human has tested the branch. Unflagged stories merge when the reviewer passes.
- The flag is set by the human. Refine may suggest it, for example when other stories depend on the story, but never sets it.
- Every story that may be tested carries a short manual test script (steps and expected result), produced during refine. `ready` fails for a flagged story without one.
- The tool makes testing cheap: it shows what to test and provides a runnable checkout of the story branch.
- The human always keeps merge authority over what ships. Automatic merge is allowed only after reviewer pass on unflagged stories.

## Building this repository

- Code is written by one agent, reviewed by another agent against the story goal, and fixed until the review passes. The maintainer does not review code.
- Merging, including auto-merge, is allowed after the review passes.
