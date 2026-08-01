import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import {
  AI_ANSWER_LANGUAGES,
  DEFAULT_GLOBAL_ANSWER_LANGUAGE,
  GLOBAL_ANSWER_LANGUAGES,
  answerLanguageLabelKey,
  nextAnswerLanguage,
  normalizeAnswerLanguage,
  readGlobalAnswerLanguage,
  resolveAnswerLanguage,
  writeGlobalAnswerLanguage,
} from "./answerLanguage";

const KEY = "taomni.ai.answerLanguage.v1";

describe("answerLanguage global default", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to auto when nothing is stored", () => {
    expect(readGlobalAnswerLanguage()).toBe(DEFAULT_GLOBAL_ANSWER_LANGUAGE);
    expect(DEFAULT_GLOBAL_ANSWER_LANGUAGE).toBe("auto");
  });

  it("round-trips an explicit language", () => {
    writeGlobalAnswerLanguage("zh-CN");
    expect(readGlobalAnswerLanguage()).toBe("zh-CN");
    writeGlobalAnswerLanguage("en");
    expect(readGlobalAnswerLanguage()).toBe("en");
  });

  it("falls back to auto for a corrupt stored value", () => {
    window.localStorage.setItem(KEY, "klingon");
    expect(readGlobalAnswerLanguage()).toBe("auto");
  });

  it("never stores inherit as the global default", () => {
    // `inherit` has nothing above it to inherit from, so it is excluded from
    // the global list by construction.
    expect(GLOBAL_ANSWER_LANGUAGES).not.toContain("inherit");
  });
});

describe("normalizeAnswerLanguage", () => {
  it("accepts every selectable preference", () => {
    for (const language of AI_ANSWER_LANGUAGES) {
      expect(normalizeAnswerLanguage(language)).toBe(language);
    }
  });

  it("falls back to inherit for junk", () => {
    expect(normalizeAnswerLanguage("klingon")).toBe("inherit");
    expect(normalizeAnswerLanguage(undefined)).toBe("inherit");
    expect(normalizeAnswerLanguage(null)).toBe("inherit");
    expect(normalizeAnswerLanguage(42)).toBe("inherit");
  });
});

describe("resolveAnswerLanguage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => setLocale("en"));

  it("returns an explicit preference as-is, whatever the locale", () => {
    setLocale("en");
    expect(resolveAnswerLanguage("zh-CN")).toBe("zh-CN");
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("en")).toBe("en");
  });

  it("follows the app locale for auto", () => {
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("auto")).toBe("zh-CN");
    setLocale("en");
    expect(resolveAnswerLanguage("auto")).toBe("en");
  });

  it("consults the global default for inherit", () => {
    writeGlobalAnswerLanguage("zh-CN");
    setLocale("en");
    expect(resolveAnswerLanguage("inherit")).toBe("zh-CN");

    writeGlobalAnswerLanguage("en");
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("inherit")).toBe("en");
  });

  it("chains inherit → global auto → locale", () => {
    writeGlobalAnswerLanguage("auto");
    setLocale("zh-CN");
    expect(resolveAnswerLanguage("inherit")).toBe("zh-CN");
    setLocale("en");
    expect(resolveAnswerLanguage("inherit")).toBe("en");
  });

  it("falls back to English for locales we have no templates for", () => {
    setLocale("ja" as never);
    expect(resolveAnswerLanguage("auto")).toBe("en");
  });
});

describe("nextAnswerLanguage", () => {
  it("cycles inherit → auto → zh-CN → en → inherit", () => {
    expect(nextAnswerLanguage("inherit")).toBe("auto");
    expect(nextAnswerLanguage("auto")).toBe("zh-CN");
    expect(nextAnswerLanguage("zh-CN")).toBe("en");
    expect(nextAnswerLanguage("en")).toBe("inherit");
  });

  it("returns to the start after a full cycle", () => {
    let current = AI_ANSWER_LANGUAGES[0];
    for (let i = 0; i < AI_ANSWER_LANGUAGES.length; i += 1) {
      current = nextAnswerLanguage(current);
    }
    expect(current).toBe(AI_ANSWER_LANGUAGES[0]);
  });
});

describe("answerLanguageLabelKey", () => {
  it("maps each preference to its own key", () => {
    const keys = AI_ANSWER_LANGUAGES.map(answerLanguageLabelKey);
    expect(new Set(keys).size).toBe(AI_ANSWER_LANGUAGES.length);
    expect(answerLanguageLabelKey("inherit")).toBe("codeWorkspaceAi.answerLanguageInherit");
    expect(answerLanguageLabelKey("zh-CN")).toBe("codeWorkspaceAi.answerLanguageZh");
  });
});
