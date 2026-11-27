import { describe, expect, it, vi } from "vitest";

import {
  countChars,
  countLines,
  createCursorStore,
  cursorStats,
  footerText,
  formatCount,
} from "./cursorStats";
import { createTranslator, LANGUAGES, type Language } from "./i18n";

const THUMBS = String.fromCodePoint(0x1f44d);
/** Man, zero width joiner, woman, joiner, girl: one family, five code points. */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
/** Regional indicators D and E: the German flag, two code points. */
const FLAG = String.fromCodePoint(0x1f1e9, 0x1f1ea);
/** "e" and a combining acute accent. */
const E_ACUTE = `e${String.fromCharCode(0x301)}`;

describe("countChars", () => {
  it("counts plain text by its letters and a CRLF line break once", () => {
    expect(countChars("")).toBe(0);
    expect(countChars("Milch")).toBe(5);
    expect(countChars("Ä ö ß")).toBe(5);
    expect(countChars("a\nb")).toBe(3);
    expect(countChars("a\r\nb")).toBe(3);
    expect(countChars("a\rb")).toBe(3);
    expect(countChars("\r\n\r\n")).toBe(2);
  });

  it("counts every emoji and accented letter once, however many code units it takes", () => {
    expect(countChars(THUMBS)).toBe(1);
    expect(countChars(FAMILY)).toBe(1);
    expect(countChars(FLAG)).toBe(1);
    expect(countChars(E_ACUTE)).toBe(1);
    expect(countChars(`Hi ${THUMBS}${FLAG}!`)).toBe(6);
    expect(countChars(`${FAMILY}\r\n${THUMBS}`)).toBe(3);
  });

  it("counts lines as the joined text would count, one per break", () => {
    expect(countLines([])).toBe(0);
    expect(countLines([""])).toBe(0);
    expect(countLines(["eins", "", THUMBS])).toBe(countChars(`eins\n\n${THUMBS}`));
  });
});

describe("cursorStats", () => {
  it("gives line and column 1-based, at the start, inside and at the end", () => {
    const text = "eins\nzwei\ndrei";
    expect(cursorStats(text, 0, 0)).toEqual({ line: 1, column: 1, selected: 0, length: 14 });
    expect(cursorStats(text, 7, 7)).toEqual({ line: 2, column: 3, selected: 0, length: 14 });
    expect(cursorStats(text, 14, 14)).toEqual({ line: 3, column: 5, selected: 0, length: 14 });
    // Right after a break the cursor stands at the start of the next line.
    expect(cursorStats(text, 5, 5)).toMatchObject({ line: 2, column: 1 });
  });

  it("treats CRLF and CR line ends like LF", () => {
    const crlf = "eins\r\nzwei";
    expect(cursorStats(crlf, 8, 8)).toEqual({ line: 2, column: 3, selected: 0, length: 9 });
    expect(cursorStats("a\rb", 3, 3)).toEqual({ line: 2, column: 2, selected: 0, length: 3 });
  });

  it("counts an emoji before the cursor as one column", () => {
    const text = `${FAMILY}${THUMBS}x`;
    expect(cursorStats(text, text.length, text.length)).toMatchObject({ column: 4, length: 3 });
  });

  it("counts the selection in characters, in either direction and across lines", () => {
    const text = `ab${THUMBS}\ncd`;
    const end = text.length;
    expect(cursorStats(text, 0, end)).toEqual({ line: 2, column: 3, selected: 6, length: 6 });
    expect(cursorStats(text, end, 0)).toEqual({ line: 1, column: 1, selected: 6, length: 6 });
    expect(cursorStats(text, 2, 2 + THUMBS.length)).toMatchObject({ selected: 1 });
  });
});

describe("createCursorStore", () => {
  it("tells its listeners only of changed numbers", () => {
    const store = createCursorStore();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    expect(store.get()).toBeNull();
    store.set({ line: 1, column: 1, selected: 0, length: 0 });
    store.set({ line: 1, column: 1, selected: 0, length: 0 });
    expect(heard).toHaveBeenCalledTimes(1);
    store.set({ line: 1, column: 2, selected: 0, length: 1 });
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    store.set({ line: 2, column: 1, selected: 0, length: 2 });
    expect(heard).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual({ line: 2, column: 1, selected: 0, length: 2 });
  });
});

describe("footerText", () => {
  const de = createTranslator("de");
  const en = createTranslator("en");

  it("formats numbers in the UI language", () => {
    expect(formatCount(1234, "de")).toBe("1.234");
    expect(formatCount(1234, "en")).toBe("1,234");
  });

  it("names line, column and length short on screen and in full for the tooltip", () => {
    const text = footerText({ line: 3, column: 811, selected: 0, length: 851 }, de, "de");
    expect(text).toEqual({
      position: "Ze 3, Sp 811",
      selected: null,
      chars: "851 Zeichen",
      full: "Zeile 3, Spalte 811, 851 Zeichen",
    });
  });

  it("adds the selection only while there is one", () => {
    const text = footerText({ line: 1, column: 13, selected: 1200, length: 4500 }, en, "en");
    expect(text.position).toBe("Ln 1, Col 13");
    expect(text.selected).toBe("(1,200 selected)");
    expect(text.chars).toBe("4,500 chars");
    expect(text.full).toBe("Line 1, column 13, 1,200 of 4,500 characters selected");
  });

  it("says one character in the singular in every language", () => {
    const one: Record<Language, [chars: string, selected: string, full: string]> = {
      de: ["1 Zeichen", "(1 ausgewählt)", "Zeile 1, Spalte 2, 1 von 1 Zeichen ausgewählt"],
      en: ["1 char", "(1 selected)", "Line 1, column 2, 1 of 1 character selected"],
      el: ["1 χαρακτ.", "(1 επιλεγμένος)", "Γραμμή 1, στήλη 2, επιλεγμένος 1 από 1 χαρακτήρα"],
      es: ["1 caract.", "(1 seleccionado)", "Línea 1, columna 2, 1 de 1 carácter seleccionado"],
      fr: ["1 car.", "(1 sélectionné)", "Ligne 1, colonne 2, 1 sur 1 caractère sélectionné"],
      it: ["1 car.", "(1 selezionato)", "Riga 1, colonna 2, 1 di 1 carattere selezionato"],
      ja: ["1 文字", "（1 選択）", "1 行目、2 列目、1 文字中 1 文字を選択"],
      pl: ["Znaki: 1", "(zazn. 1)", "Wiersz 1, kolumna 2, zaznaczone znaki: 1 z 1"],
      pt: ["1 caract.", "(1 selecionado)", "Linha 1, coluna 2, 1 de 1 caractere selecionado"],
      ru: ["Символов: 1", "(выделено: 1)", "Строка 1, столбец 2, выделено символов: 1 из 1"],
      tr: ["1 karakter", "(1 seçili)", "Satır 1, sütun 2, 1 karakterden 1 tanesi seçili"],
      zh: ["1 个字符", "（已选 1）", "第 1 行，第 2 列，已选择 1 个字符中的 1 个"],
    };
    for (const language of LANGUAGES) {
      const t = createTranslator(language);
      const text = footerText({ line: 1, column: 2, selected: 1, length: 1 }, t, language);
      expect([text.chars, text.selected, text.full], language).toEqual(one[language]);
    }
    expect(footerText({ line: 1, column: 2, selected: 0, length: 1 }, en, "en").full).toBe(
      "Line 1, column 2, 1 character",
    );
    expect(footerText({ line: 1, column: 1, selected: 0, length: 1 }, en, "en", false).full).toBe(
      "1 character",
    );
    // A selection of one in a longer text: the noun follows the length, "selected" the selection.
    const es = createTranslator("es");
    const longer = footerText({ line: 1, column: 2, selected: 1, length: 5 }, es, "es");
    expect(longer.selected).toBe("(1 seleccionado)");
    expect(longer.chars).toBe("5 caract.");
    expect(longer.full).toBe("Línea 1, columna 2, 1 de 5 caracteres seleccionados");
  });

  it("leaves out the cursor where none is shown", () => {
    const text = footerText({ line: 2, column: 4, selected: 3, length: 10 }, de, "de", false);
    expect(text).toEqual({
      position: null,
      selected: null,
      chars: "10 Zeichen",
      full: "10 Zeichen",
    });
  });
});
