---
id: m-1
title: "M1 Review and park"
---

## Description

M1a, the unattended loop: the engine opens the story PR, a reviewer session in a read-only box reviews it against the story, review findings, a red verify in the box, red CI and conflicts go back to the story's worker through one feedback path within caps, and an approved merge gate merges through GitHub auto-merge. A stopped story is parked with one of eight reasons and resumes through one path. The maintainer's commands are park, resume, drop, discard, steer, answer, approve and reject, and `dipo desk` lists what waits and posts a notification when it gains an item. M1b: the triage view in the TUI, `dipo test` in a test box with pass or fail feedback, the scan's AI fallback with its confirm command, and daily and monthly spend alerts. Stories carry `slice:m1a` or `slice:m1b`.

Paused since 2026-10-24 for the prune toward the simplified architecture (0003). The prune stories carry `slice:prune` and `track:1` or `track:2`. Track 1 is the run path, built by builder agents from the orchestrating session and ending in the cutover gate DIPO-351. Track 2 is built by dipo itself after the cutover.
