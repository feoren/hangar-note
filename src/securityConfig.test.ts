// The window's Content Security Policy and prototype freeze (src-tauri/tauri.conf.json). The policy
// is what keeps injected markup from running code or loading anything from elsewhere, so it is
// parsed here and held to its rules.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** The directives of a policy, each with its sources (CSP Level 3 serialization). */
function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === undefined || name === "") continue;
    const key = name.toLowerCase();
    // The first occurrence of a directive wins; browsers ignore later ones.
    if (!directives.has(key)) directives.set(key, sources);
  }
  return directives;
}

/** A field of a parsed JSON object, `undefined` when there is none. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

function readSecurity(): Record<string, unknown> {
  const path = join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  const security = field(field(config, "app"), "security");
  if (typeof security !== "object" || security === null) throw new Error("app.security missing");
  return Object.fromEntries(Object.entries(security));
}

function policy(): Map<string, string[]> {
  const csp = readSecurity()["csp"];
  if (typeof csp !== "string") throw new Error("app.security.csp must be one string");
  return parseCsp(csp);
}

/** The sources a fetch directive falls back to when it is not given (`default-src`). */
function effective(directives: Map<string, string[]>, name: string): string[] {
  return directives.get(name) ?? directives.get("default-src") ?? [];
}

describe("parseCsp", () => {
  it("splits directives and sources and keeps the first of a repeated directive", () => {
    const parsed = parseCsp(" default-src 'self' ;script-src 'self' ; ; script-src * ");
    expect(parsed.get("default-src")).toEqual(["'self'"]);
    expect(parsed.get("script-src")).toEqual(["'self'"]);
    expect([...parsed.keys()]).toEqual(["default-src", "script-src"]);
  });
});

describe("the window's security policy", () => {
  it("allows no frames and no plugins", () => {
    const directives = policy();
    expect(directives.get("frame-src")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("runs only the app's own scripts: no eval and no inline script anywhere", () => {
    const directives = policy();
    for (const [name, sources] of directives) {
      expect(sources, name).not.toContain("'unsafe-eval'");
      expect(sources, name).not.toContain("'wasm-unsafe-eval'");
    }
    const scripts = effective(directives, "script-src");
    expect(scripts).toEqual(["'self'"]);
    expect(scripts).not.toContain("'unsafe-inline'");
    for (const name of ["script-src-elem", "script-src-attr"]) {
      expect(directives.get(name) ?? [], name).not.toContain("'unsafe-inline'");
    }
  });

  it("styles only from the app's own files; inline styles only as attributes", () => {
    const directives = policy();
    expect(effective(directives, "style-src")).not.toContain("'unsafe-inline'");
    expect(directives.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
  });

  it("reaches nothing over plain http but the IPC host, and no wildcard host", () => {
    for (const [name, sources] of policy()) {
      for (const source of sources) {
        const lower = source.toLowerCase();
        if (lower.startsWith("http:")) {
          expect(lower, name).toBe("http://ipc.localhost");
          expect(name).toBe("connect-src");
        }
        expect(source, name).not.toContain("*");
        expect(lower, name).not.toMatch(/^(ws|wss|blob|filesystem):/u);
        if (lower === "data:") expect(name).toBe("img-src");
      }
    }
    expect(policy().get("connect-src")).toEqual(["ipc:", "http://ipc.localhost"]);
  });

  it("freezes the prototypes and keeps Tauri's nonces for its own inline code", () => {
    const security = readSecurity();
    expect(security["freezePrototype"]).toBe(true);
    expect(security["dangerousDisableAssetCspModification"]).toBeUndefined();
    // No separate, weaker policy for development builds.
    expect(security["devCsp"]).toBeUndefined();
  });
});
