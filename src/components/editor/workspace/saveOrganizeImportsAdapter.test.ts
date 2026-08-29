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
