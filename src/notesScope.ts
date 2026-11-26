// Which notes the list shows: the chips "This project", "All", "General", or one other project
// (opened from a search hit). Pure logic, taken from Hangar's src/notesScope.ts (MIT, same owner)
// without the shared notes. "This project" is the folder the app was started for (`--folder`).

import type { FolderInfo, NoteFolder } from "./api";
import { folderId, GENERAL_FOLDER, sameFolder } from "./notes";

export type NotesScope =
  | { kind: "project" }
  | { kind: "all" }
  | { kind: "general" }
  | { kind: "folder"; folder: NoteFolder };

export const DEFAULT_SCOPE: NotesScope = { kind: "project" };

/** "This project" needs a folder; without one, the list shows General. */
export function effectiveScope(scope: NotesScope, projectFolder: NoteFolder | null): NotesScope {
  if (scope.kind === "project" && projectFolder === null) return { kind: "general" };
  if (scope.kind === "folder") {
    if (scope.folder.path === null) return { kind: "general" };
    if (projectFolder !== null && sameFolder(scope.folder, projectFolder)) {
      return { kind: "project" };
    }
  }
  return scope;
}

/** Scopes whose notes the list shows. "All": General, every scope with notes and the project. */
export function scopeFolders(
  scope: NotesScope,
  projectFolder: NoteFolder | null,
  folders: readonly FolderInfo[],
): NoteFolder[] {
  const shown = effectiveScope(scope, projectFolder);
  switch (shown.kind) {
    case "project":
      return projectFolder === null ? [GENERAL_FOLDER] : [projectFolder];
    case "general":
      return [GENERAL_FOLDER];
    case "folder":
      return [shown.folder];
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
      if (projectFolder !== null) add(projectFolder);
      return result;
    }
  }
}

/** Where a new note goes: the scope shown; for "All" the project, else General. */
export function newNoteFolder(scope: NotesScope, projectFolder: NoteFolder | null): NoteFolder {
  const shown = effectiveScope(scope, projectFolder);
  switch (shown.kind) {
    case "project":
    case "all":
      return projectFolder ?? GENERAL_FOLDER;
    case "general":
      return GENERAL_FOLDER;
    case "folder":
      return shown.folder;
  }
}

/** The scope that shows `folder`. */
export function scopeForFolder(folder: NoteFolder, projectFolder: NoteFolder | null): NotesScope {
  return effectiveScope({ kind: "folder", folder }, projectFolder);
}

export function sameScope(a: NotesScope, b: NotesScope): boolean {
  if (a.kind === "folder" && b.kind === "folder") return sameFolder(a.folder, b.folder);
  return a.kind === b.kind;
}

/** Does the list mix scopes, so each row should name its project? */
export function mixesScopes(scope: NotesScope, projectFolder: NoteFolder | null): boolean {
  return effectiveScope(scope, projectFolder).kind === "all";
}
