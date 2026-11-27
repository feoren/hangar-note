import { describe, expect, it } from "vitest";

import { APP_VERSION, formatVersion, parseVersion, versionParts } from "./version";

describe("version", () => {
  it("shows the internal X.Y.Z+B as X.Y.Z-B and X.Y.Z as it is", () => {
    expect(formatVersion("0.1.0+42")).toBe("0.1.0-42");
    expect(formatVersion("0.1.0")).toBe("0.1.0");
    expect(formatVersion("not a version")).toBe("not a version");
  });

  it("marks every 0.x version as beta, from 1.0.0 on none", () => {
    expect(versionParts("0.1.0+42")).toEqual({ number: "0.1.0-42", beta: true });
    expect(versionParts("1.0.0")).toEqual({ number: "1.0.0", beta: false });
    expect(versionParts("x")).toEqual({ number: "x", beta: false });
  });

  it("reads the version the code carries", () => {
    expect(parseVersion(APP_VERSION)).not.toBeNull();
  });
});
