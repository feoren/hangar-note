import { describe, expect, it } from "vitest";

import { resolveLanguage, resolveTheme, trayLabels } from "./appSettings";
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
    });
  });
});
