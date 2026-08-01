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

  it("defaults to auto when nothing is stored", () => {
    expect(readEditorAiPreferences(WORKSPACE)).toEqual(DEFAULT_EDITOR_AI_PREFERENCES);
    expect(DEFAULT_EDITOR_AI_PREFERENCES.answerLanguage).toBe("auto");
  });

  it("round-trips a stored preference", () => {
    writeEditorAiPreferences(WORKSPACE, { answerLanguage: "zh-CN" });
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("zh-CN");
  });

  it("scopes preferences per workspace", () => {
    writeEditorAiPreferences(WORKSPACE, { answerLanguage: "en" });
    expect(readEditorAiPreferences("ws-2").answerLanguage).toBe("auto");
  });

  it("falls back to the default on corrupt or unknown payloads", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("auto");

    window.localStorage.setItem(KEY, JSON.stringify({ answerLanguage: "klingon" }));
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("auto");

    window.localStorage.setItem(KEY, "null");
    expect(readEditorAiPreferences(WORKSPACE).answerLanguage).toBe("auto");
  });

  it("cycles auto → zh-CN → en → auto", () => {
    expect(nextAnswerLanguage("auto")).toBe("zh-CN");
    expect(nextAnswerLanguage("zh-CN")).toBe("en");
    expect(nextAnswerLanguage("en")).toBe("auto");
  });
});
