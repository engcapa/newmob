import { describe, expect, it } from "vitest";
import {
  completeStatementPlan,
  completeStatementStrategy,
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

describe("§8.19.8 Complete Statement strategy", () => {
  const aligned = (nodeType: string, parseErrorsInScope = false) => ({
    alignedNodeType: nodeType,
    treeRevision: 3,
    selectionNodeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
    parseErrorsInScope,
  });

  it("grants syntax-tree provenance only for explicit Java statement nodes", () => {
    for (const nodeType of ["ExpressionStatement", "ReturnStatement", "ThrowStatement"]) {
      const decision = completeStatementStrategy({
        languageId: "java",
        readOnly: false,
        caretCount: 1,
        lineText: "  doWork()",
        syntax: aligned(nodeType),
      });
      if (decision.kind !== "exact") throw new Error(`${nodeType} should be exact`);
      expect(decision.insertSemicolonAt).toBe(10); // trailing whitespace trimmed
      expect(decision.provenance).toMatchObject({
        kind: "syntax-tree", languageId: "java", nodeType, treeRevision: 3,
      });
      expect(decision.evidenceV2.completeness).toBe("complete");
    }
  });

  it("keeps block boundaries, headers and unknown nodes on the labelled local path", () => {
    for (const line of ["if (ready)", "{", "public void run()", "}"]) {
      const decision = completeStatementStrategy({
        languageId: "java",
        readOnly: false,
        caretCount: 1,
        lineText: line,
        syntax: aligned("Block"),
      });
      expect(decision.kind === "local" && decision.ruleId === "completeStatement.local").toBe(true);
    }
  });

  it("no-ops with a reason on multi-caret, read-only and unterminated strings", () => {
    const base = { languageId: "java", caretCount: 1, lineText: "log(\"x" };
    const multi = completeStatementStrategy({ ...base, readOnly: false, caretCount: 2, syntax: null });
    expect(multi.kind === "unavailable" && multi.reason).toContain("Multi-caret");
    const readOnly = completeStatementStrategy({ ...base, readOnly: true, caretCount: 1, syntax: null });
    expect(readOnly.kind).toBe("unavailable");
    const unterminated = completeStatementStrategy({
      ...base, readOnly: false, syntax: aligned("ExpressionStatement"),
    });
    expect(unterminated.kind === "unavailable" && unterminated.reason).toContain("Unterminated");
  });

  it("refuses the semantic upgrade when parse errors are in scope", () => {
    const decision = completeStatementStrategy({
      languageId: "java",
      readOnly: false,
      caretCount: 1,
      lineText: "doWork()",
      syntax: aligned("ExpressionStatement", true),
    });
    expect(decision.kind === "unavailable" && decision.reason).toContain("Parse errors");
  });

  it("falls back to the local heuristic without node evidence or off-Java", () => {
    const noFacts = completeStatementStrategy({
      languageId: "java", readOnly: false, caretCount: 1, lineText: "doWork()", syntax: null,
    });
    expect(noFacts).toEqual({ kind: "local", ruleId: "completeStatement.local" });
    const typescript = completeStatementStrategy({
      languageId: "typescript", readOnly: false, caretCount: 1, lineText: "doWork()",
      syntax: aligned("ExpressionStatement"),
    });
    // Java-only first batch: TS never borrows Java's node vocabulary.
    expect(typescript.kind).toBe("local");
    const terminated = completeStatementStrategy({
      languageId: "java", readOnly: false, caretCount: 1, lineText: "return x;",
      syntax: aligned("ReturnStatement"),
    });
    expect(terminated).toEqual({ kind: "local", ruleId: "completeStatement.newline-below" });
    const blank = completeStatementStrategy({
      languageId: "java", readOnly: false, caretCount: 1, lineText: "   ", syntax: null,
    });
    expect(blank).toEqual({ kind: "local", ruleId: "completeStatement.blank-line" });
  });
});

describe("§8.19.8 Generate Code candidates", () => {
  it("keeps only provider generate/refactor kinds and preserves the raw actions", () => {
    const actions = filterGenerateCodeActions([
      { title: "Generate Constructor", kind: "source.generate.constructor", raw: "a" },
      { title: "Extract variable", kind: "refactor.extract.variable", raw: "b" },
      { title: "Quick fix import", kind: "quickfix.import", raw: "c" },
      { title: "No kind at all", kind: null, raw: "d" },
    ]);
    expect(actions.map((entry) => entry.title)).toEqual(["Generate Constructor", "Extract variable"]);
    // The original provider actions survive so apply runs exactly what the
    // server sent — never a locally rebuilt template.
    expect(actions[0].item.raw).toBe("a");
    expect(actions[1].item.raw).toBe("b");
  });
});
