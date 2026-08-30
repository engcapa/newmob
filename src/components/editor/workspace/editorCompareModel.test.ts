import { describe, expect, it } from "vitest";
import {
  createUnavailableCompareSession,
  createClipboardCompareSession,
  createFileCompareSession,
  MAX_COMPARE_SIZE_BYTES,
  normalizeCompareText,
  validateCompareEligibility,
} from "./editorCompareModel";

describe("editorCompareModel", () => {
  it("validates size and binary content eligibility", () => {
    expect(validateCompareEligibility("hello world", "file.ts").valid).toBe(true);
    expect(validateCompareEligibility("hello\0world", "binary.bin").valid).toBe(false);
    expect(validateCompareEligibility("a".repeat(3 * 1024 * 1024), "large.txt").valid).toBe(false);
    expect(validateCompareEligibility("界".repeat(Math.ceil(MAX_COMPARE_SIZE_BYTES / 3)), "unicode.txt")).toMatchObject({
      valid: false,
      unavailable: { reason: "oversized" },
    });
  });

  it("normalizes display text while retaining source EOL and byte metadata", () => {
    expect(normalizeCompareText("\uFEFFone\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    const result = createFileCompareSession(
      { title: "Old.ts", text: "one\r\ntwo", encoding: "windows-1252", bom: true, sizeBytes: 99 },
      { title: "New.ts", text: "one\ntwo" },
    );
    expect(result.session?.left).toMatchObject({
      text: "one\ntwo",
      eol: "CRLF",
      encoding: "windows-1252",
      bom: true,
      sizeBytes: 99,
    });
  });

  it("creates clipboard compare session using whole file or selection", () => {
    const whole = createClipboardCompareSession("App.tsx", "/src/App.tsx", "const x = 1;", "const x = 2;");
    expect(whole.session?.title).toContain("Compare \"App.tsx\" with Clipboard");
    expect(whole.session?.left.text).toBe("const x = 2;");
    expect(whole.session?.right.text).toBe("const x = 1;");

    const selection = createClipboardCompareSession(
      "App.tsx",
      "/src/App.tsx",
      "const x = 1;\nconst y = 2;",
      "const y = 3;",
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 12 },
        text: "const y = 2;",
      },
    );
    expect(selection.session?.title).toContain("Selection");
    expect(selection.session?.right.text).toBe("const y = 2;");
  });

  it("creates file compare session between two files", () => {
    const res = createFileCompareSession(
      { title: "Old.ts", text: "line 1" },
      { title: "New.ts", text: "line 2" },
    );
    expect(res.session).toBeTruthy();
    expect(res.session?.left.text).toBe("line 1");
    expect(res.session?.right.text).toBe("line 2");
  });

  it("keeps a typed unavailable source on the shared surface", () => {
    const session = createUnavailableCompareSession({
      source: "file",
      title: "Compare selected file",
      unavailableTitle: "Selected file",
      reason: "binary",
      message: "File appears to be binary",
      right: { title: "Active.ts", text: "const value = 1;" },
    });
    expect(session.left.unavailable).toEqual({
      reason: "binary",
      message: "File appears to be binary",
    });
    expect(session.right.text).toBe("const value = 1;");
  });
});
