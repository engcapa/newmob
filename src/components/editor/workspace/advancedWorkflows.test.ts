import { describe, expect, it } from "vitest";
import {
  matchStructuralPattern,
  replaceStructuralPattern,
  type StructuralPattern,
} from "./structuralSearchModel";
import { LayoutTreeManager } from "./recursiveLayoutTree";
import { FullLineSession } from "./fullLineCompletionModel";

describe("Advanced Editor Workflows Suite (A1-A4)", () => {
  it("A1: matches structural pattern and captures variable bindings", () => {
    const pattern: StructuralPattern = {
      id: "p1",
      name: "Assert Equals",
      template: "assertEquals($expected$, $actual$)",
      replacement: "assertThat($actual$).isEqualTo($expected$)",
      variables: [
        { name: "expected" },
        { name: "actual" },
      ],
      language: "java",
    };

    const code = 'assertEquals("expectedValue", result.getValue());';
    const matches = matchStructuralPattern(code, pattern);

    expect(matches).toHaveLength(1);
    expect(matches[0].capturedVariables["$expected$"]).toBe('"expectedValue"');
    expect(matches[0].capturedVariables["$actual$"]).toBe("result.getValue()");

    const replaced = replaceStructuralPattern(code, pattern);
    expect(replaced).toBe('assertThat(result.getValue()).isEqualTo("expectedValue");');
  });

  it("A2: splits and manages recursive layout tree leaves", () => {
    const layout = new LayoutTreeManager();
    expect(layout.countLeaves()).toBe(1);

    layout.splitLeaf("leaf-primary", "horizontal", "file2.ts");
    expect(layout.countLeaves()).toBe(2);

    const root = layout.getRoot();
    expect(root.type).toBe("split");

    layout.closeLeaf("leaf-primary");
    expect(layout.countLeaves()).toBe(1);
  });

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
