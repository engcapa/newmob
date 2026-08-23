import { describe, expect, it } from "vitest";
import { FullLineSession } from "./fullLineCompletionModel";

/**
 * Experimental fixture tests (§8.17.9 N12). These cover models that were
 * moved OUT of production into `__fixtures__/experimental/` because they
 * have no production owner:
 * - A4 Full Line local inline completion (G3 scope).
 *
 * The former A1 structural-search prototype and its cases were DELETED
 * together with `structuralSearchModel.ts`: §5.2.1 forbids shipping SSR as a
 * regex/template prototype. A2 recursive-layout coverage lives with the
 * production model in `recursiveLayoutTree.test.ts`.
 */
describe("Advanced Editor Workflows Suite (experimental fixtures)", () => {
  it("A4: manages full line local inline completion session with word-by-word accept", () => {
    const session = new FullLineSession();
    session.setSuggestion({
      id: "sug-1",
      lineText: "const value = ",
      insertText: "calculateTotal(items, taxRate);",
      acceptedWordsCount: 0,
      totalWordsCount: 3,
      confidence: 0.95,
      isMultiLine: false,
    });

    const step1 = session.acceptNextWord();
    expect(step1?.text).toBe("calculateTotal(items,");
    expect(step1?.remainingText).toBe(" taxRate);");

    const fullRemaining = session.acceptAll();
    expect(fullRemaining).toBe(" taxRate);");
    expect(session.getActiveSuggestion()).toBeNull();
  });
});
