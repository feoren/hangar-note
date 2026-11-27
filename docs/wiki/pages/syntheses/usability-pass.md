---
title: Usability pass of the notes area (phase 1)
type: synthesis
tags: [ux, accessibility, notes-area, i18n]
sources: []
created: 2026-11-26
updated: 2026-11-27
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

## Navigation rework

The owner found the notes area hard to get around in: the areas (All, General, the projects) were
hidden behind the title menu, the start area could be an empty "General" while the only note sat
in a project, and a two-line banner explained a read-only state that Hangar Note no longer has
once it controls Hangar's notes ([[0002-hangar-notes-takeover]]). Reworked on 2026-11-26.

| Area | Change | Reason |
| --- | --- | --- |
| Navigation | One sidebar in every look (`src/Sidebar.tsx`, laid out by `src/NotesArea.tsx`): "All notes" and "General" with counts, a section "Projects" with every project that has notes by its folder name (the backend's `name`, tooltip the full path and the shortcut), the eight colors as two rows of 32 px dots, and "Recently deleted" and "Settings" at the bottom. The current place carries `aria-current="page"`, a `--selected` surface and the accent on its icon. The hangar look's own sidebar, calm's title menu, paper's scope tabs and color row and calm's color button are gone; "Open notes folder" and "Always on top" moved to the sidebar's "…". A team section renders once team areas exist. | One visible way around, the same in each look; nothing that navigates hides in a menu. |
| Keyboard | The sidebar is one Tab stop (roving tab index); arrow keys, Home and End move through its entries and wrap (`sidebarTarget` in `src/shortcuts.ts`). Ctrl+1 to Ctrl+9 (Cmd on macOS) choose the areas in the sidebar's order from anywhere, also from the trash (`matchAreaShortcut`); Ctrl+Shift+digit stays the editor's. A color chosen in the trash or the settings leads back to the notes. | No Ctrl+letter is taken; digits are free in CodeMirror. |
| Narrow windows | Below 760 px (`NAV_MIN_WIDTH`) the sidebar folds behind a button at the start of each look's heading and opens as a modal layer over the notes (the notes are `inert`); a choice, Escape, the close button or a click beside it closes it, and the focus returns to the button. The calm look splits list and note from 600 px of room beside the sidebar (a container query on `.shell-main`, not the window); the hangar look needs 840 px (`HANGAR_MIN_WIDTH`) and shows calm's layout below. | The sidebar takes 232 px; the old window widths no longer said how much room the notes have. |
| Heading | Each look's heading is the area's name (`AreaHeading`), with "New note" beside it (a 32 px plus in the dense hangar list). | The place you are in is the heading, as before, now without a menu. |
| Start | Without a project folder the window starts on "All notes"; opened for a project, on that project, which the sidebar lists even while it has no notes. The chosen area is remembered while the app runs (not across restarts: `settings.json` has no field for it yet). | The first view shows every note. |
| Empty | The whole-window invitation shows only while no area has a note. An empty area while others have notes says "No notes in shop yet." with "New note", which writes into that area. | An empty "General" must not look like an empty app. |
| Read only | The banner is gone. While the notes are read only (another writer, or the lock could not be taken) a small "Read only" chip sits beside the heading; its one sentence is its tooltip, its `aria-describedby` and, on a click or Enter, a bubble below it (Escape closes it). | A state, not an event; it needs a word, not a box. |
| Changes outside | The open note shows its file's new text after `notes-changed` without a click while nothing typed waits for its save (same version: nothing happens). A sticky note does the same on `note-changed-outside`; deleted outside, it keeps its text and says so with "Copy as Markdown". With unsaved text the existing `changed` flow asks first. | Hangar and Hangar Note write the same files now. |

Checked in the real window (paper, dark, 996 x 699) and in a browser preview with a mocked
backend (calm, paper and hangar; light and dark; 360, 380, 700, 760, 960 and 1100 px wide; the chip
open; the folded sidebar open). Found and fixed there: the chip's bubble ran out of a narrow window
(it is now bounded by the heading); between 760 and 840 px the hangar note covered its list (the
hangar look now needs 840 px).

Texts dropped as unused: the banner's title, the area menu's name, paper's scope label, the color
filter's button labels, hangar's "Last changed", the old empty-area sentence, the project tooltip,
the "This project" and "All" chip names and "Notes" as a heading.

Open points: the last chosen area is not stored across restarts; colors in the sidebar have no
visible names (their names are the tooltip and the accessible name).

## Levels and a sidebar that folds away

The owner asked on 2026-11-26 for a sidebar that can be folded away and resized, for writing to be
obvious, and for three levels as tabs: private, the project currently open in Hangar, and its team
notes. Hangar Note is meant to replace Hangar's notes area, not to read it.

| Area | Change | Reason |
| --- | --- | --- |
| Levels | A bar above the notes in every look (`src/LevelBar.tsx`): the sidebar button, then one segmented control with the tabs "Private", "Project · name" and "Team" (`role="tablist"`, one Tab stop; Left, Right, Home and End move and choose; Ctrl+1 to Ctrl+3 from anywhere). The chosen tab is lifted onto the page tone. The view below is its `tabpanel`. | One clear hierarchy: level, then heading, search and "New note", then list and note. |
| Project | The project tab names the project Hangar works in (`activeProject` in `src/notesScope.ts`): a project chosen by hand in this session, else the folder Hangar Note was opened for (`--folder`, also forwarded to a running instance, which then switches to it), else `lastProject` from `settings.json`, else the project with the newest note. Its tooltip is the full path. With two or more projects a chevron sits in the tab; a click on the chosen tab, the chevron, Down or Enter open a menu of the projects (radio items with counts). A choice is stored as `lastProject`. | The project follows Hangar, and switching is one click away. |
| Team | The team tab shows one calm empty state: an icon, "Team notes" and one sentence ("Team notes appear here once Hangar is connected."). No list, no search, no "New note", nothing read only. `TeamState` in `src/useNotesArea.tsx` is the seam for the list once Hangar's team routes exist (ADR 0002 phase 2). | No fake data and nothing alarming while the crypto runs through Hangar. |
| Sidebar | "General" left the sidebar (the "Private" tab is it); "All notes" stays as the overview across everything, the projects stay and choose the project in the "Project" level. "General" reads "Private" everywhere (rows in All, the crumb, the trash). | Nothing twice. |
| Folding | The sidebar button (`aria-expanded`, `aria-controls`) and Ctrl+Shift+S fold the sidebar away and back in a 180 ms width transition (a jump with reduced motion); the folded sidebar is `inert`. Stored as `sidebarOpen` in `settings.json` (open by default). Below 760 px the button opens the sidebar over the notes as before, and nothing is stored. Ctrl+B was not taken: it is bold in the editor. | The owner wants the room for writing; the button sits in the same place at every width. |
| Width | The sidebar's right edge is a `role="separator"` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`: dragged with the mouse or a pen (pointer capture, `col-resize`), moved by 8 px with the arrow keys (32 px with Shift), Home and End go to the ends, a double click resets 232 px. Between 180 and 400 px and never more than 40 % of the window (`src/sidebarWidth.ts`); stored as `sidebarWidth` when a drag ends. The hangar look now needs 608 px of room beside the sidebar instead of an 840 px window. | A long project name or a small screen. |
| Writing | "New note" is in every level that can hold notes and writes there; the editor opens with the cursor in the text; Ctrl+Shift+N starts a quick note in the level shown (in Team it does nothing). A "Project" level without any project says how to get one and offers no "New note". | Writing must be obvious and land where the person looks. |
| Start | Opened for a folder, the window starts on the "Project" level; otherwise on "Private", unless it is empty while a project has notes. The first list waits for the folder status, so the window never shows the wrong level first. The chosen level and project are kept while the app runs. | The first view is where the person works. |

Checked with tests (mocked backend, every look) and in a browser preview against Vite with a mocked
Tauri API (calm, paper and hangar; light and dark; 360, 760, 800 and 1100 px; the folded sidebar,
the overlay, the project menu and the team level), and in the real window after hot reload (paper,
dark). `sidebarOpen`, `sidebarWidth` and `lastProject` are stored only by a backend built with this
change; an older one refuses the commands, and the choices then hold while the app runs.

## Colors as a category list, Hangar's header and a clean notes area

The owner found the sidebar's color dots unclear and asked for them to read like a real category
list; in the same pass for Hangar's own sidebar header (menu button, logo, name with version, an
app menu with submenus), the levels inside the sidebar, and no bars beside the notes: "only the
list of notes and the note itself". Reworked on 2026-11-27; it replaces the level bar of the
section above.

| Area | Change | Reason |
| --- | --- | --- |
| Colors | One row per color the shown notes use (`src/sidebarColors.ts`, drawn in `src/Sidebar.tsx`): a 12 px rounded square in the note tone ringed in its edge tone (`noteTone(...).edge`, which keeps 3 : 1 on the panel in both themes), the own name from `colorNames` or the default name, the count on the right, the same row height, hover and selected surface as "All notes". Rows keep the colors' own order, so nothing jumps. A chosen color stays listed even when no shown note has it. "Show all colors" adds the unused ones dimmed and without a count; "Show fewer" hides them again. | A list with names and numbers reads at a glance; dots with tooltips did not. |
| Counts | The counts are those of the shown list (`colorCounts(allRows)`): exactly what the filter would show in the level, in "All notes" every private note, in a search its hits. While a list or a search is on its way the last counts stay. The backend's `FolderInfo` has no colors, so counts per scope beyond the shown list would need a new command; none is shown rather than a wrong one. The team level has no list, so no color section. | Honest numbers. |
| Filter | A click toggles the color (`aria-pressed`, the selected surface and bold); several can be on. "Clear filter" sits in the section's header, its place kept while nothing is chosen. The accessible name is "Yellow, notes: 3, filter on" (`nav.colorNotes`, `nav.colorFilterOn`); "notes: 3" avoids plural forms the i18n module does not have. | A filter state must be heard, not only seen. |
| Section | The heading "Colors" looks like "Projects" with a small chevron (`aria-expanded`) and folds the list away; folded with a filter on, the chosen colors show beside it. Folded and "show all" are remembered while the app runs. | Less in view for those who do not filter by color. |
| Rename | A double click, F2 (`matchColorRowShortcut`) or "Rename" in the row's context menu (right click, the menu key or Shift+F10) turns the row into a field: Enter saves, Escape keeps the name, leaving the field saves. A blank name or the default name gives the default back; "Use the original name" in the context menu does the same. It saves through `settingsWith` (`src/appSettings.ts`), the same path as the settings page, so both stay in sync and every window follows `settings-changed`. | Naming a category where it is, without a trip to the settings. |
| Header | As in Hangar: a 30 px menu button with three lines, the folded N of the app icon (`AppLogo`, its two tones as `--brand-n` and `--brand-mark` per theme), "Hangar Note" bold and below it the version (`src/version.ts`, from `package.json`: `X.Y.Z` now, `X.Y.Z-B` in a release state per [[0003-version-scheme]]) with a "beta" badge while the major version is 0; the fold button at the right end. One line across the whole sidebar below. | The family's look; the version is visible without a dialog. |
| App menu | `src/AppMenu.tsx` and `src/menuNav.ts` taken from Hangar (WAI-ARIA menu pattern: Down opens, Up and Down move, Right, Enter or Space open a submenu, Left closes it, Escape closes one level, Tab all, first letters jump; the focus goes back to the button). File: New note, Export (open note), Open notes folder, Settings. Edit: Undo, Redo, Select all (the editor's CodeMirror commands, greyed out without an open note), Search. View: Sidebar, Private, Project, Team, the three looks, Always on top (checked states as `menuitemcheckbox` and `menuitemradio`). Help: Keyboard shortcuts (a native `<dialog>`, `src/KeysDialog.tsx`). Shortcuts stand right-aligned. No Quit (the tray quits; the notes area may not), no cut, copy and paste (a menu cannot read the clipboard; the keys work), no About (the version is in the header). The panels are `position: fixed`, so the sidebar's edge never cuts them off. | Only what really works. |
| Levels | The segmented control "Private", "Project", "Team" sits in the sidebar under its header, the tabs sharing its width. The project tab just says "Project"; while it is chosen, a quiet line below names the project and, with several, opens the project menu. Choosing a level in the overlay closes it. | The owner wanted the switch in the sidebar; full names would not fit three tabs in 232 px. |
| Notes area | No bar above and no footer or status bar below. The search and "+" (New note, its shortcut in the tooltip) sit at the top of the list column (`ListTop` in `src/NoteParts.tsx`; in paper above the grid); the area's name is an `sr-only` heading. Notices float as one toast at the bottom (`.notice-float`, in paper's open sheet at its bottom). The calm note shows just its text; its small toolbar (back, project, not saved, preview, on the desktop, "…") fades in on hover and focus and stays where there is no hover, while the note is not saved, and when one note fills a narrow window. The hangar look keeps its slim note header, now with the progress always there. Words and "Saved" are gone with the footer; "Not saved" stays visible. | The owner asked for a clean list and a clean note. |
| Folded sidebar | A small 34 px button floats at the top left of the notes (`.side-float`, `data-focus-id="nav"`); below 760 px it opens the overlay. What sits at the top left makes room for it: the list's top, the heading of the trash and the settings with their "Back", and the note's bar while one note fills a narrow room (its "Back" was covered before the acceptance review). Folding moves the focus to that button, opening it back to the sidebar's fold button. Ctrl+Shift+S as before. | No bar is needed to bring the sidebar back. |

Checked with tests (colors: rows, counts, show all, fold and memory, rename by double click, F2,
Enter, Escape and the context menu, arrow-key order; the app menu: structure, keyboard, items;
folding with the focus moves) and in a browser preview against Vite with a mocked Tauri API
(calm, paper and hangar; light and dark; 360, 760 and 1100 px; menu and submenu, the shortcuts
dialog, the inline rename, show all with a filter on, the overlay, the open note, paper's sheet),
and in the real window after hot reload (hangar, dark).

Open points: a release build shows `X.Y.Z-B` only once the release script writes `X.Y.Z+B` into
`package.json` (or the version is read through Tauri's `app` plugin, which needs a capability);
counts per scope beyond the shown list need a backend command with colors per folder; the level is
reachable only through the sidebar (or Ctrl+1 to Ctrl+3) while the sidebar is folded away.

## Look switch, a calmer sidebar and widths that follow the window

The owner asked for a better left sidebar, a quick choice of the look at the top right of the
notes, and for the window's content to use its width instead of narrow columns. Reworked on
2026-11-27.

| Area | Finding | Change | Reason |
| --- | --- | --- | --- |
| Look switch | The look could only be changed in the settings or the app menu. | `src/LookSwitch.tsx`: three 32 px icons (`CalmLookIcon`, `PaperLookIcon`, `HangarLookIcon`) as a `radiogroup` named "Look", each `radio` named and titled after its look, one Tab stop, arrow keys, Home and End move the choice (`radioTarget` in `src/shortcuts.ts`, right-to-left aware). It sits at the top right of the notes in every look: at the right end of calm's note bar (in the list's top row while the list fills a narrow room, `narrowRoom` in `src/looks.ts`), after "+" in paper's top row, at the end of hangar's note header, alone in a small row without an open note and on the team level. Not in the trash and the settings, which have the full choice. Choosing calls `chooseLook`, so the open note and its pending save stay; the new layout's switch takes the focus back (`src/lookFocus.ts`). | One click to the look, in the same place everywhere. |
| Calm note bar | The note's tools only faded in on hover; an open note looked as if it could not be handled. | The bar is always there, its icons muted until hovered, with a color button (the `noteColor` menu, as in hangar) and a thin line before the look switch. Its start lines up with the page. | What a note can do is visible. |
| Widths | The list was fixed at 260 to 320 px (hangar 240 to 296 px), the calm page at 676 px, paper's search at 440 px, the settings at 560 px; wide windows showed a narrow island beside empty room. | List `clamp(280px, 30%, 420px)` in calm and hangar; the page up to 960 px, centered beyond it, its side room `clamp(20px, 3vw, 48px)` (hangar too); paper's search fills its row up to 720 px, cards `minmax(260px, 1fr)`, the sheet up to 880 px; trash and settings use a centered column of 880 px, heading included, the language select up to 420 px. Menus, toasts and dialogs stay narrow. | The window's room goes to the content. |
| Sidebar | "Project" (tab) and "Projects" (section) read as the same thing; headings differed; "Show all colors" was a small link; rows and icons were small. | The section is called "Project folders" in all 12 languages (a test keeps it apart from the tab's name); every heading has the same size, tone, height and spacing; rows are 36 px with 16 px icons, the current one with the selected surface and its icon and count in the accent; "Show all colors" is a normal row with a chevron. The level tabs are equal in width with a mark above the name (person, folder, people), so the names keep the whole tab width. Default width 248 px (front end and `settings.rs`), `HANGAR_MIN_WIDTH` follows it (856 px). | Quick to scan, nothing reads twice. |

Checked with tests (the switch in every look, click, arrow keys, focus after the change, aria; the
section names in every language; `narrowRoom`, `layoutFor` with the new default) and in a browser
preview against Vite with a mocked Tauri API (calm, paper and hangar; light and dark; 360, 760,
1100, 1280 and 1600 px; no horizontal overflow).

Open points: a stored `sidebarWidth` of 232 stays as the person's width; only new settings start at
248 px. A look whose save fails leaves the switch's focus hand-over pending until that look is
chosen again.

## Two looks and a paper sheet only by choice

The owner removed the look "Calm" and asked that paper never opens a note by itself (ADR
[[0004-switchable-looks]], amendment 2026-11-27). Sections above that name calm describe the state
before that day.

| Area | Finding | Change | Reason |
| --- | --- | --- | --- |
| Looks | Three looks, two of them close to each other in wide windows. | Two looks, "Hangar" (default) and "Paper", in the look switch (two icons), the app menu and the settings (two cards). A stored "calm" opens as Hangar. | Fewer choices, each clearly different. |
| Narrow windows | Hangar borrowed calm's layout where its columns did not fit. | The same layout is now Hangar's own (`src/HangarNarrowLayout.tsx`): list or note with "Back" up to 600 px of room, the look switch at the end of the note bar or the list's top row. | Hangar works from 320 px to 2000 px without a second look behind it. |
| Sticky note | Calm hid the header and moved the window by a 10 px strip. | Both looks show the colored header, which always moves the window. | One way to grab a note, easy to find. |
| Paper sheet | Switching to paper with a note open, or coming back from the trash, the settings or another area, showed the note's sheet over the cards. | Paper shows the cards at every such step; the open note is saved first and then closed. Only a card, "+", Ctrl+Shift+N or a request that names a note or brings text opens a sheet. Undo after a delete brings the card back with the focus. A note that cannot be saved stays open with its notice. | The person decides when a sheet covers the cards; no text is lost. |

Checked with tests (looks and `lookOf`, the switch with two radios in every variant, switching to
paper saves and shows the cards, a failing save keeps the sheet, the start with paper, the card
click, new note, Hangar's open request and show project, the way back from the settings, Ctrl+1,
Undo; the backend reads `"calm"` as hangar and writes hangar with the next save) and in a browser
preview against Vite with a mocked Tauri API (hangar at 360, 760, 1100 and 1600 px; paper light
and dark, cards and an opened sheet).

