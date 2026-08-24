import { describe, expect, it } from "vitest";
import { planReformat } from "./reformatWorkflow";

const BASE = {
  targetPath: "/repo/app/src/Main.java",
  languageId: "java",
  readOnly: false,
  hasSelection: false,
  capabilities: { formatting: true, rangeFormatting: true },
};

describe("§8.19.9 R8-D2 reformat decisions", () => {
  it("executes document format when the provider advertises it", () => {
    expect(planReformat({ ...BASE, scope: "file" })).toEqual({
      kind: "execute",
      scope: "file",
      stage: "format",
    });
  });

  it("routes to selection scope only with a real selection and range support", () => {
    expect(planReformat({ ...BASE, scope: "selection", hasSelection: true })).toEqual({
      kind: "execute",
      scope: "selection",
      stage: "format",
    });
    // No actual selection → silently degrades to file scope, not an error.
    expect(planReformat({ ...BASE, scope: "selection", hasSelection: false }))
      .toEqual({ kind: "execute", scope: "file", stage: "format" });
  });

  it("reports typed unavailability instead of silently no-oping", () => {
    const noProvider = planReformat({
      ...BASE,
      scope: "file",
      capabilities: { formatting: false, rangeFormatting: false },
    });
    expect(noProvider).toMatchObject({ kind: "unavailable" });
    if (noProvider.kind === "unavailable") {
      expect(noProvider.reason).toContain("java");
    }

    const noRange = planReformat({
      ...BASE,
      scope: "selection",
      hasSelection: true,
      capabilities: { formatting: true, rangeFormatting: false },
    });
    expect(noRange).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("range formatting"),
    });

    const nothingAtAll = planReformat({
      ...BASE,
      scope: "selection",
      hasSelection: true,
      capabilities: { formatting: false, rangeFormatting: false },
    });
    expect(nothingAtAll).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("selection") });
  });

  it("refuses read-only buffers and missing targets up front", () => {
    expect(planReformat({ ...BASE, scope: "file", readOnly: true })).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("read-only"),
    });
    expect(planReformat({ ...BASE, scope: "file", targetPath: null })).toMatchObject({
      kind: "unavailable",
      reason: "No formattable file is open",
    });
  });
});
