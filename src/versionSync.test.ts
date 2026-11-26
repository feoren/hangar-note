import { describe, expect, it } from "vitest";

// Version scheme (docs/wiki/pages/decisions/0003-version-scheme.md): the code always carries the
// upcoming version, the same in every version file, and it is the topmost entry of
// src/changelog.json. The files are read as text, so no build step stands in between. The
// changelog checks live here until the app gets a "What's new" view with its own changelog module.
import packageText from "../package.json?raw";
import cargoLockText from "../src-tauri/Cargo.lock?raw";
import cargoText from "../src-tauri/Cargo.toml?raw";
import tauriConfText from "../src-tauri/tauri.conf.json?raw";
import changelogText from "./changelog.json?raw";
import { LANGUAGES } from "./i18n";

/** `X.Y.Z` as SemVer writes it (no leading zeros), the form of a changelog entry. */
const BASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** `X.Y.Z` or, in a release state, `X.Y.Z+B`, the form of the version files. */
const FILE_VERSION = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+(?:0|[1-9]\d*))?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Longest item; anything longer is no longer a short sentence for users. */
const MAX_ITEM_LENGTH = 160;

function topLevelVersion(json: string, file: string): string {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed;
    if (typeof version === "string") return version;
  }
  throw new Error(`${file}: no version`);
}

function cargoVersion(toml: string): string {
  // Only [package], not the versions of the dependencies.
  const match = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match?.[1]) throw new Error("Cargo.toml: no version in [package]");
  return match[1];
}

function cargoLockVersion(lock: string): string {
  const match = /^\[\[package\]\]\r?\nname = "hangar-note"\r?\nversion = "([^"]+)"/m.exec(lock);
  if (!match?.[1]) throw new Error("Cargo.lock: package hangar-note not found");
  return match[1];
}

/** `X.Y.Z` of a version file, or `null` if it does not fit the scheme. */
function baseOf(version: string): string | null {
  return FILE_VERSION.exec(version)?.[1] ?? null;
}

function compareBase(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(text: string): boolean {
  const match = ISO_DATE.exec(text);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function itemProblems(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where}: not an object`];
  const problems: string[] = [];
  for (const language of LANGUAGES) {
    if (!(language in value)) problems.push(`${where}: language ${language} missing`);
  }
  for (const [language, text] of Object.entries(value)) {
    const at = `${where}.${language}`;
    if (!LANGUAGES.some((code) => code === language)) problems.push(`${at}: unknown language`);
    if (typeof text !== "string" || text.trim() === "") {
      problems.push(`${at}: empty`);
      continue;
    }
    if (text !== text.trim()) problems.push(`${at}: leading or trailing whitespace`);
    if (/[\u2013\u2014]/.test(text)) problems.push(`${at}: en or em dash`);
    if (text.length > MAX_ITEM_LENGTH) {
      problems.push(`${at}: longer than ${String(MAX_ITEM_LENGTH)}`);
    }
  }
  return problems;
}

/** Every rule the changelog breaks, as readable lines; empty means valid. */
function changelogProblems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["root is not a list"];
  if (raw.length === 0) return ["no entry"];
  const problems: string[] = [];
  let previous: string | null = null;
  raw.forEach((entry: unknown, index) => {
    const where = `entry ${String(index)}`;
    if (!isRecord(entry)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const { version, date, items } = entry;
    if (typeof version !== "string" || !BASE_VERSION.test(version)) {
      problems.push(`${where}: version must be X.Y.Z`);
    } else {
      // Strictly descending: a version twice would be a release the updater cannot tell apart.
      if (previous !== null && compareBase(previous, version) <= 0) {
        problems.push(`${where}: ${version} is not lower than ${previous}`);
      }
      previous = version;
    }
    if (date === null) {
      if (index > 0) problems.push(`${where}: only the topmost entry may have no date`);
    } else if (typeof date !== "string" || !validDate(date)) {
      problems.push(`${where}: date must be YYYY-MM-DD or null`);
    }
    // Right after a release the next version starts empty and undated; released ones need items.
    const emptyAllowed = index === 0 && date === null;
    if (!Array.isArray(items) || (items.length === 0 && !emptyAllowed)) {
      problems.push(`${where}: no items`);
      return;
    }
    items.forEach((item: unknown, itemIndex) => {
      problems.push(...itemProblems(item, `${where}.items[${String(itemIndex)}]`));
    });
  });
  return problems;
}

function topVersion(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const first: unknown = raw[0];
  return isRecord(first) && typeof first.version === "string" ? first.version : null;
}

const allLanguages = (text: string): Record<string, string> =>
  Object.fromEntries(LANGUAGES.map((language) => [language, `${text} (${language})`]));

describe("version files", () => {
  const tauri = topLevelVersion(tauriConfText, "tauri.conf.json");

  it("tauri.conf.json, package.json, Cargo.toml and Cargo.lock name the same version", () => {
    expect(topLevelVersion(packageText, "package.json")).toBe(tauri);
    expect(cargoVersion(cargoText)).toBe(tauri);
    expect(cargoLockVersion(cargoLockText)).toBe(tauri);
  });

  it("the version is X.Y.Z or X.Y.Z+B", () => {
    expect(baseOf(tauri)).not.toBeNull();
  });

  it("the version is the topmost entry of the changelog", () => {
    const changelog: unknown = JSON.parse(changelogText);
    // After a release the files carry X.Y.Z+B; X.Y.Z is compared.
    expect(baseOf(tauri)).toBe(topVersion(changelog));
  });
});

describe("src/changelog.json", () => {
  it("follows the rules", () => {
    expect(changelogProblems(JSON.parse(changelogText))).toEqual([]);
  });
});

describe("changelogProblems", () => {
  const item = allLanguages("Text");

  it("accepts released entries below one upcoming entry", () => {
    expect(
      changelogProblems([
        { version: "0.3.0", date: null, items: [item] },
        { version: "0.2.0", date: "2026-12-01", items: [item] },
        { version: "0.1.0", date: "2026-11-30", items: [item] },
      ]),
    ).toEqual([]);
  });

  it("allows only the topmost, undated entry without items", () => {
    expect(
      changelogProblems([
        { version: "0.2.0", date: null, items: [] },
        { version: "0.1.0", date: "2026-11-30", items: [item] },
      ]),
    ).toEqual([]);
    expect(changelogProblems([{ version: "0.2.0", date: "2026-12-01", items: [] }])).toEqual([
      "entry 0: no items",
    ]);
  });

  it("reports a missing or unknown language, empty texts, dashes and long items", () => {
    const withoutChinese = Object.fromEntries(
      Object.entries(item).filter(([language]) => language !== "zh"),
    );
    const problems = changelogProblems([
      {
        version: "0.1.0",
        date: null,
        items: [
          withoutChinese,
          { ...item, xx: "?" },
          { ...item, de: " " },
          { ...item, en: "a \u2013 b" },
          { ...item, fr: "a \u2014 b" },
          { ...item, it: " padded" },
          { ...item, ja: "word ".repeat(40).trim() },
        ],
      },
    ]);
    expect(problems).toEqual([
      "entry 0.items[0]: language zh missing",
      "entry 0.items[1].xx: unknown language",
      "entry 0.items[2].de: empty",
      "entry 0.items[3].en: en or em dash",
      "entry 0.items[4].fr: en or em dash",
      "entry 0.items[5].it: leading or trailing whitespace",
      `entry 0.items[6].ja: longer than ${String(MAX_ITEM_LENGTH)}`,
    ]);
  });

  it("reports versions that are not X.Y.Z, not descending or repeated", () => {
    expect(
      changelogProblems([
        { version: "0.2.0", date: null, items: [item] },
        { version: "0.10.0", date: "2026-11-30", items: [item] },
        { version: "0.10.0", date: "2026-11-29", items: [item] },
        { version: "0.1.0+5", date: "2026-11-28", items: [item] },
        { version: "01.0.0", date: "2026-11-27", items: [item] },
      ]),
    ).toEqual([
      "entry 1: 0.10.0 is not lower than 0.2.0",
      "entry 2: 0.10.0 is not lower than 0.10.0",
      "entry 3: version must be X.Y.Z",
      "entry 4: version must be X.Y.Z",
    ]);
  });

  it("reports a second undated entry and invalid dates", () => {
    expect(
      changelogProblems([
        { version: "0.3.0", date: "2026-02-30", items: [item] },
        { version: "0.2.0", date: null, items: [item] },
        { version: "0.1.0", date: "30.11.2026", items: [item] },
      ]),
    ).toEqual([
      "entry 0: date must be YYYY-MM-DD or null",
      "entry 1: only the topmost entry may have no date",
      "entry 2: date must be YYYY-MM-DD or null",
    ]);
  });

  it("reports a wrong root and an empty list", () => {
    expect(changelogProblems({})).toEqual(["root is not a list"]);
    expect(changelogProblems([])).toEqual(["no entry"]);
  });
});

describe("version helpers", () => {
  it("reads X.Y.Z and X.Y.Z+B, nothing else", () => {
    expect(baseOf("0.1.0")).toBe("0.1.0");
    expect(baseOf("0.1.0+14")).toBe("0.1.0");
    expect(baseOf("0.1.0-14")).toBeNull();
    expect(baseOf("v0.1.0")).toBeNull();
  });

  it("finds the versions in Cargo.toml and Cargo.lock, not those of dependencies", () => {
    const toml =
      '[package]\nname = "hangar-note"\nversion = "0.2.0"\n\n[dependencies]\nserde = "1"\n';
    expect(cargoVersion(toml)).toBe("0.2.0");
    const lock =
      '[[package]]\nname = "hangar"\nversion = "9.9.9"\n\n[[package]]\r\nname = "hangar-note"\r\nversion = "0.2.0+7"\r\n';
    expect(cargoLockVersion(lock)).toBe("0.2.0+7");
  });

  it("compares numerically, not as text", () => {
    expect(compareBase("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareBase("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareBase("0.2.0", "0.2.0")).toBe(0);
  });
});
