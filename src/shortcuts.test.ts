import { describe, expect, it } from "vitest";

import { createTranslator } from "./i18n";
import {
  hubShortcutLabel,
  isBrowserKey,
  letterOf,
  levelShortcutLabel,
  matchHubShortcut,
  matchLevelShortcut,
  matchNoteShortcut,
  matchRowShortcut,
  matchSidebarShortcut,
  platformOf,
  shortcutLabel,
  sidebarShortcutLabel,
  sidebarTarget,
  tabTarget,
  type Platform,
} from "./shortcuts";

interface Press {
  key?: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function press(p: Press) {
  return {
    key: p.key ?? "",
    code: p.code ?? "",
    ctrlKey: p.ctrl ?? false,
    shiftKey: p.shift ?? false,
    altKey: p.alt ?? false,
    metaKey: p.meta ?? false,
  };
}

describe("matchNoteShortcut", () => {
  const cases: [Platform, Press, ReturnType<typeof matchNoteShortcut>][] = [
    ["windows", { key: "n", code: "KeyN", ctrl: true }, "newNote"],
    ["windows", { key: "b", code: "KeyB", ctrl: true }, "bold"],
    ["windows", { key: "i", code: "KeyI", ctrl: true }, "italic"],
    ["windows", { key: "X", code: "KeyX", ctrl: true, shift: true }, "strike"],
    ["linux", { key: "b", code: "KeyB", ctrl: true }, "bold"],
    ["mac", { key: "b", code: "KeyB", meta: true }, "bold"],
    ["mac", { key: "x", code: "KeyX", meta: true, shift: true }, "strike"],
    // Lists need Shift: Ctrl+8 and Ctrl+9 stay free. With Shift, a German layout types "(" and ")".
    ["windows", { key: "(", code: "Digit8", ctrl: true, shift: true }, "bullet"],
    ["windows", { key: ")", code: "Digit9", ctrl: true, shift: true }, "task"],
    ["mac", { key: "*", code: "Digit8", meta: true, shift: true }, "bullet"],
    ["windows", { key: "Escape", code: "Escape" }, "leave"],
  ];

  it.each(cases)("%s %j is %s", (platform, keys, action) => {
    expect(matchNoteShortcut(press(keys), platform)).toBe(action);
  });

  it("leaves everything else to the editor", () => {
    const none: [Platform, Press][] = [
      // Plain typing, also of the letters the shortcuts use.
      ["windows", { key: "b", code: "KeyB" }],
      ["windows", { key: "B", code: "KeyB", shift: true }],
      // Ctrl+X alone is cut, Ctrl+Shift+B nothing of ours.
      ["windows", { key: "x", code: "KeyX", ctrl: true }],
      ["windows", { key: "B", code: "KeyB", ctrl: true, shift: true }],
      // AltGr is Ctrl+Alt on Windows: it types characters, never a shortcut.
      ["windows", { key: "b", code: "KeyB", ctrl: true, alt: true }],
      // The other platform's modifier.
      ["mac", { key: "b", code: "KeyB", ctrl: true }],
      ["windows", { key: "b", code: "KeyB", meta: true }],
      // Escape with a modifier, Ctrl+A, Ctrl+Z stay with the editor.
      ["windows", { key: "Escape", code: "Escape", shift: true }],
      ["windows", { key: "a", code: "KeyA", ctrl: true }],
      ["windows", { key: "z", code: "KeyZ", ctrl: true }],
      // Digits without Shift, and AltGr with a digit (types "[" or "]" on a German layout).
      ["windows", { key: "8", code: "Digit8", ctrl: true }],
      ["windows", { key: "[", code: "Digit8", ctrl: true, alt: true }],
      ["windows", { key: "(", code: "Digit8", ctrl: true, alt: true, shift: true }],
    ];
    for (const [platform, keys] of none) {
      expect(matchNoteShortcut(press(keys), platform), JSON.stringify(keys)).toBeNull();
    }
  });

  it("follows the letter the layout types, so Dvorak finds its own B", () => {
    // Dvorak puts B where QWERTY has N, and X where QWERTY has B.
    expect(matchNoteShortcut(press({ key: "b", code: "KeyN", ctrl: true }), "windows")).toBe(
      "bold",
    );
    expect(matchNoteShortcut(press({ key: "n", code: "KeyL", ctrl: true }), "windows")).toBe(
      "newNote",
    );
    expect(
      matchNoteShortcut(press({ key: "X", code: "KeyB", ctrl: true, shift: true }), "windows"),
    ).toBe("strike");
    // German QWERTZ: the Z key where QWERTY has Y is undo, not anything of ours.
    expect(matchNoteShortcut(press({ key: "z", code: "KeyY", ctrl: true }), "windows")).toBeNull();
  });

  it("falls back to the key position on layouts without Latin letters", () => {
    // Russian JCUKEN types "и" on the B key, "ш" on the I key, "ч" on the X key.
    expect(matchNoteShortcut(press({ key: "и", code: "KeyB", ctrl: true }), "windows")).toBe(
      "bold",
    );
    expect(matchNoteShortcut(press({ key: "ш", code: "KeyI", ctrl: true }), "linux")).toBe(
      "italic",
    );
    expect(
      matchNoteShortcut(press({ key: "Ч", code: "KeyX", ctrl: true, shift: true }), "windows"),
    ).toBe("strike");
    // Greek, AltGr held: still never a shortcut.
    expect(
      matchNoteShortcut(press({ key: "β", code: "KeyB", ctrl: true, alt: true }), "windows"),
    ).toBeNull();
  });
});

describe("letterOf", () => {
  it("prefers the typed Latin letter and falls back to the position", () => {
    expect(letterOf({ key: "B", code: "KeyN" })).toBe("b");
    expect(letterOf({ key: "и", code: "KeyB" })).toBe("b");
    expect(letterOf({ key: "ß", code: "Minus" })).toBeNull();
    expect(letterOf({ key: "8", code: "Digit8" })).toBeNull();
  });
});

describe("isBrowserKey", () => {
  it("catches reloading and printing", () => {
    const caught: [Platform, Press][] = [
      ["windows", { key: "F5", code: "F5" }],
      ["windows", { key: "F5", code: "F5", ctrl: true }],
      ["windows", { key: "F5", code: "F5", shift: true }],
      ["windows", { key: "r", code: "KeyR", ctrl: true }],
      ["windows", { key: "R", code: "KeyR", ctrl: true, shift: true }],
      ["windows", { key: "p", code: "KeyP", ctrl: true }],
      ["linux", { key: "P", code: "KeyP", ctrl: true, shift: true }],
      ["mac", { key: "r", code: "KeyR", meta: true }],
      // The find bar.
      ["windows", { key: "f", code: "KeyF", ctrl: true }],
      ["windows", { key: "F", code: "KeyF", ctrl: true, shift: true }],
      ["mac", { key: "f", code: "KeyF", meta: true }],
      ["windows", { key: "F3", code: "F3" }],
      ["windows", { key: "F3", code: "F3", shift: true }],
      // Dvorak types P where QWERTY has R, and the Cyrillic layout "к" on the R key.
      ["windows", { key: "p", code: "KeyR", ctrl: true }],
      ["windows", { key: "к", code: "KeyR", ctrl: true }],
    ];
    for (const [platform, keys] of caught) {
      expect(isBrowserKey(press(keys), platform), JSON.stringify(keys)).toBe(true);
    }
  });

  it("leaves typing, editing and AltGr alone", () => {
    const free: [Platform, Press][] = [
      ["windows", { key: "r", code: "KeyR" }],
      ["windows", { key: "P", code: "KeyP", shift: true }],
      ["windows", { key: "c", code: "KeyC", ctrl: true }],
      ["windows", { key: "v", code: "KeyV", ctrl: true }],
      // Dvorak types L where QWERTY has P: Ctrl+L there is not printing.
      ["windows", { key: "l", code: "KeyP", ctrl: true }],
      ["windows", { key: "r", code: "KeyR", ctrl: true, alt: true }],
      ["windows", { key: "F5", code: "F5", alt: true }],
      ["mac", { key: "r", code: "KeyR", ctrl: true }],
      ["windows", { key: "f", code: "KeyF" }],
      // Dvorak types U where QWERTY has F: Ctrl+U there is not searching.
      ["windows", { key: "u", code: "KeyF", ctrl: true }],
      ["windows", { key: "f", code: "KeyF", ctrl: true, alt: true }],
    ];
    for (const [platform, keys] of free) {
      expect(isBrowserKey(press(keys), platform), JSON.stringify(keys)).toBe(false);
    }
  });
});

describe("shortcutLabel", () => {
  it("names the keys in the UI language and as symbols on macOS", () => {
    const de = createTranslator("de");
    const en = createTranslator("en");
    expect(shortcutLabel("bold", "windows", de)).toBe("Strg+B");
    expect(shortcutLabel("strike", "windows", de)).toBe("Strg+Umschalt+X");
    expect(shortcutLabel("newNote", "linux", en)).toBe("Ctrl+N");
    expect(shortcutLabel("strike", "mac", en)).toBe("⇧⌘X");
    expect(shortcutLabel("bullet", "windows", de)).toBe("Strg+Umschalt+8");
    expect(shortcutLabel("task", "mac", en)).toBe("⇧⌘9");
  });

  it("tells the platform from the user agent", () => {
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130")).toBe("windows");
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});

describe("notes area shortcuts", () => {
  it("start a quick note with Ctrl+Shift+N and rename with F2", () => {
    expect(
      matchHubShortcut(press({ key: "N", code: "KeyN", ctrl: true, shift: true }), "windows"),
    ).toBe("quickNote");
    expect(
      matchHubShortcut(press({ key: "N", code: "KeyN", meta: true, shift: true }), "mac"),
    ).toBe("quickNote");
    expect(matchHubShortcut(press({ key: "F2", code: "F2" }), "linux")).toBe("rename");
  });

  it("leave everything else to the text fields", () => {
    // Ctrl+N alone stays free, and AltGr (Ctrl+Alt) never triggers a shortcut.
    expect(matchHubShortcut(press({ key: "n", code: "KeyN", ctrl: true }), "windows")).toBeNull();
    expect(
      matchHubShortcut(
        press({ key: "N", code: "KeyN", ctrl: true, shift: true, alt: true }),
        "windows",
      ),
    ).toBeNull();
    expect(matchHubShortcut(press({ key: "F2", code: "F2", shift: true }), "windows")).toBeNull();
    // On a Cyrillic layout the key position counts.
    expect(
      matchHubShortcut(press({ key: "Т", code: "KeyN", ctrl: true, shift: true }), "linux"),
    ).toBe("quickNote");
  });

  it("name their keys", () => {
    const de = createTranslator("de");
    expect(hubShortcutLabel("quickNote", "windows", de)).toBe("Strg+Umschalt+N");
    expect(hubShortcutLabel("quickNote", "mac", de)).toBe("⇧⌘N");
    expect(hubShortcutLabel("rename", "windows", de)).toBe("F2");
  });
});

describe("row shortcuts", () => {
  it("delete with Delete and open the row menu with the menu key or Shift+F10", () => {
    expect(matchRowShortcut(press({ key: "Delete", code: "Delete" }))).toBe("delete");
    expect(matchRowShortcut(press({ key: "ContextMenu", code: "ContextMenu" }))).toBe("menu");
    expect(matchRowShortcut(press({ key: "F10", code: "F10", shift: true }))).toBe("menu");
  });

  it("leave other keys and modified ones alone", () => {
    expect(matchRowShortcut(press({ key: "F10", code: "F10" }))).toBeNull();
    expect(
      matchRowShortcut(press({ key: "F10", code: "F10", shift: true, ctrl: true })),
    ).toBeNull();
    expect(matchRowShortcut(press({ key: "Delete", code: "Delete", shift: true }))).toBeNull();
    expect(matchRowShortcut(press({ key: "Delete", code: "Delete", ctrl: true }))).toBeNull();
    expect(matchRowShortcut(press({ key: "Backspace", code: "Backspace" }))).toBeNull();
    expect(matchRowShortcut(press({ key: "Enter", code: "Enter" }))).toBeNull();
  });
});

describe("level and sidebar shortcuts", () => {
  it("choose a level with Ctrl+1 to Ctrl+3, by the key's position", () => {
    expect(matchLevelShortcut(press({ key: "1", code: "Digit1", ctrl: true }), "windows")).toBe(1);
    expect(matchLevelShortcut(press({ key: "3", code: "Digit3", ctrl: true }), "linux")).toBe(3);
    expect(matchLevelShortcut(press({ key: "2", code: "Digit2", meta: true }), "mac")).toBe(2);
    // French layout: the digit row types "&" without Shift; the position still counts.
    expect(matchLevelShortcut(press({ key: "&", code: "Digit1", ctrl: true }), "windows")).toBe(1);
  });

  it("leave Ctrl+0, Ctrl+4 and up, Ctrl+Shift+digit, AltGr and plain digits alone", () => {
    for (const digit of ["0", "4", "9"]) {
      expect(
        matchLevelShortcut(press({ key: digit, code: `Digit${digit}`, ctrl: true }), "windows"),
      ).toBeNull();
    }
    // Ctrl+Shift+8 and 9 are the editor's lists.
    expect(
      matchLevelShortcut(press({ key: "(", code: "Digit9", ctrl: true, shift: true }), "windows"),
    ).toBeNull();
    expect(
      matchLevelShortcut(press({ key: "!", code: "Digit1", ctrl: true, shift: true }), "windows"),
    ).toBeNull();
    expect(
      matchLevelShortcut(press({ key: "2", code: "Digit2", ctrl: true, alt: true }), "windows"),
    ).toBeNull();
    expect(matchLevelShortcut(press({ key: "2", code: "Digit2" }), "windows")).toBeNull();
    expect(matchLevelShortcut(press({ key: "2", code: "Digit2", ctrl: true }), "mac")).toBeNull();
    expect(matchLevelShortcut(press({ key: "a", code: "KeyA", ctrl: true }), "windows")).toBeNull();
  });

  it("show or fold the sidebar with Ctrl+Shift+S, never with Ctrl+B (bold) or Ctrl+S", () => {
    const sidebar = (p: Press, platform: Platform = "windows") =>
      matchSidebarShortcut(press(p), platform);
    expect(sidebar({ key: "S", code: "KeyS", ctrl: true, shift: true })).toBe(true);
    expect(sidebar({ key: "S", code: "KeyS", meta: true, shift: true }, "mac")).toBe(true);
    // Cyrillic layout: the key's position counts.
    expect(sidebar({ key: "Ы", code: "KeyS", ctrl: true, shift: true }, "linux")).toBe(true);
    expect(sidebar({ key: "s", code: "KeyS", ctrl: true })).toBe(false);
    expect(sidebar({ key: "b", code: "KeyB", ctrl: true })).toBe(false);
    expect(sidebar({ key: "S", code: "KeyS", ctrl: true, shift: true, alt: true })).toBe(false);
    expect(sidebar({ key: "S", code: "KeyS", ctrl: true, shift: true }, "mac")).toBe(false);
    // The editor's and the notes area's own keys are not the sidebar's.
    const shiftS = press({ key: "S", code: "KeyS", ctrl: true, shift: true });
    expect(matchNoteShortcut(shiftS, "windows")).toBeNull();
    expect(matchHubShortcut(shiftS, "windows")).toBeNull();
    expect(isBrowserKey(shiftS, "windows")).toBe(false);
  });

  it("move between the level tabs with Left, Right, Home and End, wrapping at the ends", () => {
    const key = (name: string) => press({ key: name });
    expect(tabTarget(key("ArrowRight"), 0, 3)).toBe(1);
    expect(tabTarget(key("ArrowRight"), 2, 3)).toBe(0);
    expect(tabTarget(key("ArrowLeft"), 0, 3)).toBe(2);
    expect(tabTarget(key("Home"), 2, 3)).toBe(0);
    expect(tabTarget(key("End"), 0, 3)).toBe(2);
    expect(tabTarget(key("ArrowDown"), 1, 3)).toBeNull();
    expect(tabTarget(press({ key: "ArrowRight", shift: true }), 1, 3)).toBeNull();
    expect(tabTarget(key("ArrowRight"), 0, 0)).toBeNull();
  });

  it("name their keys", () => {
    const de = createTranslator("de");
    expect(levelShortcutLabel(3, "windows", de)).toBe("Strg+3");
    expect(levelShortcutLabel(1, "mac", de)).toBe("⌘1");
    expect(sidebarShortcutLabel("windows", de)).toBe("Strg+Umschalt+S");
    expect(sidebarShortcutLabel("mac", de)).toBe("⇧⌘S");
  });

  it("move through the entries with the arrow keys, Home and End, wrapping at the ends", () => {
    const key = (k: string, extra: Press = {}) => press({ key: k, ...extra });
    expect(sidebarTarget(key("ArrowDown"), 0, 4)).toBe(1);
    expect(sidebarTarget(key("ArrowRight"), 3, 4)).toBe(0);
    expect(sidebarTarget(key("ArrowUp"), 0, 4)).toBe(3);
    expect(sidebarTarget(key("ArrowLeft"), 2, 4)).toBe(1);
    expect(sidebarTarget(key("Home"), 2, 4)).toBe(0);
    expect(sidebarTarget(key("End"), 0, 4)).toBe(3);
    // From outside the entries the first or the last one.
    expect(sidebarTarget(key("ArrowDown"), -1, 4)).toBe(0);
    expect(sidebarTarget(key("ArrowUp"), -1, 4)).toBe(3);
    expect(sidebarTarget(key("Enter"), 0, 4)).toBeNull();
    expect(sidebarTarget(key("ArrowDown", { shift: true }), 0, 4)).toBeNull();
    expect(sidebarTarget(key("ArrowDown"), 0, 0)).toBeNull();
  });
});
