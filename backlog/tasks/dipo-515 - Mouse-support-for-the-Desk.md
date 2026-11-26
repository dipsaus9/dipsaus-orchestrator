---
id: DIPO-515
title: Click and scroll the Desk with the mouse
status: In Review
assignee: []
created_date: '2026-11-10 14:23'
updated_date: '2026-11-26 09:57'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - docs/design/tui-v2/spec.md
  - packages/tui/src/input.ts
  - packages/tui/src/mouse.ts
  - packages/tui/src/mouse.test.ts
  - packages/tui/src/options.ts
  - packages/tui/src/app.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/actions.ts
  - packages/tui/src/frame.tsx
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to click a Desk row to focus it, double-click it to open it, click a preview button to act and use the wheel to scroll so that the Desk works with the mouse as the TUI v2 spec describes.

The spec asks for SGR 1006 mouse input (docs/design/tui-v2/spec.md:90, :273). No file under packages/tui/src handles a mouse. Ink 8 (packages/tui/package.json:12) drops each CSI sequence it cannot map to a key before useInput, so mouse reports never reach useKeys (packages/tui/src/input.ts:69-94). Ink has no raw-input interface, but a listener on stdin's data events sees every chunk Ink reads without taking it away.

- On start the TUI turns on press and wheel reporting in SGR form (ESC[?1000h, ESC[?1006h), with no drag or motion. It turns both off on every way out: quit, a crash, Ctrl-C and suspend. --inline and the new --no-mouse flag (packages/tui/src/options.ts) leave reporting off.
- A new parser reads the reports, ESC[<b;x;yM and m, buffered across chunks: left press and release, wheel up and wheel down, with x and y counted from 1.
- Desk only: a press and release on a list row focuses it. A second click on the same row within 400 ms does what Enter does. The wheel over the list moves the focus; over the preview it moves previewScroll (packages/tui/src/desk.tsx:534). A click on a preview button runs the action its key runs, through the action registry.
- Hit testing uses the Frame's rows (packages/tui/src/frame.tsx:24-26) and the Desk's layout.
- Every other screen ignores mouse reports.

Clicking a room or a key hint, and the mouse on other screens, are later stories. The spec line stays as it is.

## What it does not do
- Does not make rooms or key hints clickable.
- Does not add mouse input to any screen other than the Desk.
- Does not support drag or hover.

## ADR lines that change
None.

## Risks and choices
- other: With reporting on, the terminal's own drag-to-select needs a modifier (Shift, or Option on macOS); --no-mouse is the way out.
- tier: M assumes Desk-only hit testing. If mapping rows proves harder than planned, it could grow toward L.

```dipo
branch: "DIPO-515/click-scroll-desk-mouse"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "The parser turns press, release, wheel up and wheel down reports into events with their x and y, including one split across two chunks"
    - kind: "automated"
      check: "A click report sent to the home screen fires no key handler"
    - kind: "automated"
      check: "On the Desk, a click on the third row focuses it, and two clicks within 400 ms open it as Enter does"
    - kind: "automated"
      check: "On the Desk, a click on the first preview button runs its bound action"
    - kind: "automated"
      check: "Wheel reports over the list move the focus, and over the preview they move its scroll"
    - kind: "automated"
      check: "The TUI writes the enable codes on start and the disable codes on quit, and writes neither with --no-mouse or --inline"
    - kind: "manual"
      check: "In iTerm2 and Terminal.app on a 120-column window, click, double-click and scroll on the Desk, then quit with q q"
      expect: "The Desk acts on each mouse action, and after quitting the shell prints no stray escape codes on a click"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Starting the TUI turns on SGR 1006 press and wheel reporting, and quitting, Ctrl-C, suspend and a crash each turn it off.
- [x] #2 With --inline or --no-mouse the TUI never turns mouse reporting on.
- [x] #3 A mouse report never reaches the key handler, so a click or a wheel turn on any screen triggers no key action.
- [x] #4 A mouse report split across two stdin reads is parsed as one report.
- [x] #5 A click on a Desk list row focuses that row.
- [x] #6 Two clicks on the same Desk list row within 400 ms do what Enter does on it.
- [x] #7 A click on a button in the Desk preview runs the same action as that button's key.
- [x] #8 The wheel over the Desk list moves the focus by one row per step, and over the preview it scrolls the preview.
- [x] #9 Every key works as before on every screen.
<!-- AC:END -->
