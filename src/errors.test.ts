import { describe, expect, it } from "vitest";

import { STORAGE_ERRORS, storageErrorText } from "./api";
import { errorActionLabel, errorMessage, type ErrorAction } from "./errors";
import { DICTIONARIES, LANGUAGES } from "./i18n";

describe("error messages", () => {
  it("give every storage code its sentence from api.ts", () => {
    for (const code of STORAGE_ERRORS) {
      for (const context of ["save", "action"] as const) {
        expect(errorMessage(code, context)?.key, code).toBe(storageErrorText(code));
      }
    }
  });

  it("offer at most one helpful button, and only where it helps", () => {
    expect(errorMessage("denied", "save")?.action).toBe("openFolder");
    expect(errorMessage("not-found", "action")?.action).toBe("reload");
    expect(errorMessage("io", "save")?.action).toBe("retry");
    expect(errorMessage("io", "action")?.action).toBeNull();
    expect(errorMessage("disk-full", "save")?.action).toBeNull();
    expect(errorMessage("too-large", "save")?.action).toBeNull();
  });

  it("say nothing for read only, which has its own calm hint", () => {
    expect(errorMessage("read-only", "save")).toBeNull();
    expect(errorMessage("read-only", "action")).toBeNull();
  });

  it("know the fixed codes of the windows", () => {
    expect(errorMessage("not-saved", "action")).toEqual({ key: "notes.notSaved", action: null });
    expect(errorMessage("on-desktop", "save")?.key).toBe("error.onDesktop");
  });

  it("never show the backend's own text, a path or an exception", () => {
    for (const error of [
      "Note not found: C:\\Users\\x\\notes\\a.md",
      new Error("EACCES /home/x/notes"),
      undefined,
      42,
      "",
    ]) {
      expect(errorMessage(error, "save")).toEqual({ key: "note.saveFailed", action: "retry" });
      expect(errorMessage(error, "action")).toEqual({ key: "error.failed", action: null });
    }
  });

  it("have plain sentences without placeholders in every language", () => {
    const keys = new Set(
      ["denied", "not-saved", "on-desktop", "io", "x"].flatMap((error) =>
        (["save", "action"] as const).map((context) => errorMessage(error, context)?.key),
      ),
    );
    const actions: ErrorAction[] = ["openFolder", "reload", "retry"];
    for (const language of LANGUAGES) {
      for (const key of [...keys, ...actions.map(errorActionLabel)]) {
        if (key === undefined) continue;
        const text = DICTIONARIES[language][key];
        expect(text.trim(), `${language} ${key}`).not.toBe("");
        expect(text, `${language} ${key}`).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
