# Migration: today's TUI → v2

Each step is a story dipo can run on its own (see `backlog/`). Dependency: DIPO-443 (one part per mode), which is done.

| # | Step | Tier | Needs | Files |
|---|---|---|---|---|
| 1 | Foundations: roles, Frame, action registry, Composer | M | none | colour.tsx → `role`; screen.tsx → `<Frame>`; keys.ts → registry with label/when/priority; footer.ts reads registry; + composer.tsx |
| 2 | Quiet down: clear RunResult panel, Queue reason column, header diet, key remap | S | 1 | app.tsx panel; queue.tsx; views.tsx Header; keys.ts |
| 3 | Desk with preview and kind groups | M | 2 | desk.tsx split; + desk-preview.tsx; keys.ts rowKeys |
| 4 | Floor and `<Pipeline>` | M | 1 | overview.tsx; + pipeline.tsx; run.tsx |
| 5 | Run stream as a table | M | 4 | output.ts folding; detail.tsx tabs; `<Static>` for finished lines |
| 6 | Story reader and test overlay | S | 3 | story-card.tsx; checklist.tsx → overlay; detail.tsx |
| 7 | Palette, keys overlay, Plan and Retro rooms | M | 1 (+ DIPO-449/453) | + palette.tsx; + help.tsx; settings.tsx → palette |

## The only contract additions
1. Spend today on `office.summary` (for the header). It may already be derivable from `dayUsage`, so check before adding.
2. Optional `consequence: string` on `DeskAction`: one code-built line saying what the action will do ("Files a Backlog draft…"). Until then, the TUI keeps a small map from command to sentence.
