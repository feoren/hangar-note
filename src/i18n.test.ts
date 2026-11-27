import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DICTIONARIES,
  detectLanguage,
  isLanguage,
  LANGUAGE_NAMES,
  LANGUAGES,
  placeholders,
  translate,
  type MessageKey,
} from "./i18n";

const de = DICTIONARIES.de;
/** U+2013 and U+2014, built from their codes so this file does not contain them. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const deKeys = Object.keys(de).sort();

describe("dictionaries", () => {
  it("name the sidebar's project list apart from the Project level in every language", () => {
    for (const language of LANGUAGES) {
      const words = DICTIONARIES[language];
      expect(words["nav.projects"], language).not.toBe(words["level.project"]);
    }
  });

  it("exist for the twelve languages of Hangar and only for those", () => {
    expect([...LANGUAGES].sort()).toEqual(
      ["de", "el", "en", "es", "fr", "it", "ja", "pl", "pt", "ru", "tr", "zh"].sort(),
    );
    expect(Object.keys(DICTIONARIES).sort()).toEqual([...LANGUAGES].sort());
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LANGUAGES].sort());
  });

  it("have exactly the keys of the German one in every language", () => {
    for (const language of LANGUAGES) {
      expect(Object.keys(DICTIONARIES[language]).sort(), language).toEqual(deKeys);
    }
  });

  it("have no empty text and the same placeholders as German", () => {
    for (const language of LANGUAGES) {
      const dictionary: Record<MessageKey, string> = DICTIONARIES[language];
      for (const [key, source] of Object.entries(de)) {
        const text = Object.entries(dictionary).find(([other]) => other === key)?.[1] ?? "";
        expect(text.trim(), `${language} ${key}`).not.toBe("");
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(source));
      }
    }
  });

  it("use no en or em dash", () => {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(DICTIONARIES[language])) {
        expect(DASHES.test(text), `${language} ${key}`).toBe(false);
      }
    }
  });

  it("address the reader with du in German", () => {
    const texts = Object.values(de).join(" ");
    expect(texts).not.toMatch(/\b(Sie|Ihre?n?)\b/);
    expect(texts).toMatch(/\bVersuch es\b|\bLeg\b|\bTipp\b/);
  });

  it("translate every key the code uses", () => {
    const used = new Set<string>();
    const dir = join(import.meta.dirname, ".");
    for (const file of readdirSync(dir)) {
      if (!/\.tsx?$/.test(file) || file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
        continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/\bt\("([\w.]+)"/g)) used.add(match[1] ?? "");
    }
    expect(used.size).toBeGreaterThan(20);
    for (const key of used) expect(deKeys, key).toContain(key);
  });
});

describe("translate", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(translate("de", "notes.noHits", { query: "Milch" })).toBe(
      "Keine Notiz enthält „Milch“.",
    );
    expect(translate("en", "notes.deletedAgo")).toBe("Deleted {time}");
  });
});

describe("detectLanguage", () => {
  it("uses the primary subtag and falls back to English", () => {
    expect(detectLanguage("de-AT")).toBe("de");
    expect(detectLanguage("pt-BR")).toBe("pt");
    expect(detectLanguage("zh-Hant-TW")).toBe("zh");
    expect(detectLanguage("nl")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
    expect(isLanguage("ja")).toBe(true);
    expect(isLanguage("xx")).toBe(false);
  });
});
