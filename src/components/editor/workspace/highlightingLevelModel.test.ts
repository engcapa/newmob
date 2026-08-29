import { beforeEach, describe, expect, it } from "vitest";
import {
  readHighlightingLevel,
  writeHighlightingLevel,
} from "./highlightingLevelModel";

describe("highlightingLevelModel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'all' when nothing is stored", () => {
    expect(readHighlightingLevel("ws-1", "file.ts")).toBe("all");
  });

  it("persists and reads back custom highlighting level", () => {
    writeHighlightingLevel("ws-1", "file.ts", "syntax");
    expect(readHighlightingLevel("ws-1", "file.ts")).toBe("syntax");

    writeHighlightingLevel("ws-1", "file.ts", "none");
    expect(readHighlightingLevel("ws-1", "file.ts")).toBe("none");

    writeHighlightingLevel("ws-1", "file.ts", "all");
    expect(readHighlightingLevel("ws-1", "file.ts")).toBe("all");
  });

  it("isolates settings by workspace and file key", () => {
    writeHighlightingLevel("ws-1", "fileA.ts", "none");
    writeHighlightingLevel("ws-1", "fileB.ts", "syntax");
    writeHighlightingLevel("ws-2", "fileA.ts", "all");

    expect(readHighlightingLevel("ws-1", "fileA.ts")).toBe("none");
    expect(readHighlightingLevel("ws-1", "fileB.ts")).toBe("syntax");
    expect(readHighlightingLevel("ws-2", "fileA.ts")).toBe("all");
  });
});
