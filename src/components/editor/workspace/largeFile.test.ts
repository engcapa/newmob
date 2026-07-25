import { describe, expect, it } from "vitest";
import {
  isLargeFileContent,
  LARGE_FILE_CHAR_THRESHOLD,
  LARGE_FILE_LINE_THRESHOLD,
} from "./largeFile";

describe("isLargeFileContent", () => {
  it("treats small files as normal", () => {
    expect(isLargeFileContent("")).toBe(false);
    expect(isLargeFileContent("const x = 1;\n".repeat(100))).toBe(false);
  });

  it("downgrades files past the byte threshold", () => {
    const big = "x".repeat(LARGE_FILE_CHAR_THRESHOLD + 1);
    expect(isLargeFileContent(big)).toBe(true);
  });

  it("downgrades many-short-line files under the byte cap", () => {
    // Well under the byte threshold, but past the line threshold.
    const manyLines = "a\n".repeat(LARGE_FILE_LINE_THRESHOLD + 5);
    expect(manyLines.length).toBeLessThan(LARGE_FILE_CHAR_THRESHOLD);
    expect(isLargeFileContent(manyLines)).toBe(true);
  });

  it("keeps a file just under both thresholds as normal", () => {
    const lines = Array.from({ length: LARGE_FILE_LINE_THRESHOLD - 1 }, () => "short").join("\n");
    expect(lines.length).toBeLessThan(LARGE_FILE_CHAR_THRESHOLD);
    expect(isLargeFileContent(lines)).toBe(false);
  });
});
