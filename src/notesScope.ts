// Which notes the list shows: one of the three levels above the notes ("Private", "Project",
// "Team") or "All notes" from the sidebar, and which project the "Project" level stands for.
// Pure logic; it started from Hangar's src/notesScope.ts (MIT, same owner).
//
// The project is the one Hangar is working in: the folder Hangar Note was opened for (`--folder`,
// also forwarded to a running instance), else the project shown last (`lastProject` in
// settings.json), else the project with the newest note. Choosing one by hand wins until Hangar
// names another.

import type { FolderInfo, NoteFolder } from "./api";
import { folderId, GENERAL_FOLDER, sameFolder } from "./notes";

/** The three levels above the notes, in their order (Ctrl+1 to Ctrl+3). */
export type Level = "private" | "project" | "team";

export const LEVELS: readonly Level[] = ["private", "project", "team"];

/**
 * What the list shows. "general" is the "Private" level (the notes of no project), "project" and
 * "team" the project's private and team notes, "all" every private note of every project.
 */
export type NotesScope =
  { kind: "all" } | { kind: "general" } | { kind: "project" } | { kind: "team" };

export function scopeOfLevel(level: Level): NotesScope {
  switch (level) {
    case "private":
      return { kind: "general" };
    case "project":
      return { kind: "project" };
    case "team":
      return { kind: "team" };
  }
}

/** The level a scope belongs to; "All notes" belongs to none. */
export function levelOf(scope: NotesScope): Level | null {
  switch (scope.kind) {
    case "general":
      return "private";
    case "project":
      return "project";
    case "team":
      return "team";
    case "all":
      return null;
  }
}

/** Where the project of the "Project" level can come from, strongest first. */
export interface ProjectSources {
  /** Chosen by hand in this session (the project menu, the sidebar). */
  chosen: string | null;
  /** The folder Hangar Note was opened for (`--folder`). */
  opened: string | null;
  /** The project shown last (`settings.json`). */
  last: string | null;
  folders: readonly FolderInfo[];
}

/** The project with the newest note, `null` while no project has notes. */
export function mostRecentProject(folders: readonly FolderInfo[]): string | null {
  let best: FolderInfo | null = null;
  for (const info of folders) {
    if (info.path === null || info.noteCount === 0) continue;
    if (best === null || (info.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = info;
  }
  return best?.path ?? null;
}

/** The project the "Project" level stands for, `null` while there is none at all. */
export function activeProject(sources: ProjectSources): NoteFolder | null {
  const path =
    sources.chosen ?? sources.opened ?? sources.last ?? mostRecentProject(sources.folders);
  return path === null ? null : { path };
}

/**
 * The level a window starts on before anything was chosen: the project Hangar opened it for;
 * else "Private", unless it is empty while a project has notes (an empty first view would read
 * as an empty app).
 */
export function startScope(
  opened: string | null,
  privateCount: number | undefined,
  project: NoteFolder | null,
): NotesScope {
  if (opened !== null) return { kind: "project" };
  if (project !== null && privateCount === 0) return { kind: "project" };
  return { kind: "general" };
}

/**
 * Scopes whose notes the list shows. "All": General, every scope with notes and the project.
 * The team level lists none here: team notes are opened through Hangar (ADR 0002).
 */
export function scopeFolders(
  scope: NotesScope,
  project: NoteFolder | null,
  folders: readonly FolderInfo[],
): NoteFolder[] {
  switch (scope.kind) {
    case "general":
      return [GENERAL_FOLDER];
    case "project":
      return project === null ? [] : [project];
    case "team":
      return [];
    case "all": {
      const result: NoteFolder[] = [];
      const seen = new Set<string>();
      const add = (folder: NoteFolder) => {
        const id = folderId(folder);
        if (seen.has(id)) return;
        seen.add(id);
        result.push(folder);
      };
      add(GENERAL_FOLDER);
      for (const info of folders) if (info.noteCount > 0) add({ path: info.path });
      if (project !== null) add(project);
      return result;
    }
  }
}

/**
 * Where a new note goes: the level shown; for "All" the project, else General. `null` where
 * nothing can be written: the team level, and the project level while there is no project.
 */
export function newNoteFolder(scope: NotesScope, project: NoteFolder | null): NoteFolder | null {
  switch (scope.kind) {
    case "general":
      return GENERAL_FOLDER;
    case "project":
      return project;
    case "all":
      return project ?? GENERAL_FOLDER;
    case "team":
      return null;
  }
}

/** The scope that shows `folder`'s notes (a note opened from Hangar or a search hit). */
export function scopeForFolder(folder: NoteFolder): NotesScope {
  return folder.path === null ? { kind: "general" } : { kind: "project" };
}

export function sameScope(a: NotesScope, b: NotesScope): boolean {
  return a.kind === b.kind;
}

/** Does the list mix scopes, so each row should name its project? */
export function mixesScopes(scope: NotesScope): boolean {
  return scope.kind === "all";
}

/** Is `folder` the project the "Project" level shows? */
export function isProject(folder: NoteFolder, project: NoteFolder | null): boolean {
  return project !== null && folder.path !== null && sameFolder(folder, project);
}
