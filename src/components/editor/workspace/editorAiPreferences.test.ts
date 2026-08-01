import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_AI_PREFERENCES,
  nextAnswerLanguage,
  readEditorAiPreferences,
  writeEditorAiPreferences,
} from "./editorAiPreferences";

const WORKSPACE = "ws-1";
const KEY = `taomni.codeWorkspace.editorAi.v1.${WORKSPACE}`;

describe("editorAiPreferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to inherit so the global setting drives it", () => {
    expect(readEditorAiPreferences(WORKSPACE)).toEqual(DEFAULT_EDITOR_AI_PREFERENCES);
    expect(DEFAULT_EDITOR_AI_PREFERENCES.answerLanguage).toBe("inherit");
  });

  it("round-trips a stored preference", () => {
    writeEditorAiPreferences(WORKSPACE, { answerLanguage: "zh-CN" });
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("zh-CN");
  });

  it("keeps an explicit auto distinct from inherit", () => {
    // `auto` pins this workspace to the app locale; `inherit` lets the global
    // setting move it. Storing one must not read back as the other.
    writeEditorAiPreferences(WORKSPACE, { answerLanguage: "auto" });
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("auto");
  });

  it("scopes preferences per workspace", () => {
    writeEditorAiPreferences(WORKSPACE, { answerLanguage: "en" });
    expect(readEditorAiPreferences("ws-2").answerLanguage).toBe("inherit");
  });

  it("falls back to the default on corrupt or unknown payloads", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("inherit");

    window.localStorage.setItem(KEY, JSON.stringify({ answerLanguage: "klingon" }));
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("inherit");

    window.localStorage.setItem(KEY, "null");
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("inherit");
  });

  it("cycles inherit → auto → zh-CN → en → inherit", () => {
    expect(nextAnswerLanguage("inherit")).toBe("auto");
    expect(nextAnswerLanguage("auto")).toBe("zh-CN");
    expect(nextAnswerLanguage("zh-CN")).toBe("en");
    expect(nextAnswerLanguage("en")).toBe("inherit");
  });
});
