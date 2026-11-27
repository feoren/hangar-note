import { describe, expect, it } from "vitest";

import {
  resolveLanguage,
  resolveTheme,
  settingsWith,
  toggledTheme,
  trayLabels,
} from "./appSettings";
import { createTranslator } from "./i18n";

describe("settings", () => {
  it("follow the system unless chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveLanguage(null, "fr-CA")).toBe("fr");
    expect(resolveLanguage("ja", "fr-CA")).toBe("ja");
    expect(resolveLanguage(null, undefined)).toBe("en");
  });

  it("give the tray its texts in the UI language", () => {
    expect(trayLabels(createTranslator("de"))).toEqual({
      allNotes: "Alle Notizen",
      newNote: "Neue Notiz",
      showAll: "Alle Notizen anzeigen",
      quit: "Beenden",
      tooltip: "Hangar Note",
      untitled: "Notiz",
    });
  });
});

describe("toggledTheme", () => {
  it("chooses the opposite of the shown theme outright, never the system", () => {
    expect(toggledTheme("light")).toBe("dark");
    expect(toggledTheme("dark")).toBe("light");
    // Shown dark because the system is dark: the switch makes it light for good.
    expect(toggledTheme(resolveTheme("system", true))).toBe("light");
  });
});

describe("settingsWith", () => {
  it("keeps every shown setting and applies the change and the look", () => {
    const view = {
      language: "de" as const,
      theme: "dark" as const,
      newNoteColor: "mint" as const,
      colorNames: { sky: "Arbeit" },
      look: "hangar" as const,
    };
    expect(settingsWith(view, "paper", { colorNames: {} })).toEqual({
      language: "de",
      theme: "dark",
      newNoteColor: "mint",
      colorNames: {},
      look: "paper",
    });
  });
});
