import { describe, expect, it } from "vitest";
import type { LspDocumentHighlight } from "../../../lib/editor/lsp";
import {
  classifyHighlightRole,
  createOccurrenceSession,
  formatOccurrenceStatus,
  isOccurrenceSessionValid,
  sortOccurrences,
  stepOccurrence,
} from "./occurrenceHighlightModel";

describe("occurrenceHighlightModel", () => {
  const sampleHighlights: LspDocumentHighlight[] = [
    {
      range: { start: { line: 20, character: 4 }, end: { line: 20, character: 10 } },
      kind: 3, // write
    },
    {
      range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
      kind: 2, // read
    },
    {
      range: { start: { line: 35, character: 0 }, end: { line: 35, character: 6 } },
      kind: 1, // text / unknown
    },
  ];

  it("classifies highlight roles accurately", () => {
    expect(classifyHighlightRole(2)).toBe("read");
    expect(classifyHighlightRole(3)).toBe("write");
    expect(classifyHighlightRole(1)).toBe("unknown");
    expect(classifyHighlightRole(null)).toBe("unknown");
    expect(classifyHighlightRole(undefined)).toBe("unknown");
  });

  it("sorts occurrences in document order and preserves roles", () => {
    const sorted = sortOccurrences(sampleHighlights);
    expect(sorted.map((s) => s.range.start.line)).toEqual([5, 20, 35]);
  });

  it("creates session and steps next/previous with looping", () => {
    const session = createOccurrenceSession(
      "fileA.ts",
      1,
      "myVar",
      sampleHighlights,
      { line: 5, character: 4 },
    );

    expect(session.currentIndex).toBe(0);
    expect(session.items[0].role).toBe("read");

    // Next -> index 1 (write)
    const step1 = stepOccurrence(session, "next");
    expect(step1.session.currentIndex).toBe(1);
    expect(step1.current?.role).toBe("write");
    expect(step1.current?.range.start.line).toBe(20);

    // Next -> index 2 (unknown)
    const step2 = stepOccurrence(step1.session, "next");
    expect(step2.session.currentIndex).toBe(2);
    expect(step2.current?.role).toBe("unknown");

    // Next -> loops back to 0
    const step3 = stepOccurrence(step2.session, "next");
    expect(step3.session.currentIndex).toBe(0);

    // Previous -> loops to 2
    const stepPrev = stepOccurrence(step3.session, "previous");
    expect(stepPrev.session.currentIndex).toBe(2);
  });

  it("formats informative status feedback with role breakdown", () => {
    const session = createOccurrenceSession("fileA.ts", 1, "myVar", sampleHighlights);
    const status = formatOccurrenceStatus(session);
    expect(status).toContain("Occurrence 1 of 3 [read]");
    expect(status).toContain("1 read, 1 write, 1 unknown");
  });

  it("validates freshness against file and revision", () => {
    const session = createOccurrenceSession("fileA.ts", 1, "myVar", sampleHighlights);
    expect(isOccurrenceSessionValid(session, "fileA.ts", 1)).toBe(true);
    expect(isOccurrenceSessionValid(session, "fileA.ts", 2)).toBe(false);
    expect(isOccurrenceSessionValid(session, "fileB.ts", 1)).toBe(false);
    expect(isOccurrenceSessionValid(null, "fileA.ts", 1)).toBe(false);
  });
});
