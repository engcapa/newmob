import { describe, expect, it } from "vitest";
import type { ImmutableCodeActionPlan } from "./codeActionProviderAdapter";
import { validateAndApplyOrganizeImportsPlan } from "./saveOrganizeImportsAdapter";

describe("§ED-SAVE-002: Save Organize Imports Plan-Only Adapter", () => {
  const basePlan = (overrides: Partial<ImmutableCodeActionPlan> = {}): ImmutableCodeActionPlan => ({
    actionId: "action-org-imports-1",
    title: "Organize Imports",
    kind: "source.organizeImports",
    document: {
      uri: "file:///workspace/src/App.java",
      revision: 5,
      languageId: "java",
    },
    provider: {
      id: "jdtls",
      version: "1.61.0",
      generation: 2,
      projectFingerprint: "fp-save-org",
      trusted: true,
    },
    edit: {
      documentEdits: [
        {
          uri: "file:///workspace/src/App.java",
          path: "/workspace/src/App.java",
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "import java.util.List;\nimport java.util.Map;\n",
            },
          ],
        },
      ],
    },
    command: null,
    evidence: null,
    createdAt: Date.now(),
    ...overrides,
  });

  it("applies valid single-file organize imports plan in-memory", () => {
    const text = "import java.util.Map;\nimport java.util.List;\n\nclass App {}\n";
    const plan = basePlan();
    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);

    expect(result.valid).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.transformedText).toBe("import java.util.List;\nimport java.util.Map;\n\nclass App {}\n");
  });

  it("applies normalized provider edits once when documentEdits and operations mirror each other", () => {
    const text = "class App {}\n";
    const document = {
      uri: "file:///workspace/src/App.java",
      path: "/workspace/src/App.java",
      version: 5,
      edits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import java.util.List;\n",
      }],
    };
    const plan = basePlan({
      edit: {
        documentEdits: [document],
        operations: [{ kind: "text", document }],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      plan,
      5,
    );
    expect(result.valid).toBe(true);
    expect(result.transformedText).toBe("import java.util.List;\nclass App {}\n");
  });

  it("rejects command-only action as typed unavailable in save normalization", () => {
    const text = "class App {}\n";
    const plan = basePlan({
      edit: null,
      command: {
        command: "java.action.organizeImportsCommand",
        arguments: [],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("command-only-not-supported");
    expect(result.transformedText).toBeNull();
  });

  it("rejects an edit with a command continuation or the wrong action kind", () => {
    const text = "class App {}\n";
    const commandContinuation = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan({
        command: { command: "java.action.finishOrganizeImports", arguments: [] },
      }),
      5,
    );
    expect(commandContinuation.valid).toBe(false);
    expect(commandContinuation.reason).toBe("edit-with-command-not-supported-in-save-normalization");

    const wrongKind = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan({ kind: "quickfix" }),
      5,
    );
    expect(wrongKind.valid).toBe(false);
    expect(wrongKind.reason).toBe("unexpected-code-action-kind");
  });

  it("rejects multi-file edit containing foreign URIs as typed unavailable in single-file save", () => {
    const text = "class App {}\n";
    const plan = basePlan({
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/App.java",
            path: "/workspace/src/App.java",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import A;\n" }],
          },
          {
            uri: "file:///workspace/src/Other.java",
            path: "/workspace/src/Other.java",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import B;\n" }],
          },
        ],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("multi-file-edit-unsupported");
    expect(result.transformedText).toBeNull();
  });

  it("rejects wrong URI target as typed unavailable", () => {
    const text = "class App {}\n";
    const plan = basePlan({
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/Wrong.java",
            path: "/workspace/src/Wrong.java",
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// change\n" }],
          },
        ],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.transformedText).toBeNull();
  });

  it("rejects a plan whose frozen document identity does not match the save target", () => {
    const text = "class App {}\n";
    const plan = basePlan({
      document: {
        uri: "file:///workspace/src/Other.java",
        revision: 5,
        languageId: "java",
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("plan-document-uri-mismatch");
    expect(result.transformedText).toBeNull();
  });

  it("rejects stale plan and edit document revisions", () => {
    const text = "class App {}\n";
    const stalePlan = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan(),
      6,
    );
    expect(stalePlan.valid).toBe(false);
    expect(stalePlan.reason).toBe("plan-document-revision-mismatch");

    const staleEdit = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan({
        edit: {
          documentEdits: [{
            uri: "file:///workspace/src/App.java",
            path: "/workspace/src/App.java",
            version: 4,
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import A;\n",
            }],
          }],
        },
      }),
      5,
    );
    expect(staleEdit.valid).toBe(false);
    expect(staleEdit.reason).toBe("edit-document-version-mismatch");
  });

  it("rejects resource operations and out-of-bounds ranges", () => {
    const text = "class App {}\n";
    const resourceOperation = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan({
        edit: {
          documentEdits: [],
          operations: [{
            kind: "create",
            uri: "file:///workspace/src/Generated.java",
            path: "/workspace/src/Generated.java",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
      }),
      5,
    );
    expect(resourceOperation.valid).toBe(false);
    expect(resourceOperation.reason).toBe("resource-operation-not-supported-in-save-normalization");

    const outOfBounds = validateAndApplyOrganizeImportsPlan(
      text,
      "file:///workspace/src/App.java",
      basePlan({
        edit: {
          documentEdits: [{
            uri: "file:///workspace/src/App.java",
            path: "/workspace/src/App.java",
            edits: [{
              range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
              newText: "bad",
            }],
          }],
        },
      }),
      5,
    );
    expect(outOfBounds.valid).toBe(false);
    expect(outOfBounds.reason).toBe("range-out-of-bounds");
  });

  it("rejects invalid inverted ranges as typed failed", () => {
    const text = "class App {}\n";
    const plan = basePlan({
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/App.java",
            path: "/workspace/src/App.java",
            edits: [
              {
                range: { start: { line: 5, character: 10 }, end: { line: 2, character: 0 } }, // Inverted start > end!
                newText: "bad",
              },
            ],
          },
        ],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("inverted-range");
    expect(result.transformedText).toBeNull();
  });

  it("detects and rejects overlapping edit ranges as typed failed", () => {
    const text = "import A;\nimport B;\nimport C;\n";
    const plan = basePlan({
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/App.java",
            path: "/workspace/src/App.java",
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
                newText: "import X;\n",
              },
              {
                range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } }, // Overlaps line 1!
                newText: "import Y;\n",
              },
            ],
          },
        ],
      },
    });

    const result = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", plan);
    expect(result.valid).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("overlapping-edits-detected");
    expect(result.transformedText).toBeNull();
  });

  it("returns unavailable when plan is null or empty", () => {
    const text = "class App {}\n";
    const resultNull = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", null);
    expect(resultNull.valid).toBe(false);
    expect(resultNull.status).toBe("unavailable");

    const planEmpty = basePlan({ edit: { documentEdits: [] } });
    const resultEmpty = validateAndApplyOrganizeImportsPlan(text, "file:///workspace/src/App.java", planEmpty);
    expect(resultEmpty.valid).toBe(false);
    expect(resultEmpty.status).toBe("unavailable");
  });
});
