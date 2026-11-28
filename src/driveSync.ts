// The state of syncing the notes through Hangar Drive, for every window. Each window asks the
// backend once and follows the `drive-sync-changed` event; one subscription serves all of the
// window's rows and footers. Hangar Note only shows the state: the person confirms the sync once
// in Hangar Drive and turns it off there too, so nothing here changes it.

import { useSyncExternalStore } from "react";

import { getDriveSyncStatus, NO_DRIVE_SYNC, onDriveSyncChanged, type DriveSyncView } from "./api";
import type { MessageKey } from "./i18n";

let current: DriveSyncView = NO_DRIVE_SYNC;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function publish(view: DriveSyncView): void {
  current = view;
  for (const listener of listeners) listener();
}

function start(): () => void {
  let live = true;
  /** An event came first: the answer to the first question is older and must not replace it. */
  let heard = false;
  getDriveSyncStatus()
    .then((view) => {
      if (live && !heard) publish(view);
    })
    .catch(() => {
      // No backend (a plain browser) or one without the command: no Hangar Drive to show.
    });
  const unlisten = onDriveSyncChanged((view) => {
    heard = true;
    if (live) publish(view);
  }).catch(() => null);
  return () => {
    live = false;
    void unlisten.then((off) => off?.());
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stop !== null) {
      stop();
      stop = null;
      // The next subscriber asks again; until then nothing stale is shown.
      current = NO_DRIVE_SYNC;
    }
  };
}

function snapshot(): DriveSyncView {
  return current;
}

/** The state of the sync, kept up to date in this window. */
export function useDriveSync(): DriveSyncView {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether a note is synced; `false` while the sync is not active. */
export function isNoteSynced(view: DriveSyncView, folderKey: string | null, id: string | null) {
  if (view.phase !== "active" || folderKey === null || id === null) return false;
  if (!Object.hasOwn(view.synced, folderKey)) return false;
  return view.synced[folderKey]?.includes(id) ?? false;
}

/**
 * Whether one note is synced, kept up to date. A row re-renders only when its own answer changes,
 * not on every change of the state.
 */
export function useNoteSynced(folderKey: string | null, id: string | null): boolean {
  const synced = () => isNoteSynced(current, folderKey, id);
  return useSyncExternalStore(subscribe, synced, synced);
}

/**
 * The sentence the settings show for a state, `null` for `absent` (no Hangar Drive: the section
 * stays away). Waiting and unavailable are told by their reason where it says more.
 */
export function driveSyncText(view: DriveSyncView): MessageKey | null {
  switch (view.phase) {
    case "absent":
      return null;
    case "notRunning":
      return "drive.notRunning";
    case "setup":
      return "drive.setup";
    case "asked":
      return "drive.asked";
    case "active":
      return "drive.active";
    case "declined":
      return "drive.declined";
    case "attention":
      return "drive.attention";
    case "waiting":
    case "unavailable":
      if (view.reason === "refused") return "drive.refused";
      if (view.reason === "hangarTooOld") return "drive.hangarTooOld";
      if (view.reason === "missing") {
        return view.phase === "waiting" ? "drive.waitingForFolder" : "drive.folderMissing";
      }
      return view.phase === "waiting" ? "drive.waiting" : "drive.unavailable";
  }
}

/** How the settings mark a state: done, a step that is up to you or Hangar Drive, or a problem. */
export type DriveSyncTone = "synced" | "info" | "problem";

export function driveSyncTone(view: DriveSyncView): DriveSyncTone {
  if (view.phase === "active") return "synced";
  if (view.phase === "attention" || view.phase === "unavailable") return "problem";
  return "info";
}
