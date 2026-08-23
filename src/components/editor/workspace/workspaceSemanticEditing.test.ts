import { describe, expect, it } from "vitest";
import {
  completeStatementPlan,
  filterGenerateCodeActions,
  smartCompletionGate,
  surroundWithPlan,
  SURROUND_KINDS,
} from "./workspaceSemanticEditing";

describe("§8.18.8 Smart/Type-Matching gate", () => {
  it("stays unavailable with a reason for providers without expected types", () => {
    const gate = smartCompletionGate({ providerAdvertisesExpectedTypes: false, providerActive: true });
    expect(gate.available).toBe(false);
    expect(gate.reason).toBe("capability-not-advertised");
    // No "Smart" badge: fuzzy Basic results must not be relabelled.
    expect(gate.badge).toBeNull();
  });

  it("is unavailable when the provider is offline even if capable", () => {
    const gate = smartCompletionGate({ providerAdvertisesExpectedTypes: true, providerActive: false });
    expect(gate.available).toBe(false);
    expect(gate.reason).toBe("no-provider");
  });

  it("only shows the Smart badge when the capability is real", () => {
    const gate = smartCompletionGate({ providerAdvertisesExpectedTypes: true, providerActive: true });
    expect(gate.available).toBe(true);
    expect(gate.badge).toBe("Smart");
  });
});

describe("§8.18.8 Complete Statement (conservative)", () => {
  it("terminates unambiguous call tails", () => {
    const plan = completeStatementPlan({
      lineText: "  foo.bar(1)",
      nextLineStart: null,
      readOnly: false,
      languageId: "java",
    });
    expect(plan).toEqual({ insertSemicolonAt: "  foo.bar(1)".length });
  });

  it("refuses block boundaries, open headers and continuing expressions", () => {
    const base = { readOnly: false, languageId: "java" };
    for (const line of ["if (x > 0)", "{", "int x = ", "return foo(1);"]) {
      const plan = completeStatementPlan({ lineText: line, nextLineStart: null, ...base });
      if ("insertSemicolonAt" in plan) throw new Error(`${line} should not terminate`);
      expect(plan.reason.length, line).toBeGreaterThan(0);
    }
  });

  it("never edits read-only buffers", () => {
    const plan = completeStatementPlan({
      lineText: "foo()",
      nextLineStart: null,
      readOnly: true,
      languageId: "java",
    });
    if (!("kind" in plan)) throw new Error("read-only must be unavailable");
    expect(plan.reason).toContain("Read-only");
  });
});

describe("§8.18.8 Surround With", () => {
  const facts = {
    text: "doWork();",
    from: 0,
    to: 9,
    fromLineStart: true,
    toLineEnd: true,
    rangeCount: 1,
    readOnly: false,
    languageId: "java",
  };

  it("wraps whole-line Java selections and places the caret on the placeholder", () => {
    const plan = surroundWithPlan("try-catch", facts);
    expect(plan.kind).toBe("editor-transaction");
    if (plan.kind !== "editor-transaction") return;
    const inserted = String((plan.changes[0] as { insert?: string }).insert ?? "");
    expect(inserted.split("\n")[0]).toBe("try {");
    expect(inserted).toContain("} catch (Exception e) {");
    expect(inserted).toContain("doWork();");
    // Caret sits inside catch parameter area of the wrapper head.
    expect(plan.selection.anchor).toBeGreaterThan(0);
    expect(plan.evidence.rule).toBe("surround.try-catch");
  });

  it("rejects partial-token selections, multi-range and unsupported languages", () => {
    const partial = surroundWithPlan("if", { ...facts, fromLineStart: false, to: 6 });
    expect(partial.kind).toBe("unavailable");
    const multi = surroundWithPlan("while", { ...facts, rangeCount: 2 });
    expect(multi.kind).toBe("unavailable");
    const lang = surroundWithPlan("synchronized", { ...facts, languageId: "python" });
    expect(lang.kind === "unavailable" && lang.reason === "unsupported-language").toBe(true);
  });

  it("keeps the Java-only subset honest", () => {
    const runnable = surroundWithPlan("runnable", facts);
    expect(runnable.kind).toBe("editor-transaction");
    const pythonRunnable = surroundWithPlan("runnable", { ...facts, languageId: "python" });
    expect(pythonRunnable.kind).toBe("unavailable");
    expect(SURROUND_KINDS.map((kind) => kind.id)).toContain("synchronized");
  });
});

describe("§8.18.8 Generate Code candidates", () => {
  it("keeps only provider generate/refactor kinds; local templates are separate", () => {
    const actions = filterGenerateCodeActions([
      { title: "Generate Constructor", kind: "source.generate.constructor" },
      { title: "Extract variable", kind: "refactor.extract.variable" },
      { title: "Quick fix import", kind: "quickfix.import" },
      { title: "No kind at all" },
    ]);
    expect(actions.map((action) => action.title)).toEqual(["Generate Constructor", "Extract variable"]);
  });
});
