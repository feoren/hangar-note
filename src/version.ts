// The version as the app shows it (ADR 0003): internally `X.Y.Z+B`, shown `X.Y.Z-B`; a state
// that is no release carries only `X.Y.Z` and shows that. While the major version is 0 the app is
// a beta, marked by a small "beta" badge as in Hangar. Parsing taken from Hangar's src/version.ts
// (MIT, same owner).

import { version as packageVersion } from "../package.json";

/** The version this code carries (package.json, kept in sync by versionSync.test.ts). */
export const APP_VERSION: string = packageVersion;

export interface AppVersion {
  major: number;
  minor: number;
  revision: number;
  build: number | null;
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[+-](\d+))?$/;

/** Reads "0.1.0+42", "0.1.0-42" or "0.1.0"; otherwise `null`. */
export function parseVersion(text: string): AppVersion | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, major, minor, revision, build] = match;
  if (major === undefined || minor === undefined || revision === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    revision: Number(revision),
    build: build === undefined ? null : Number(build),
  };
}

/** The shown form "0.1.0-42", without a build number "0.1.0"; unreadable input stays as is. */
export function formatVersion(text: string): string {
  const version = parseVersion(text);
  if (!version) return text;
  const base = `${String(version.major)}.${String(version.minor)}.${String(version.revision)}`;
  return version.build === null ? base : `${base}-${String(version.build)}`;
}

/** The shown number and whether the "beta" badge belongs to it (major version 0). */
export function versionParts(text: string): { number: string; beta: boolean } {
  const version = parseVersion(text);
  return { number: formatVersion(text), beta: version !== null && version.major === 0 };
}
