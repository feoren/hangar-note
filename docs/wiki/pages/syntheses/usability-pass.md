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

## Rework of direction A

Findings of the acceptance review of direction A, fixed on 2026-11-26.

| Finding | Change | Reason |
| --- | --- | --- |
| The title stood twice: large above the text and again as its first line. | The large title is left out when the note's title follows its first line (a new note, "Note 3", an automatic title) or when the first line reads as the title (`titleFromText`). F2 and "Rename" still show the title field. | One title is enough; the first line is the title the person wrote. |
| The warning on leaving an unsaved note was three sentences long and began with "Not saved", which the footer already says. | `notes.leaveUnsaved` is one short sentence in all 12 languages ("Switching again discards the change."); "Copy as Markdown" stays. | Two lines at most at 980 px; the footer and the button say the rest. |
| The focus fell to the page after "Back" from the trash or the settings, and when a notice went while one of its buttons had it. | Back from the trash or the settings, the focus returns to the control they were opened from (the title menu; in the hangar look the sidebar entry), else to the open note or its row. A notice that goes while its button has the focus hands it to the editor, else to the current row (`NoticeSlot`, `onFocusLost`). | Keyboard users never start over at the top of the page. |
| A note on the desktop showed only "On the desktop", and the footer stayed open. | The panel names the note above the hint, and the footer folds away as with no note open. | The person sees which note it is; an empty footer says nothing. |
| A new note appeared in the list only after leaving it. This was the same before direction A: the backend does not announce a note the notes area created itself. | The list and the scope counts load again as soon as the note exists. | What you just wrote is where you look for it. |
| The trash rows looked unlike the list (a filled box, "Deleted: 3 hours ago"). | The color is the list's 3 px edge, the time reads as in the list; the full sentence stays for screen readers and the tooltip. | One way to show a note everywhere. |
| In "All notes" a row did not say which project it belongs to. | Only in "All notes" (and in a search, which spans all notes) the second line of a row starts with the project, small; in a chosen scope it does not. Cards of the paper look name it in their footer line. | In the meta line on the right it squeezed titles to a few letters. |

## Looks B and C as built

The looks "Paper" (B) and "Hangar" (C) of [[0004-switchable-looks]], built on 2026-11-26 next to
"Calm" (A). One logic, three layouts:

- `src/useNotesArea.tsx` holds everything the notes area does: state, saving and leaving (with
  the second try within 10 s), notices, error sentences, menus and keys. It returns a model; the
  layouts only lay it out.
- `src/CalmLayout.tsx`, `src/PaperLayout.tsx` and `src/HangarLayout.tsx` are the three layouts;
  `src/NoteParts.tsx` holds the parts they share (search, row, page, footer state, messages).
- `src/looks.ts` names the looks and picks the layout for a window width; `settings.json` stores
  `look` (`calm`, `paper`, `hangar`; an unknown value reads as `calm`).
- Switching the look in the settings takes effect at once in every window. The open note, its
  unsaved text and its pending save stay; the notes area makes its editor again in the new layout
  with the text and the focus, and the sticky note keeps its editor element and with it the
  cursor.

| Area | Paper (B) | Hangar (C) |
| --- | --- | --- |
| Layout | Cards in a grid on the table surface (`--table`), row by row in the list's order, so Tab and the arrow keys follow the reading order. One column below 560 px. | Three columns: scopes and colors as fixed rows with counts, "Recently deleted" and "Settings" in the sidebar; the dense list; the note in its own color. Below 760 px calm's narrow layout. |
| Finding | Search, "New note" (the main button) and "…" (recently deleted, notes folder, always on top, settings) in the top row; scopes as tabs and the eight colors in one row; "All colors" keeps a reserved place (a cross below 560 px). | Search above the list; the color rows choose several colors; "All colors" keeps its place next to the heading "Colors". |
| A note | Opens as a sheet over the grid (`role="dialog"`, modal, Tab stays inside, the grid is inert). Escape, the cross or a click beside it closes it; the focus returns to its card. The colors are a radio group in the sheet's head. | Title (click or F2 renames), progress, the color dot (opens the colors), preview, "On the desktop" and "…" in the note's header. |
| Checklists | Ticked on the card. The open note ticks through its editor; any other note is read whole from disk and written only if the line still reads as the card showed it; a note on the desktop is never written from here; ticks run one after the other. | In the note, as in A. |
| Notices | The sheet's footer while a sheet is open, else one toast above the grid's free bottom. | The status bar, which also shows the scope, the words, the save state (a green dot) and F2, Delete or Ctrl+Shift+N. |
| Sticky note | A fixed header in the note's header tone (the drag region) and a formatting bar that floats as a pill over the text's bottom edge while you write or point at the note. | Title and checklist progress in the header (the drag region), the formatting bar with the save state at the bottom. |
| Motion | A card lifts 2 px on hover (pointer devices only); the sheet 240 ms opacity and scale from 0.96; the toast 200 ms from below; with reduced motion sheet and toast only fade in 120 ms and nothing lifts. | Color changes only, 100 ms. |

Every look keeps every function: the row's context menu (right click, menu key, Shift+F10) with
the colors, on the desktop, rename, copy, export, show in Explorer and delete exists on every row
and card; Delete with "Undo" works in each. Tests run the shared behaviour once per look (saving
before switching, leaving on the second try, read only, one editor per note, delete and undo).

Contrast (`colors.test.ts`, both themes): text and muted text at least 4.5 : 1 on `--bg`,
`--panel`, `--panel-raised`, `--hover`, `--selected` and `--table`; the accent at 3 : 1 on all of
them and at 4.5 : 1 where it is text (link buttons on `--bg`, `--panel` and `--table`); every note
edge at 3 : 1 on the table and on a chosen row; a card's color strip and its focus ring at 3 : 1
on the card. The accent missed 4.5 : 1 on the light Lilac header tone (4.38), so links in the
sheet's footer use the note's text color, underlined; link buttons underline on hover instead of
taking a hover surface, where the light accent fell to 4.30.

Checked in the real window (debug build against a copy of the sample notes and an empty notes
root): wide (1000 x 680) and narrow (360 x 680, 320 x 680) in light and dark, menus open, a
storage error ("denied", a read-only file in the copy), the empty state, the sticky note while
writing, the settings with the three look cards, the trash. In every view the document is exactly
as wide as the window. Found and fixed there: the new button of the hangar sidebar cut its label
for the shortcut (the shortcut moved to the tooltip and the status bar); the project name in the
meta line squeezed titles (it moved to the second line); the reserved "All colors" in narrow paper
broke into a line of its own; in a narrow sheet the close button fell to a second line on the
left; the color dot in the hangar header vanished on its own header tone (it is the edge tone now,
with a ring in the text color).

Found and fixed in the acceptance review of B and C (real window, real mouse): a note opened
while a tick on its card was still being written showed the text without the tick, and its next
save dropped the tick; opening, "On the desktop", the file actions and delete now wait for the
ticks. Between 560 and about 800 px the paper scopes broke into a column beside the colors (the
colors take their own line now). Between 760 and about 1000 px the hangar note header pushed "…"
out of the window and hid the title (a container query keeps "On the desktop" as an icon and drops
the header's progress, which the status bar shows). The sheet's focus trap wrapped to the first
color instead of the chosen one.

Open points: the paper grid is row by row, not masonry, so short cards leave gaps beside taller
ones; the sheet closes without motion, as the menus do.

## Rework of looks B and C

Findings of the acceptance review of B and C, fixed on 2026-11-26.

| Finding | Change | Reason |
| --- | --- | --- |
| Paper: every card body faded out at its bottom, so the last lines of a card that fit ("Einkaufen" with six tasks) were half gone. | The fade (`.card-body.is-cut`) is set only when the body really overflows (`scrollHeight > clientHeight`), measured before the paint and again on every size change (`ResizeObserver`). In a cut body, a line whose middle lies in the fade or below is no Tab stop. | A list that fits must be read in full; a checkbox nobody can see must not take the focus. |
| Hangar: the checklist progress stood in the note's header and in the status bar. | The header shows it; the status bar only while the note column is 320 px or narrower, where the header has no room (`NARROW_NOTE`, measured on the column, in place of the container rule). | Shown once, never twice and never not at all. |
| The trash was calm's single column in every look. | Hangar shows it in the place of the list and the note; the sidebar stays with "Recently deleted" marked (`aria-current="page"`), a scope or a color there leads back to the notes, and the status bar says where you are. Paper lays it on its table (`--table`). Escape leaves it in every look, wherever the focus is, and the focus returns to the control it was opened from. | The trash is a place inside the look, not a different app. |
| Paper: up and down in the grid moved one card, like left and right. | Up and down move by the grid's current column count (read from `grid-template-columns`), down onto a shorter last row lands on its last card; Home and End go to the first and the last card. | The grid reads in rows and columns, so the keys should too. |
| Every sticky window was called "Hangar Note" in the taskbar and in Alt+Tab. | A sticky window is titled "<note title> · Hangar Note" (`sticky_title` in `src-tauri/src/windows.rs`), set when it opens and again after every rename, by the person or by the title following the first line; without a title it reads "Note · Hangar Note" in the chosen language (the provisional title the windows hand over with the tray texts, also where there is no tray). Only the title, never the text; control characters become spaces, direction characters go, and the title is cut to 60 characters with an ellipsis. | Several sticky notes must be told apart where windows are switched, without the taskbar showing more than the note list does. |

Checked in the real window (debug build against a copy of the sample notes with a sixth task in
"Einkaufen" and eight in "Release 1.4"): six tasks shown in full without a fade, eight cut with the
last three out of Tab; three columns at 1000 px and the keys moving by three; the progress in the
hangar header at a 496 px column and in the status bar at 296 px; the trash in all three looks and
Escape back to its opener; the sticky window's title before, during and after a rename.

Open points: in the hangar trash the shown scope stays marked next to "Recently deleted", since
the trash lists that scope's notes; a note renamed outside Hangar Note (by Hangar) keeps its old
window title until the next rename here or a change of language.
