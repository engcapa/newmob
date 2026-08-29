import { describe, expect, it } from "vitest";
import {
  createClipboardCompareSession,
  createFileCompareSession,
  validateCompareEligibility,
} from "./editorCompareModel";

describe("editorCompareModel", () => {
  it("validates size and binary content eligibility", () => {
    expect(validateCompareEligibility("hello world", "file.ts").valid).toBe(true);
    expect(validateCompareEligibility("hello\0world", "binary.bin").valid).toBe(false);
    expect(validateCompareEligibility("a".repeat(3 * 1024 * 1024), "large.txt").valid).toBe(false);
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
      "const y = 2;",
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
});
