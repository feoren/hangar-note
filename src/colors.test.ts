import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { colorLabelKey, contrastRatio, isNoteColor, NOTE_COLORS, NOTE_TONES } from "./colors";
import { DICTIONARIES } from "./i18n";

describe("note colors", () => {
  it("are the eight colors of ADR 0001, Lemon first", () => {
    expect(NOTE_COLORS).toEqual([
      "lemon",
      "peach",
      "mint",
      "sky",
      "lilac",
      "rose",
      "sand",
      "slate",
    ]);
    expect(isNoteColor("mint")).toBe(true);
    expect(isNoteColor("red")).toBe(false);
  });

  it.each(["light", "dark"] as const)("keep text at 4.5 : 1 in the %s theme", (theme) => {
    for (const color of NOTE_COLORS) {
      const tone = NOTE_TONES[theme][color];
      for (const [name, foreground, background] of [
        ["text on body", tone.text, tone.background],
        ["text on header", tone.text, tone.header],
        ["muted on body", tone.muted, tone.background],
        ["muted on header", tone.muted, tone.header],
        ["link on body", tone.accent, tone.background],
      ] as const) {
        expect(
          contrastRatio(foreground, background),
          `${theme} ${color}: ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(["light", "dark"] as const)(
    "keep their edge at 3 : 1 on every surface of the %s theme",
    (theme) => {
      // The surfaces a row or the open note sits on, read from the tokens themselves.
      const surfaces = chromeTokens(theme);
      for (const color of NOTE_COLORS) {
        for (const surface of ["--bg", "--panel", "--panel-raised", "--hover"] as const) {
          const background = surfaces[surface];
          expect(background, `${theme} ${surface}`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(
            contrastRatio(NOTE_TONES[theme][color].edge, background ?? ""),
            `${theme} ${color} edge on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it("measure the edges of Mint and Sand on the hover surface, which the draft missed", () => {
    expect(contrastRatio(NOTE_TONES.light.mint.edge, "#e6eaef")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(NOTE_TONES.light.sand.edge, "#e6eaef")).toBeGreaterThanOrEqual(3);
  });

  it("stay apart from each other within a theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const backgrounds = NOTE_COLORS.map((color) => NOTE_TONES[theme][color].background);
      expect(new Set(backgrounds).size).toBe(NOTE_COLORS.length);
    }
  });

  it("have a name in every language", () => {
    for (const color of NOTE_COLORS) {
      for (const dictionary of Object.values(DICTIONARIES)) {
        expect(dictionary[colorLabelKey(color)]).toBeTruthy();
      }
    }
  });

  it("measure contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

/** The custom properties of a theme in styles.css: dark in `:root`, light in its own block. */
function chromeTokens(theme: "light" | "dark"): Record<string, string> {
  const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
  const selector = theme === "dark" ? ":root {" : ':root[data-theme="light"] {';
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    Array.from(block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi), (m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  );
}

/** Every surface text and controls sit on, in the three looks (ADR 0004). */
const SURFACES = ["--bg", "--panel", "--panel-raised", "--hover", "--selected", "--table"] as const;

describe.each(["light", "dark"] as const)("the surfaces of the three looks, %s", (theme) => {
  const tokens = chromeTokens(theme);
  const token = (name: string): string => {
    const value = tokens[name];
    expect(value, `${theme} ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    return value ?? "";
  };

  it("keep text and muted text at 4.5 : 1 on each of them", () => {
    for (const surface of SURFACES) {
      for (const foreground of ["--text", "--muted"]) {
        expect(
          contrastRatio(token(foreground), token(surface)),
          `${theme} ${foreground} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keep the accent (focus ring, check marks, chosen card) at 3 : 1 on each of them", () => {
    for (const surface of SURFACES) {
      expect(
        contrastRatio(token("--accent"), token(surface)),
        `${theme} accent on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keep link buttons (the accent as text) at 4.5 : 1 where they sit", () => {
    // Footers on --bg, the status bar and the sidebar on --panel, "All colors" on the table.
    for (const surface of ["--bg", "--panel", "--table"]) {
      expect(
        contrastRatio(token("--accent"), token(surface)),
        `${theme} link on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keep every note color's edge at 3 : 1 on the paper table and a chosen row", () => {
    for (const color of NOTE_COLORS) {
      for (const surface of ["--selected", "--table"]) {
        expect(
          contrastRatio(NOTE_TONES[theme][color].edge, token(surface)),
          `${theme} ${color} edge on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keep the paper toast, the chosen scope tab and the saved dot readable", () => {
    // The toast and a chosen tab turn the colors around: --bg (or the table) on --text.
    expect(contrastRatio(token("--bg"), token("--text"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("--table"), token("--text"))).toBeGreaterThanOrEqual(4.5);
    // The dot of "Saved" in the hangar status bar.
    expect(contrastRatio(token("--ok"), token("--panel"))).toBeGreaterThanOrEqual(3);
  });

  it("keep a card's color strip, its focus ring and the sheet's links visible on the note", () => {
    for (const color of NOTE_COLORS) {
      const tone = NOTE_TONES[theme][color];
      expect(
        contrastRatio(tone.edge, tone.background),
        `${theme} ${color} strip on its card`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(token("--accent"), tone.background),
        `${theme} ${color} focus ring on its card`,
      ).toBeGreaterThanOrEqual(3);
      // The hangar look's color dot in the note's header has a ring in the note's text color
      // (styles.css), which "text on header" above keeps at 4.5 : 1.
      // The sheet's footer is the note's header tone, where the accent misses 4.5 : 1 (light
      // Lilac, 4.38): its link buttons use the note's text color, underlined (styles.css).
      expect(
        contrastRatio(tone.text, tone.header),
        `${theme} ${color} link in the sheet's footer`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
