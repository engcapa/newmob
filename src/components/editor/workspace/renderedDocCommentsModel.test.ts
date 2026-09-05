import { describe, expect, it } from "vitest";
import {
  extractDocComments,
  isDocCommentRenderingSupported,
  normalizeDocLanguageId,
  normalizeDocCommentText,
  readReaderModePreference,
  renderDocCommentHtml,
  writeReaderModePreference,
} from "./renderedDocCommentsModel";

describe("ED-DOC-001: renderedDocCommentsModel / Reader Mode", () => {
  it("determines doc comment rendering language support accurately", () => {
    expect(isDocCommentRenderingSupported("typescript")).toBe(true);
    expect(isDocCommentRenderingSupported("javascript")).toBe(true);
    expect(isDocCommentRenderingSupported("java")).toBe(true);
    expect(isDocCommentRenderingSupported("rust")).toBe(true);
    expect(isDocCommentRenderingSupported("python")).toBe(true);

    // Unsupported languages
    expect(isDocCommentRenderingSupported("plain")).toBe(false);
    expect(isDocCommentRenderingSupported("text")).toBe(false);
    expect(isDocCommentRenderingSupported("csv")).toBe(false);
    expect(isDocCommentRenderingSupported("log")).toBe(false);
    expect(isDocCommentRenderingSupported(undefined)).toBe(false);
  });

  it("normalizes file-extension language ids used before a provider is ready", () => {
    expect(normalizeDocLanguageId("ts")).toBe("typescript");
    expect(normalizeDocLanguageId("tsx")).toBe("typescriptreact");
    expect(normalizeDocLanguageId("PY")).toBe("python");
    expect(isDocCommentRenderingSupported("ts")).toBe(true);
    expect(isDocCommentRenderingSupported("plain-text")).toBe(false);
  });

  it("normalizes JSDoc / Javadoc tags into formatted markdown", () => {
    const rawJsDoc = `/**
 * Performs calculation on input values.
 * @param a The first operand
 * @param b The second operand
 * @return The calculated sum
 * @throws IllegalArgumentException If operands are invalid
 * @deprecated Use modern calculateV2 instead
 * @see MathHelper
 */`;
    const normalized = normalizeDocCommentText(rawJsDoc, "typescript");
    expect(normalized).toContain("Performs calculation on input values.");
    expect(normalized).toContain("**Parameter** `a` — The first operand");
    expect(normalized).toContain("**Returns** — The calculated sum");
    expect(normalized).toContain("**Throws** `IllegalArgumentException` — If operands are invalid");
    expect(normalized).toContain("⚠️ **Deprecated:** Use modern calculateV2 instead");
    expect(normalized).toContain("**See also:** MathHelper");
  });

  it("sanitizes dangerous HTML and scripts from doc comments", () => {
    const dangerousMarkdown = `# Dangerous Title
<script>alert('pwned')</script>
<img src="x" onerror="alert(1)" />
<a href="javascript:alert(1)">Malicious Link</a>

[Safe Link](https://taomni.org/docs)`;
    const rendered = renderDocCommentHtml(dangerousMarkdown);
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("onerror");
    expect(rendered).not.toContain("href=\"javascript:");
    expect(rendered).toContain("href=\"https://taomni.org/docs\"");
    expect(rendered).toContain("Documentation image unavailable");
  });

  it("caps oversized documentation without dropping the visible fallback", () => {
    const rendered = renderDocCommentHtml("A".repeat(50_001));
    expect(rendered).toContain("Documentation truncated");
    expect(rendered.length).toBeLessThan(60_000);
  });

  it("extracts doc comment ranges from source text", () => {
    const javaSource = `package com.example;

/**
 * Main application entrypoint.
 * @param args Command line arguments
 */
public class Main {
    /**
     * Helper method.
     * @return status code
     */
    public int run() {
        return 0;
    }
}
`;
    const docs = extractDocComments(javaSource, "java");
    expect(docs.length).toBe(2);
    expect(docs[0].cleanMarkdown).toContain("Main application entrypoint.");
    expect(docs[0].startLine).toBe(2);
    expect(docs[0].endLine).toBe(5);
    expect(docs[1].cleanMarkdown).toContain("Helper method.");
  });

  it("returns empty array for unsupported languages", () => {
    const plainSource = `/** not a doc */ hello world`;
    expect(extractDocComments(plainSource, "plain")).toEqual([]);
  });

  it("reads and writes reader mode preference per file", () => {
    const wsId = "ws-test";
    const fileKey = "file-123";

    expect(readReaderModePreference(wsId, fileKey)).toBe(false);
    writeReaderModePreference(wsId, fileKey, true);
    expect(readReaderModePreference(wsId, fileKey)).toBe(true);
    writeReaderModePreference(wsId, fileKey, false);
    expect(readReaderModePreference(wsId, fileKey)).toBe(false);
  });
});
