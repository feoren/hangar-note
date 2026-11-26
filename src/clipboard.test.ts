import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { MAX_NOTE_BYTES } from "./api";
import { copyText } from "./clipboard";

describe("copyText", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("hands the text to the backend and never to the web clipboard", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    invoke.mockResolvedValue(null);
    await expect(copyText("# Idee\n\n- [ ] eins")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("copy_text", { text: "# Idee\n\n- [ ] eins" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports a refusal of the backend as not copied", async () => {
    invoke.mockRejectedValue("Clipboard: unavailable");
    await expect(copyText("Text")).resolves.toBe(false);
  });

  it("does not send more than one note to the backend", async () => {
    await expect(copyText("ä".repeat(MAX_NOTE_BYTES / 2 + 1))).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue(null);
    await expect(copyText("x".repeat(MAX_NOTE_BYTES))).resolves.toBe(true);
  });
});
