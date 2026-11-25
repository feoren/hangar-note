// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { editable, installBrowserGuard } from "./browserGuard";

let remove: (() => void) | null = null;

afterEach(() => {
  remove?.();
  remove = null;
  document.body.replaceChildren();
});

function contextMenuOn(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

function keyOn(element: Element, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

function setup() {
  document.body.innerHTML = `
    <div class="note">
      <button type="button">Menu</button>
      <div class="cm-content" contenteditable="true"><span>text</span></div>
      <input type="search" />
      <div contenteditable="false"><span>widget</span></div>
    </div>`;
  const get = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(selector);
    return element;
  };
  return {
    button: get("button"),
    editorText: get(".cm-content span"),
    input: get("input"),
    widget: get("[contenteditable=false] span"),
  };
}

describe("browser guard", () => {
  it("keeps the context menu only in text fields and the editor", () => {
    const { button, editorText, input, widget } = setup();
    remove = installBrowserGuard(window, { blockBrowserKeys: false, platform: "windows" });
    expect(contextMenuOn(button)).toBe(true);
    expect(contextMenuOn(widget)).toBe(true);
    expect(contextMenuOn(editorText)).toBe(false);
    expect(contextMenuOn(input)).toBe(false);
    expect(editable(editorText)).toBe(true);
    expect(editable(null)).toBe(false);
  });

  it("catches reload and print keys in release builds, also in the editor", () => {
    const { editorText } = setup();
    remove = installBrowserGuard(window, { blockBrowserKeys: true, platform: "windows" });
    expect(keyOn(editorText, { key: "F5", code: "F5" })).toBe(true);
    expect(keyOn(editorText, { key: "r", code: "KeyR", ctrlKey: true })).toBe(true);
    expect(keyOn(editorText, { key: "p", code: "KeyP", ctrlKey: true })).toBe(true);
    expect(keyOn(editorText, { key: "f", code: "KeyF", ctrlKey: true })).toBe(true);
    // Editing keys stay with the editor.
    expect(keyOn(editorText, { key: "c", code: "KeyC", ctrlKey: true })).toBe(false);
    expect(keyOn(editorText, { key: "r", code: "KeyR" })).toBe(false);
  });

  it("lets development builds reload and removes itself", () => {
    const { button } = setup();
    remove = installBrowserGuard(window, { blockBrowserKeys: false, platform: "windows" });
    expect(keyOn(button, { key: "F5", code: "F5" })).toBe(false);
    remove();
    remove = null;
    expect(contextMenuOn(button)).toBe(false);
  });
});
