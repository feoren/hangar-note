import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STORAGE_ERRORS, STORAGE_ERROR_TEXTS, storageError, storageErrorText } from "./api";
import { DICTIONARIES, LANGUAGES, translate } from "./i18n";

describe("storage errors", () => {
  it("are the backend's fixed codes and nothing else", () => {
    const fsio = readFileSync(
      join(import.meta.dirname, "..", "src-tauri", "src", "fsio.rs"),
      "utf8",
    );
    const backend = Array.from(fsio.matchAll(/Self::\w+ => "([a-z-]+)",/g), (m) => m[1]);
    expect([...STORAGE_ERRORS].sort()).toEqual([...backend].sort());
    for (const code of STORAGE_ERRORS) {
      expect(storageError(code)).toBe(code);
    }
    for (const other of ["read-only", "not-saved", "on-desktop", "Note not found", "", null, 5]) {
      expect(storageError(other)).toBeNull();
      expect(storageErrorText(other)).toBeNull();
    }
    expect(storageError(new Error("denied"))).toBeNull();
  });

  it("each get one plain sentence in every language", () => {
    for (const code of STORAGE_ERRORS) {
      const key = storageErrorText(code);
      expect(key).toBe(STORAGE_ERROR_TEXTS[code]);
      if (key === null) continue;
      for (const language of LANGUAGES) {
        const text = DICTIONARIES[language][key];
        expect(text.trim(), `${language} ${code}`).not.toBe("");
        // Never a placeholder for the OS text or a path, and never the bare code.
        expect(text, `${language} ${code}`).not.toMatch(/\{\w+\}/);
        expect(text, `${language} ${code}`).not.toBe(code);
      }
    }
  });

  it("read as agreed in German", () => {
    expect(translate("de", "storage.denied")).toBe(
      "Hangar Note darf diese Datei nicht ändern. Ist sie schreibgeschützt?",
    );
    expect(translate("de", "storage.diskFull")).toBe("Die Festplatte ist voll.");
    expect(translate("de", "storage.io")).toBe(
      "Speichern hat nicht geklappt. Versuch es gleich noch einmal.",
    );
    expect(translate("en", "storage.notFound")).toBe("The file is gone. Was it moved or deleted?");
  });
});
