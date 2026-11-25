import type { Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { reuseRoot } from "./hotRoot";

function fakeRoot(): Root {
  return { render: vi.fn(), unmount: vi.fn() };
}

describe("reuseRoot", () => {
  it("creates the root once across hot reloads", () => {
    const data = {};
    const create = vi.fn(fakeRoot);
    const first = reuseRoot(data, create);
    const second = reuseRoot(data, create);
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a root without hot reload data, as in a build", () => {
    const create = vi.fn(fakeRoot);
    reuseRoot(undefined, create);
    reuseRoot(undefined, create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not trust something else stored under the same name", () => {
    const data = { root: "not a root" };
    const create = vi.fn(fakeRoot);
    const root = reuseRoot(data, create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reuseRoot(data, create)).toBe(root);
  });
});
