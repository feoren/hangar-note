---
title: Usability pass of the notes area (phase 1)
type: synthesis
tags: [ux, accessibility, notes-area, i18n]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# Usability pass of the notes area (phase 1)

Every flow of the notes area (`src/NotesArea.tsx`, `src/Trash.tsx`, `src/NotesSettings.tsx`) walked
through as a person who sees the app for the first time, plus the findings of the phase 1 review.
Rule applied throughout: when in doubt, fewer controls and clearer texts ([[0001-foundation]],
anti-goals). Each entry: finding, change, reason.

## Review findings

| Finding | Change | Reason |
| --- | --- | --- |
| `capture` showed "Saved in a new quick note" even when the note could not be created (read only, disk error). | The message appears only once the note exists. A capture that cannot become a note stays in the draft with "This text is not saved. Copy it so it does not get lost." and "Copy as Markdown". | A success message for an unsaved text is the one lie a notes app must not tell. The text came from Hangar once; the draft is the only place it still exists. |
| `quick` opened a draft while read only; typing went nowhere. | `quick` opens no draft while read only; the list with its read-only hint shows instead. | A text field that can never save invites lost work. |
| Without a project folder the start scope was "General", hiding project notes. | "This project" without a folder shows "All"; new notes still go to General (`src/notesScope.ts`). | A first start should show every note; where a new note lands did not change. |
| The color filter was a row of 12 px dots without a label; pale dots vanished on white; the color menu showed other tones than the filter. | Visible label "Color"; every color is a 32 x 32 px target; a ring (`--swatch-border`, 4.5 : 1 on white) around dots and swatches; one tone per color for filter, menus and settings (`swatchColor` in `src/colors.ts`). Own color names are the tooltip and the accessible name. | Targets and contrast as asked (non-text contrast at least 3 : 1, WCAG 1.4.11); the same color must look the same wherever it is picked. |
| The trash hid its "Restore" buttons while read only without saying why; a load error was a dead end. | A line explains when restoring works again; a load error offers "Try again"; `Trash` is its own component with tests. | A missing button reads as a bug; an error needs a next step. |
| Titles of captured notes read "01:54 · Demo Project". | The capture heading, and so the title, reads "From Demo Project, Nov 26, 01:54" (`notes.capturedFrom`, `captureStamp` in `src/format.ts`). Escaped characters in the heading stay in the title (`titleFromText`), so `my_shop` no longer becomes `my\shop`. | The title says where a note came from and when, in words. |
| "On the desktop" was both in the note menu and in the footer. | Kept the footer button, removed the menu entry. | One place, the visible one. |
| The read-only hint said "Update Hangar to edit them here", which no Hangar release can do yet. | Heading "Your Hangar notes", line "Hangar still manages them for now. You can read and search them here; editing works once Hangar hands them over." Neutral colors instead of the accent tint. | The hint must not send people to an update that does not help. Read only is a state, not a fault. |
| `openNote` and `backToList` switched notes even when `leave()` could not save; the typed text was gone. | They (and the trash, the settings and a new draft) stay on the note when it is not saved; the footer shows "Not saved" and the error says why. A capture arriving meanwhile becomes a note in the background. | Losing text is the anti-goal of [[0001-foundation]]. |
| The notes area had no "Always on top" (Hangar's detached panel had it). | A switch "Always on top" in the list menu (`role="menuitemcheckbox"`), stored by the backend in `settings.json`. | Parity with Hangar ([[0002-hangar-notes-takeover]]). |

## Own findings

| Flow | Finding | Change | Reason |
| --- | --- | --- | --- |
| Errors | The error box sat at the top of the list; in a narrow window with a note open the list is hidden, so errors were invisible. | Errors and toasts share one place at the bottom of the window (`.notices`). | Feedback must be visible where the person is. |
| Loading | A failed list load showed "There are no notes in this area yet" and "New note". | "The notes could not be loaded." with "Try again". | An empty list after an error looks like data loss. |
| Empty states | "No note contains ..." and "No note has the chosen colors" had no way out; the empty trash said only "Nothing deleted here". | Each has one sentence and one button: "Clear search", "All colors", "Back to the notes"; the trash says what it is for. | Every empty state names the next step. |
| Desktop and back | The sticky note view offered "Back to the list" next to the arrow "Back to the list" with another meaning (take it off the desktop). | The button is now "Edit here"; the hint says the note is edited in its sticky note or here. | Two buttons with one name and two effects are a trap. |
| List menu | "Open folder" did not say which folder. | "Open notes folder". | Concrete over generic. |
| Keyboard | Back buttons in the trash and the settings had a name for screen readers but no tooltip. | Tooltip added. Focus moves to "Try again" after a failed trash load. | Pointer users get the same name. |
| Color names | Naming a color lives only in the settings. | Not changed. | The settings section is labeled "Names of the colors" with an example; an extra entry in the color menu would add a control to every note for a one-time task. |
| Note menu | "Show in Explorer", "Export" and "Copy as Markdown" sit together. | Not changed. | All three exist in Hangar's panel and are expected by people who move from it ([[0002-hangar-notes-takeover]]). |

## Checked and fine

- First note: "New note" in the header, the empty state and the note pane; the title follows the
  first line; Ctrl+Shift+N is named in the empty state.
- Finding: search across all notes with Escape to clear; scope chips; arrow keys move through the
  list; Delete puts a note into the trash with "Undo".
- Rename: click on the title or F2; Enter keeps, Escape cancels.
- Export: the backend's save dialog, then "Saved: <path>".
- Settings: language, theme, color of new notes, color names, start with the system.
- Contrast (WCAG 2 formula as in `src/colors.ts`): `--muted` on `--panel`, `--panel-raised`,
  `--bg` and `--hover` 4.58 to 5.98 in dark, 5.60 to 6.11 in light; the swatch ring 4.55 on white;
  note colors are measured by `colors.test.ts`.
- 320 px wide: no horizontal overflow (document width equals the viewport); the color filter wraps
  to a second row when colors carry own names.

## Resolved after the pass

- Copying text that exists only in a window goes through the backend (`copy_text`, the clipboard
  plugin) instead of `navigator.clipboard` and the copy command (`src/clipboard.ts`).
- A note whose save keeps failing can be left: the first try stays with a warning and "Copy as
  Markdown", a second try within 10 s leaves without the unsaved text, as "Quit" does
  ([[0001-foundation]], "Leaving an unsaved note").
- After the trash or the settings, the open note (and every note opened later) showed an empty
  pane: the editor stayed in the element React had replaced. `ensureEditor` now notices a new
  host and makes the editor again with the open text (`src/NotesArea.tsx`, test in
  `src/NotesArea.test.tsx`). Found in the real window, not in the preview.
- A read-only editor carries `aria-readonly="true"`; CodeMirror keeps `contenteditable` either way.
- With no note of the chosen colors, "All colors" shows once (in the empty state), not twice.

## Direction A as built

The calm direction ("Ruhig") of the design study, built on 2026-11-26. Same flows, fewer controls.

| Area | Change | Reason |
| --- | --- | --- |
| Header | One title menu ("All notes" with a chevron) holds the scopes with their note counts, "Recently deleted", "Open notes folder", "Always on top" and "Settings". Next to it one primary button "New note". The scope chips and the list menu "…" are gone. | Two rows above the list instead of four; the scope a person is in is the heading. |
| Color filter | One button of fixed width next to the search. Its menu lists the eight colors as fixed rows (dot, own name, count, check mark, a ring around the chosen dot) and keeps "All colors" in a fixed place, disabled while nothing is chosen. It stays open while choosing. The button shows up to three chosen dots and names them for screen readers. | The old filter jumped when a color was chosen. Costs one click more than before (see open points). |
| Rows | The color is a thin edge (`edge` in `src/colors.ts`, at least 3 : 1 on `--bg`, `--panel`, `--panel-raised` and `--hover` in both themes; Mint and Sand were darkened for the hover surface). Tools (color, on the desktop, delete) show on hover and on keyboard focus. A right click, the menu key or Shift+F10 opens a menu with every action of the row (color, on the desktop, rename, copy as Markdown, export, show in Explorer, delete). Only the current row is a Tab stop (roving tab index); arrow keys move between rows. | Coloring, putting on the desktop and deleting work without opening the note; nothing depends on hover alone. |
| Open note | Reads like a page: crumb (scope), "On the desktop" and "…" at the top, the title large, the text at 15 px in a column of at most 620 px. The note menu starts with the colors. | Long notes read best; the note color no longer fills the pane, it is a 3 px edge on top. |
| Notices | One place in the footer (`src/notices.ts`, `src/NoticeSlot.tsx`): a new notice replaces the old one of its kind, "not saved" ranks before an error before an info, an info goes after 6 s (paused on hover and focus), errors stay until fixed or dismissed. The notice crossfades with the word count; it never floats over text. An always present polite live region carries infos, an alert carries errors. | Notices used to stack and cover the footer. |
| Errors | `src/errors.ts` turns every code into one sentence of `i18n.ts` (the `storage.*` sentences for storage codes) and at most one button ("Open notes folder", "Reload the list", "Try again"). `errorText` is gone; no path, code or English backend text reaches a window. The sticky note says the same sentences. | A raw backend text helps nobody. |
| Empty | With no notes the window shows one invitation: a title, one line, one "New note" and the shortcut. Search, filter and the second button appear once there are notes. | Three "New note" buttons were two too many. |
| Sticky note | At rest only the text and a 10 px color strip at the top, which is always the drag region (cursor "grab"). On hover or focus the header (new, menu, close) and the formatting bar fade in; their places stay free, so the text never moves. | Calm on the desktop, still movable without a visible header. |
| Motion | Row tools 120 ms opacity; sticky header and bar 140 ms; menus 150 ms opacity plus scale from 0.97, growing from their button; notices 150 ms; a press scales to 0.97 for 120 ms; keyboard actions without motion. With reduced motion only opacity, at most 80 ms. Menus close without motion. | As in the study's table for A. |

Checked in the real window (debug build against a copy of the sample notes): wide and narrow,
light and dark, the title menu, the color filter, the note menu with a storage error in the footer,
the empty state, the sticky note at rest and on hover. At 320 and 360 px the document is exactly as
wide as the window. Every target is at least 32 x 32 px.

Fixed in the review of the build: on hover the row's meta (progress, time) peeked out beside the
tools; it now fades out under them, and the tools cover the full row height. At 320 px a notice
next to "Not saved" broke into single letters and pushed the note's text out; a notice now wraps
its button under the sentence and takes the footer's full width below 480 px. Every scroll area
has the slim scrollbar Hangar uses (`scrollbar-width: thin`, thumb in `--muted`).

Open points: filtering by color costs one click more than the old row of dots; menus have no
closing animation.
