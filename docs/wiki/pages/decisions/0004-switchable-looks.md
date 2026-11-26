---
title: "ADR 0004: Three switchable looks"
type: decision
status: accepted
superseded_by:
tags: [ui, design, settings, notes-area, sticky-notes]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# ADR 0004: Three switchable looks

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
- C falls back to A's narrow layout below 760 px; B shows one column below 560 px.
- Tests run the shared behaviour (saving before switching notes, leaving on the second attempt,
  read only, one editor per note) once per look.

## Consequences
- More CSS and three layout components to keep consistent; the shared logic keeps the risk of
  losing text the same in every look.
- Screenshots in the usability pass are taken per look.
