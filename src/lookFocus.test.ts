import { describe, expect, it } from "vitest";

import { focusLookOnDraw, takeLookFocus } from "./lookFocus";

describe("look focus", () => {
  it("hands the focus once to the switch of the chosen look", () => {
    expect(takeLookFocus("paper")).toBe(false);
    focusLookOnDraw("paper");
    // The old look's switch, still drawn until the new look arrives, does not take it.
    expect(takeLookFocus("hangar")).toBe(false);
    expect(takeLookFocus("paper")).toBe(true);
    expect(takeLookFocus("paper")).toBe(false);
  });
});
