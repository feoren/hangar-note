// "Keyboard shortcuts" from the app menu's Help: the keys that matter, in a small modal dialog
// (the native <dialog>: Escape closes it and the focus stays inside). The focus goes back to where
// it was when it closes. The hangar look shows the same list while there are no notes.

import { useEffect, useRef } from "react";

import { CloseIcon } from "./icons";
import { levelShortcutLabel, shortcutLabel, sidebarShortcutLabel } from "./shortcuts";
import { PLATFORM, type NotesModel } from "./useNotesArea";

/** The keys and what they do, in the order they matter to someone new. */
export function keyList(m: NotesModel): [string, string][] {
  const { t } = m;
  return [
    [m.quickKeys, t("notes.new")],
    ["F2", t("notes.rename")],
    [t("key.delete"), t("notes.delete")],
    [
      `${levelShortcutLabel(1, PLATFORM, t)} … ${levelShortcutLabel(3, PLATFORM, t)}`,
      `${t("level.private")}, ${t("level.project")}, ${t("level.team")}`,
    ],
    [sidebarShortcutLabel(PLATFORM, t), t("nav.toggle")],
    [shortcutLabel("bold", PLATFORM, t), t("format.bold")],
    [shortcutLabel("italic", PLATFORM, t), t("format.italic")],
    [shortcutLabel("strike", PLATFORM, t), t("format.strike")],
    [shortcutLabel("bullet", PLATFORM, t), t("format.bullet")],
    [shortcutLabel("task", PLATFORM, t), t("format.task")],
  ];
}

export function KeysList({ m }: { m: NotesModel }) {
  return (
    <dl className="keys-list">
      {keyList(m).map(([key, label]) => (
        <div key={key}>
          <dt>
            <kbd>{key}</kbd>
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}

export function KeysDialog({ m, onClose }: { m: NotesModel; onClose: () => void }) {
  const { t } = m;
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    // Where the focus was when it opened (the app menu's button, or in a narrow window the button
    // that brings the sidebar back, as the sidebar over the notes closed for it).
    const before = document.activeElement;
    if (typeof element.showModal === "function" && !element.open) element.showModal();
    return () => {
      const back =
        before instanceof HTMLElement && before.isConnected && before !== document.body
          ? before
          : document.querySelector<HTMLElement>(".menu-button, [data-focus-id='nav']");
      back?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="keys-dialog"
      aria-labelledby="keys-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop (outside the box) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="keys-box">
        <header className="keys-head">
          <h2 id="keys-title">{t("menu.keys")}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("notes.closeSheet")}
            title={t("notes.closeSheet")}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <KeysList m={m} />
      </div>
    </dialog>
  );
}
