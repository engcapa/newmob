import { describe, expect, it } from "vitest";
import {
  completeStatementPlan,
  filterGenerateCodeActions,
  smartCompletionGate,
  surroundKindsForLanguage,
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

  it("labels plans local-text unless node evidence proves syntax alignment (§8.19.8)", () => {
    // No syntax facts at all → local-text, never the old lying syntax-tree tag.
    const plain = surroundWithPlan("if", facts);
    if (plain.kind !== "editor-transaction") throw new Error("expected a plan");
    expect(plain.provenance).toEqual({ kind: "local-text", ruleId: "surround.if" });
    expect(plain.evidenceV2.identity).toBeNull();
    expect(plain.evidenceV2.completeness).toBe("partial");

    // Aligned node but parse errors in scope → still local-text, error recorded.
    const errorScope = surroundWithPlan("while", {
      ...facts,
      syntax: {
        alignedNodeType: "ExpressionStatement",
        treeRevision: 4,
        selectionNodeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        parseErrorsInScope: true,
      },
    });
    if (errorScope.kind !== "editor-transaction") throw new Error("expected a plan");
    expect(errorScope.provenance.kind).toBe("local-text");
    expect(errorScope.evidenceV2.parseErrorsInScope).toBe(true);

    // Exact node alignment with clean parse upgrades to syntax-tree.
    const aligned = surroundWithPlan("try-catch", {
      ...facts,
      syntax: {
        alignedNodeType: "ExpressionStatement",
        treeRevision: 7,
        selectionNodeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        parseErrorsInScope: false,
      },
    });
    if (aligned.kind !== "editor-transaction") throw new Error("expected a plan");
    expect(aligned.provenance).toEqual({
      kind: "syntax-tree",
      languageId: "java",
      nodeType: "ExpressionStatement",
      treeRevision: 7,
    });
    expect(aligned.evidenceV2.completeness).toBe("complete");
    expect(aligned.evidenceV2.selectionNodeRange).not.toBeNull();
  });

  it("offers only adapter kinds per language for the dialog", () => {
    expect(surroundKindsForLanguage(null)).toEqual([]);
    expect(surroundKindsForLanguage("python")).toEqual([]);
    expect(surroundKindsForLanguage("java").map((kind) => kind.id))
      .toEqual(["if", "while", "try-catch", "synchronized", "runnable"]);
    expect(surroundKindsForLanguage("typescript").map((kind) => kind.id))
      .toEqual(["if", "while", "try-catch"]);
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
