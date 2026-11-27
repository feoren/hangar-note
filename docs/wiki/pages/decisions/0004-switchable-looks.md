---
title: "ADR 0004: Switchable looks"
type: decision
status: accepted
superseded_by:
tags: [ui, design, settings, notes-area, sticky-notes]
sources: []
created: 2026-11-26
updated: 2026-11-27
---

# ADR 0004: Switchable looks

First accepted with three looks; since the amendment of 2026-11-27 there are two, "Hangar"
(default) and "Paper". The sections up to "Consequences" are kept as decided on 2026-11-26.

## Context
Three design directions were drawn for the notes area and the sticky note (see
[[usability-pass]]): A "Calm" (a reduced list, color as a thin edge, tools on hover and focus),
B "Paper" (notes as soft color cards in a grid, checklists ticked in place, the open note as a
sheet over the grid) and C "Hangar" (Hangar's look, three columns with scopes and colors as fixed
rows, a status bar). A was built first as the default. The owner then asked for all three to be
built in.

## Options
1. **One look only (A).** Least code, but not what the owner asked for.
2. **Three separate notes areas.** Each look its own component tree with its own saving and
   leaving logic. Fast to draw, but three copies of the code that protects text from being lost,
   which will drift apart.
3. **One notes area, three layouts.** State, saving, leaving, notices, errors, keyboard handling and
   menus exist once; each look is a layout over the same parts plus its own stylesheet section.

## Decision
Option 3.
- A setting **Look** with the values `calm` (default), `paper` and `hangar`, stored in
  `settings.json` as `look`, offered in the settings as three choices with a small preview each.
  Switching takes effect at once, without a restart and without leaving the open note.
- The sticky note follows the chosen look (A: text with a drag strip, tools on hover and focus;
  B: a fixed colored header and a floating format bar; C: title and progress in the header, a
  format bar with the save state).
- Every function stays reachable in every look, through the same menus and the same keyboard
  shortcuts; the row context menu (right click, menu key, Shift+F10) exists in all three.
- C falls back to A's narrow layout below 760 px; B shows one column below 560 px. (Changed by
  the navigation rework in [[usability-pass]]: one sidebar in every look, folded below 760 px; C
  falls back to A below 840 px. Changed again by the levels in [[usability-pass]]: the sidebar
  can be folded away and resized, so C falls back to A when the room beside the sidebar is
  below 608 px, and always below 760 px.)
- Tests run the shared behaviour (saving before switching notes, leaving on the second attempt,
  read only, one editor per note) once per look.

## Consequences
- More CSS and three layout components to keep consistent; the shared logic keeps the risk of
  losing text the same in every look.
- Screenshots in the usability pass are taken per look.

## Amendment 2026-11-27: "Calm" removed, paper opens a note only by choice

The owner asked: "remove the style Calm, and Paper must not open a note directly".

- **Two looks.** `calm` is no longer a look. The setting knows `hangar` (the default) and `paper`
  (`src/looks.ts`, `Look` in `src-tauri/src/settings.rs`). A stored `"calm"`, an unknown value or
  no value reads as `hangar` in both the backend and the front end (`lookOf`); nothing is migrated
  on disk, the next save writes the look shown. Gone with it: the choice in the look switch, the app
  menu and the settings (now two cards), the texts `look.calm` and `look.calmHint` in all 12
  languages, the icon and the CSS of the look.
- **Hangar's narrow layout.** What C borrowed from A where its columns do not fit is now part of
  Hangar: `src/HangarNarrowLayout.tsx` (list or note one at a time with "Back" up to 600 px of room,
  side by side above it), chosen by `layoutFor` as `hangarNarrow` when the room beside the sidebar
  is below 608 px and always below 760 px. Hangar works from 320 px to any width.
- **Sticky note.** Without A's hidden header, both looks show a header in the note's color that is
  always there and moves the window (`data-tauri-drag-region`, tooltip "drag"). The separate drag
  strip is gone: one region, the same in both looks.
- **Paper opens a note only by choice** (`src/paperSheet.ts`, used by `src/useNotesArea.tsx`).
  Paper's open note is a modal sheet; one that opens by itself hides the cards the person came
  for. A sheet opens for: a click or Enter on a card (also "Rename" from a card's menu), "+" and
  Ctrl+Shift+N (a new note is written in its sheet), and requests from Hangar or the command line
  that name a note or bring text (`open --note`, quick note, capture): each is an explicit choice
  of that note. Everything else shows the cards, and a note open at that step is saved first and
  then closed: switching to paper (switch, app menu, settings, or another window), the way back
  from the trash or the settings, another level or area (sidebar, Ctrl+1 to Ctrl+3), Hangar showing
  its project, and Undo after a delete (the card comes back with the focus, no sheet). Switching
  the look keeps drawing the old look until the note is saved and closed, so the sheet never
  flashes. A note that cannot be saved stays open in its sheet with its notice, as before; a look
  switch never drops text (`leave`), a person's step to another area follows the usual second-try
  rule (`leaveByPerson`). The start with paper opens nothing by itself.
- Tests: the shared behaviour runs for hangar, hangar's narrow layout and paper; `paperSheet.test.ts`
  and the paper cases in `NotesArea.test.tsx` cover the rule; `the_look_is_read_written_and_falls_back_to_hangar`
  covers the backend.
