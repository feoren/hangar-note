// What the app menu holds (AppMenu.tsx), built from the notes area's state: File, Edit, View, Help.
// Only what works in this window: no item for something the window cannot do (no "Quit": the tray
// quits the app; no cut, copy and paste: the editor's own keys do that, and a menu cannot read the
// clipboard; no "About": the sidebar's header shows the version). Items that need an open note are
// greyed out while none is open.

import type { AppMenuGroup, AppMenuItem } from "./AppMenu";
import { LOOK_NAMES, LOOKS, type Look } from "./looks";
import {
  editShortcutLabel,
  levelShortcutLabel,
  shortcutLabel,
  sidebarShortcutLabel,
} from "./shortcuts";
import { PLATFORM, type NotesModel } from "./useNotesArea";

export interface SidebarState {
  shown: boolean;
  toggle: () => void;
}

/** `showKeys`: Help's "Keyboard shortcuts" (the dialog lives in NotesArea.tsx). */
export function appMenuGroups(
  m: NotesModel,
  side: SidebarState,
  look: Look,
  showKeys: () => void,
): AppMenuGroup[] {
  const { t } = m;
  const separator = (key: string): AppMenuItem => ({ type: "separator", key });
  const exportOpen = m.exportOpen;

  const file: AppMenuItem[] = [
    {
      type: "action",
      label: t("notes.new"),
      shortcut: shortcutLabel("newNote", PLATFORM, t),
      disabled: !m.canCreate,
      run: m.newNote,
    },
    {
      type: "action",
      label: t("notes.export"),
      disabled: exportOpen === null,
      run: () => {
        exportOpen?.();
      },
    },
    { type: "action", label: t("notes.openFolder"), run: m.revealFolder },
    separator("sep-settings"),
    {
      type: "action",
      label: t("notes.settings"),
      run: () => {
        m.openPlace("settings");
      },
    },
  ];

  const edit: AppMenuItem[] = [
    ...(["undo", "redo"] as const).map((command): AppMenuItem => ({
      type: "action",
      label: t(command === "undo" ? "menu.undo" : "menu.redo"),
      shortcut: editShortcutLabel(command, PLATFORM, t),
      disabled: !m.canEdit,
      run: () => {
        m.editNote(command);
      },
    })),
    separator("sep-select"),
    {
      type: "action",
      label: t("menu.selectAll"),
      shortcut: editShortcutLabel("selectAll", PLATFORM, t),
      disabled: !m.canEdit,
      run: () => {
        m.editNote("selectAll");
      },
    },
    separator("sep-find"),
    {
      type: "action",
      label: t("menu.find"),
      disabled: m.emptyMode || m.view !== "browse" || m.level === "team",
      run: m.focusSearch,
    },
  ];

  const view: AppMenuItem[] = [
    {
      type: "action",
      label: t("nav.toggle"),
      shortcut: sidebarShortcutLabel(PLATFORM, t),
      checked: side.shown,
      run: side.toggle,
    },
    separator("sep-levels"),
    ...m.levelTabs.map((tab, index): AppMenuItem => ({
      type: "action",
      label: tab.level === "project" ? t("level.project") : tab.label,
      shortcut: levelShortcutLabel(index + 1, PLATFORM, t),
      checked: m.place === null && m.level === tab.level,
      radio: true,
      run: () => {
        m.chooseLevel(tab.level);
      },
    })),
    separator("sep-looks"),
    ...LOOKS.map((each): AppMenuItem => ({
      type: "action",
      label: t(LOOK_NAMES[each]),
      checked: each === look,
      radio: true,
      run: () => {
        m.chooseLook(each);
      },
    })),
    separator("sep-top"),
    { type: "action", label: t("note.keepOnTop"), checked: m.onTop, run: m.toggleOnTop },
  ];

  return [
    { label: t("menu.file"), items: file },
    { label: t("menu.edit"), items: edit },
    { label: t("menu.view"), items: view },
    {
      label: t("menu.help"),
      items: [{ type: "action", label: t("menu.keys"), run: showKeys }],
    },
  ];
}
