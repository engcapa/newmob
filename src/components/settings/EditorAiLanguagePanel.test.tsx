import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorAiLanguagePanel } from "./EditorAiLanguagePanel";
import { readGlobalAnswerLanguage, writeGlobalAnswerLanguage } from "../../lib/ai/answerLanguage";

describe("EditorAiLanguagePanel", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("lists the three global choices and preselects auto by default", () => {
    render(<EditorAiLanguagePanel />);

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    // `inherit` is a per-workspace concept — there is nothing above the global
    // default for it to inherit from.
    expect(radios.map((r) => r.value)).toEqual(["auto", "zh-CN", "en"]);
    expect(radios.find((r) => r.value === "auto")?.checked).toBe(true);
  });

  it("persists a pick so every AI explanation follows it", () => {
    render(<EditorAiLanguagePanel />);

    fireEvent.click(screen.getByRole("radio", { name: /中文/ }));

    expect(readGlobalAnswerLanguage()).toBe("zh-CN");
    expect((screen.getByRole("radio", { name: /中文/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("reflects an already-stored preference on mount", () => {
    writeGlobalAnswerLanguage("en");
    render(<EditorAiLanguagePanel />);

    const english = screen.getAllByRole("radio").find((r) => (r as HTMLInputElement).value === "en");
    expect((english as HTMLInputElement).checked).toBe(true);
  });

  it("falls back to auto when storage holds junk", () => {
    window.localStorage.setItem("taomni.ai.answerLanguage.v1", "klingon");
    render(<EditorAiLanguagePanel />);

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.find((r) => r.value === "auto")?.checked).toBe(true);
  });
});
