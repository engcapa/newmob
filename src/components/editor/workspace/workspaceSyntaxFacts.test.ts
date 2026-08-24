import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import {
  lspPositionFromOffset,
  observeSyntaxFacts,
  treeRevisionField,
} from "./workspaceSyntaxFacts";

function javaState(text: string) {
  return EditorState.create({
    doc: text,
    extensions: [java(), treeRevisionField],
  });
}

describe("§8.19.8 syntax facts from the live Lezer tree", () => {
  it("aligns a whole-statement selection to its exact node (ignoring indent)", () => {
    const source = "class A {\n  void m() {\n    doWork();\n  }\n}\n";
    const state = javaState(source);
    const line = state.doc.line(3); // "    doWork();"
    const facts = observeSyntaxFacts(state, line.from, line.to);
    expect(facts).not.toBeNull();
    if (!facts) return;
    // Lezer names the aligned statement node itself; leading indentation is
    // trimmed before the exact-boundary check.
    expect(facts.alignedNodeType).toBe("ExpressionStatement");
    expect(facts.parseErrorsInScope).toBe(false);
    expect(facts.selectionNodeRange).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 13 }, // exclusive end after "doWork();"
    });
  });

  it("reports no alignment for partial-token ranges", () => {
    const source = "class A {\n  void m() {\n    doWork();\n  }\n}\n";
    const state = javaState(source);
    const line = state.doc.line(3);
    // Half of the statement is not a node boundary.
    const facts = observeSyntaxFacts(state, line.from + 2, line.from + 8);
    expect(facts?.alignedNodeType ?? null).toBeNull();
    expect(facts?.selectionNodeRange ?? null).toBeNull();
  });

  it("flags parse errors inside the scope of an unterminated string", () => {
    const source = 'class A {\n  void m() {\n    log("unterminated;\n  }\n}\n';
    const state = javaState(source);
    const line = state.doc.line(3);
    const facts = observeSyntaxFacts(state, line.from, line.to);
    // The broken line cannot align to a clean statement node; errors surface.
    if (facts?.alignedNodeType != null && !facts.parseErrorsInScope) {
      throw new Error("unterminated string must not yield clean syntax-tree provenance");
    }
    expect(facts ? facts.parseErrorsInScope || facts.alignedNodeType === null : true).toBe(true);
  });

  it("carries the live treeRevision and bumps it on document edits", () => {
    const state = javaState("class A {}\n");
    expect(state.field(treeRevisionField, false) ?? 0).toBe(0);
    const facts = observeSyntaxFacts(state, 0, state.doc.length);
    if (facts) expect(facts.treeRevision).toBe(0);
    const updated = state.update({ changes: { from: 10, insert: "// x\n" } });
    expect(updated.state.field(treeRevisionField)).toBe(1);
    const after = observeSyntaxFacts(updated.state, 0, updated.state.doc.length);
    if (after) expect(after.treeRevision).toBe(1);
  });

  it("stays null for languages without a parser instead of inventing nodes", () => {
    const state = EditorState.create({
      doc: "plain text\n",
      extensions: [treeRevisionField],
    });
    expect(observeSyntaxFacts(state, 0, state.doc.length)).toBeNull();
  });

  it("maps offsets through lspPositionFromOffset on every line", () => {
    const state = javaState("class A {\r\n\tint x = 1;\r\n}\r\n");
    const line2 = state.doc.line(2); // "\tint x = 1;" (CRLF normalized by CM)
    expect(line2.text).toBe("\tint x = 1;");
    expect(lspPositionFromOffset(state, line2.from)).toEqual({ line: 1, character: 0 });
    expect(lspPositionFromOffset(state, line2.to)).toEqual({ line: 1, character: 11 });
  });

  it("keeps JS parseable sources honest for non-Java adapters", () => {
    const state = EditorState.create({
      doc: "function f() {\n  g();\n}\n",
      extensions: [javascript(), treeRevisionField],
    });
    const line = state.doc.line(2);
    const facts = observeSyntaxFacts(state, line.from, line.to);
    expect(facts?.parseErrorsInScope).toBe(false);
  });
});
