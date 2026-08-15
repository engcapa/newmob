import { describe, expect, it } from "vitest";
import type { StructuredTestResults } from "../../../../lib/editor/workspace";
import {
  formatTestDuration,
  groupTestResults,
  resultStatusLabel,
  uniqueTestResults,
} from "./testResultTree";

function results(overrides: Partial<StructuredTestResults> = {}): StructuredTestResults {
  return {
    schema: "taomni.codeWorkspace.testResults",
    version: 1,
    source: "junit-xml",
    generatedAt: 1,
    results: [
      {
        id: "b.CalcTest#fails",
        selector: "b.CalcTest#fails",
        name: "fails",
        className: "b.CalcTest",
        status: "failed",
        durationMs: 1200,
        message: "expected 2",
        details: "stack",
        filePath: "src/test/java/b/CalcTest.java",
        line: 8,
      },
      {
        id: "a.CalcTest#adds",
        selector: "a.CalcTest#adds",
        name: "adds",
        className: "a.CalcTest",
        status: "passed",
        durationMs: 12,
        message: null,
        details: null,
        filePath: null,
        line: null,
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, skipped: 0, errors: 0, durationMs: 1212 },
    diagnostics: [],
    ...overrides,
  };
}

describe("testResultTree", () => {
  it("deduplicates provider rows and groups classes deterministically", () => {
    const input = results().results;
    expect(uniqueTestResults([...input, input[0]])).toHaveLength(2);
    expect(groupTestResults(results()).map((group) => group.className)).toEqual(["a.CalcTest", "b.CalcTest"]);
  });

  it("formats durations and statuses for compact panel labels", () => {
    expect(formatTestDuration(null)).toBe("-");
    expect(formatTestDuration(12)).toBe("12 ms");
    expect(formatTestDuration(1200)).toBe("1.20 s");
    expect(resultStatusLabel("skipped")).toBe("Skipped");
  });
});
