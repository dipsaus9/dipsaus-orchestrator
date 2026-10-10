---
id: m-0
title: "M0 Walking skeleton"
---

## Description

Engine, daemon, local database, Claude CLI adapter and a minimal TUI. Office init and switching (the office list). Repository scan and rescan for run knowledge. Context provider interface with the default provider (story scope, inputs, component map when present; context budgets by project size; research ideas 23 and 26). Takes one Ready story from Backlog.md, creates worktree and branch, runs a worker, runs verify and shows live output. No planning, review or parallelism. See docs/decisions/0003-milestones-and-quality-bar.md.
