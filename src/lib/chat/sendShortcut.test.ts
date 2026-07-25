import { describe, expect, it } from "vitest";
import {
  isChatSendKey,
  normalizeChatSendShortcut,
} from "./sendShortcut";

describe("normalizeChatSendShortcut", () => {
  it("defaults unknown values to ctrl_enter", () => {
    expect(normalizeChatSendShortcut(undefined)).toBe("ctrl_enter");
    expect(normalizeChatSendShortcut(null)).toBe("ctrl_enter");
    expect(normalizeChatSendShortcut("")).toBe("ctrl_enter");
    expect(normalizeChatSendShortcut("ctrl_enter")).toBe("ctrl_enter");
    expect(normalizeChatSendShortcut("enter")).toBe("enter");
  });
});

describe("isChatSendKey", () => {
  const base = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false };

  it("sends on Ctrl/Cmd+Enter in ctrl_enter mode", () => {
    expect(isChatSendKey({ ...base, ctrlKey: true }, "ctrl_enter")).toBe(true);
    expect(isChatSendKey({ ...base, metaKey: true }, "ctrl_enter")).toBe(true);
    expect(isChatSendKey(base, "ctrl_enter")).toBe(false);
    expect(isChatSendKey({ ...base, shiftKey: true }, "ctrl_enter")).toBe(false);
  });

  it("sends on Enter (not Shift+Enter) in enter mode", () => {
    expect(isChatSendKey(base, "enter")).toBe(true);
    expect(isChatSendKey({ ...base, shiftKey: true }, "enter")).toBe(false);
    expect(isChatSendKey({ ...base, ctrlKey: true }, "enter")).toBe(true);
  });

  it("ignores IME composition Enter", () => {
    expect(isChatSendKey({ ...base, isComposing: true }, "enter")).toBe(false);
    expect(isChatSendKey({ ...base, keyCode: 229 }, "enter")).toBe(false);
  });
});
