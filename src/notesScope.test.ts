// Cases partly taken from Hangar's src/notesScope.test.ts.
import { describe, expect, it } from "vitest";

import {
  activeProject,
  isProject,
  levelOf,
  LEVELS,
  mixesScopes,
  mostRecentProject,
  newNoteFolder,
  sameScope,
  scopeFolders,
  scopeForFolder,
  scopeOfLevel,
  startScope,
} from "./notesScope";

const shop = { path: "C:\\p\\shop" };
const web = { path: "C:\\p\\web" };
const folders = [
  { folderKey: "general", path: null, name: null, noteCount: 4, updatedAt: 9 },
  { folderKey: "a".repeat(32), path: "C:\\p\\web", name: "web", noteCount: 2, updatedAt: 5 },
  { folderKey: "b".repeat(32), path: "C:\\p\\old", name: "old", noteCount: 0, updatedAt: 7 },
  { folderKey: "c".repeat(32), path: "C:\\p\\shop", name: "shop", noteCount: 1, updatedAt: 3 },
];

describe("levels", () => {
  it("map to their scopes and back, in the order of the tabs", () => {
    expect(LEVELS).toEqual(["private", "project", "team"]);
    for (const level of LEVELS) expect(levelOf(scopeOfLevel(level))).toBe(level);
    expect(scopeOfLevel("private")).toEqual({ kind: "general" });
    expect(levelOf({ kind: "all" })).toBeNull();
  });
});

describe("the project of the Project level", () => {
  const none = { chosen: null, opened: null, last: null, folders: [] };

  it("is the folder Hangar opened it for, before the last one and the newest", () => {
    expect(activeProject({ ...none, opened: shop.path, last: web.path, folders })).toEqual(shop);
  });

  it("is the last one shown without a folder, before the newest", () => {
    expect(activeProject({ ...none, last: shop.path, folders })).toEqual(shop);
  });

  it("is the project with the newest note without either, never an empty one or General", () => {
    expect(mostRecentProject(folders)).toBe(web.path);
    expect(activeProject({ ...none, folders })).toEqual(web);
    expect(activeProject(none)).toBeNull();
    const noProjectNotes = folders.filter((info) => info.path === null || info.noteCount === 0);
    expect(mostRecentProject(noProjectNotes)).toBeNull();
  });

  it("is the one chosen by hand above all", () => {
    expect(
      activeProject({ chosen: web.path, opened: shop.path, last: shop.path, folders }),
    ).toEqual(web);
  });
});

describe("the level a window starts on", () => {
  it("is the project Hangar opened it for", () => {
    expect(startScope(shop.path, 4, shop)).toEqual({ kind: "project" });
  });

  it("is Private, unless Private is empty while a project has notes", () => {
    expect(startScope(null, 4, web)).toEqual({ kind: "general" });
    expect(startScope(null, undefined, web)).toEqual({ kind: "general" });
    expect(startScope(null, 0, web)).toEqual({ kind: "project" });
    expect(startScope(null, 0, null)).toEqual({ kind: "general" });
  });
});

describe("notes scope", () => {
  it("lists the right scopes", () => {
    expect(scopeFolders({ kind: "project" }, shop, folders)).toEqual([shop]);
    expect(scopeFolders({ kind: "project" }, null, folders)).toEqual([]);
    expect(scopeFolders({ kind: "general" }, shop, folders)).toEqual([{ path: null }]);
    expect(scopeFolders({ kind: "team" }, shop, folders)).toEqual([]);
    expect(scopeFolders({ kind: "all" }, shop, folders)).toEqual([{ path: null }, web, shop]);
    expect(scopeFolders({ kind: "all" }, { path: "C:\\p\\old" }, folders)).toEqual([
      { path: null },
      web,
      shop,
      { path: "C:\\p\\old" },
    ]);
  });

  it("puts new notes into the level shown, for All into the project, never into Team", () => {
    expect(newNoteFolder({ kind: "general" }, shop)).toEqual({ path: null });
    expect(newNoteFolder({ kind: "project" }, shop)).toEqual(shop);
    expect(newNoteFolder({ kind: "project" }, null)).toBeNull();
    expect(newNoteFolder({ kind: "team" }, shop)).toBeNull();
    expect(newNoteFolder({ kind: "all" }, shop)).toEqual(shop);
    expect(newNoteFolder({ kind: "all" }, null)).toEqual({ path: null });
  });

  it("maps a folder to its level and knows the project", () => {
    expect(scopeForFolder({ path: null })).toEqual({ kind: "general" });
    expect(scopeForFolder(web)).toEqual({ kind: "project" });
    expect(isProject({ path: "c:/p/shop" }, shop)).toBe(true);
    expect(isProject(web, shop)).toBe(false);
    expect(isProject({ path: null }, shop)).toBe(false);
    expect(isProject(shop, null)).toBe(false);
  });

  it("compares scopes and knows when rows name their project", () => {
    expect(sameScope({ kind: "all" }, { kind: "general" })).toBe(false);
    expect(sameScope({ kind: "team" }, { kind: "team" })).toBe(true);
    expect(mixesScopes({ kind: "all" })).toBe(true);
    expect(mixesScopes({ kind: "project" })).toBe(false);
  });
});
