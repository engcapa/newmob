import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_IMPORT_SETTINGS,
  parseProviderImportCandidates,
  planAutoImport,
  planPasteAutoImports,
  type AutoImportCandidate,
} from "./autoImportModel";
import { pasteEditorWithAutoImports } from "./workspaceEditorCommands";

describe("ED-IMPORT-001: Provider-backed on-the-fly and paste auto-import", () => {
  // Provider action fixtures representing real language server responses
  const providerListActions = [
    { title: "Import 'List' (java.util.List)" },
    { title: "Import 'List' (java.awt.List)" },
  ];

  const providerMapActions = [
    { title: "Add import 'java.util.Map'" },
    { title: "Add import 'com.sun.javafx.collections.ObservableMapWrapper'" },
  ];

  const providerUniqueActions = [
    { title: "Import 'ArrayList' (java.util.ArrayList)" },
  ];

  describe("ED-IMPORT-001-A1: unique, ambiguous, excluded, prioritized flows match policy", () => {
    it("parses provider code action titles into typed AutoImportCandidates with priorities", () => {
      const candidates = parseProviderImportCandidates(providerListActions);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toEqual({
        symbolName: "List",
        fullyQualifiedName: "java.util.List",
        sourcePackage: "java.util",
        origin: "provider",
        priority: 10,
      });
      expect(candidates[1]).toEqual({
        symbolName: "List",
        fullyQualifiedName: "java.awt.List",
        sourcePackage: "java.awt",
        origin: "provider",
        priority: 1,
      });
    });

    it("auto-applies unique candidate according to policy", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n  ArrayList list;\n}\n";

      const plan = planAutoImport({
        symbolName: "ArrayList",
        candidates,
        documentText: doc,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("auto-apply");
      if (plan.outcome === "auto-apply") {
        expect(plan.candidate.fullyQualifiedName).toBe("java.util.ArrayList");
        expect(plan.importStatement).toBe("import java.util.ArrayList;\n");
      }
    });

    it("detects ambiguous candidates and requires user prompt instead of silently picking", () => {
      const candidates = parseProviderImportCandidates(providerListActions);
      const doc = "package com.example;\n\npublic class Foo {\n  List list;\n}\n";

      const plan = planAutoImport({
        symbolName: "List",
        candidates,
        documentText: doc,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("ambiguous");
      if (plan.outcome === "ambiguous") {
        expect(plan.candidates).toHaveLength(2);
        expect(plan.requiresPrompt).toBe(true);
        // Prioritized: java.util (10) comes before java.awt (1)
        expect(plan.candidates[0].sourcePackage).toBe("java.util");
        expect(plan.candidates[1].sourcePackage).toBe("java.awt");
      }
    });

    it("filters excluded packages and auto-applies remaining unexcluded candidate", () => {
      const candidates = parseProviderImportCandidates(providerMapActions);
      const doc = "package com.example;\n\npublic class Foo {\n  Map map;\n}\n";

      const plan = planAutoImport({
        symbolName: "Map",
        candidates,
        documentText: doc,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          excludedPackages: ["com.sun.*"],
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      // The com.sun.* candidate was excluded, leaving only java.util.Map
      expect(plan.outcome).toBe("auto-apply");
      if (plan.outcome === "auto-apply") {
        expect(plan.candidate.fullyQualifiedName).toBe("java.util.Map");
      }
    });

    it("rejects candidates when all match excluded package wildcards", () => {
      const candidates: AutoImportCandidate[] = [
        {
          symbolName: "Unsafe",
          fullyQualifiedName: "sun.misc.Unsafe",
          sourcePackage: "sun.misc",
          origin: "provider",
        },
      ];
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const plan = planAutoImport({
        symbolName: "Unsafe",
        candidates,
        documentText: doc,
        settings: DEFAULT_AUTO_IMPORT_SETTINGS,
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("none");
      if (plan.outcome === "none") {
        expect(plan.reason).toBe("excluded");
      }
    });
  });

  describe("ED-IMPORT-001-A2: paste and on-the-fly settings are independent", () => {
    it("paste import mode 'none' disables paste auto-import even when on-the-fly is enabled", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const plan = planPasteAutoImports({
        pastedText: "ArrayList<String> list = new ArrayList<>();",
        documentText: doc,
        candidates,
        settings: {
          addUnambiguousImportsOnTheFly: true, // on-the-fly is ON
          optimizeImportsOnTheFly: false,
          pasteImportMode: "none", // paste mode is NONE
          excludedPackages: [],
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("none");
      if (plan.outcome === "none") {
        expect(plan.reason).toBe("paste-mode-none");
      }
    });

    it("paste import mode 'all' auto-applies imports even when on-the-fly is disabled", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const plan = planPasteAutoImports({
        pastedText: "ArrayList<String> list = new ArrayList<>();",
        documentText: doc,
        candidates,
        settings: {
          addUnambiguousImportsOnTheFly: false, // on-the-fly is OFF
          optimizeImportsOnTheFly: false,
          pasteImportMode: "all", // paste mode is ALL
          excludedPackages: [],
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(plan.outcome).toBe("auto-apply");
      if (plan.outcome === "auto-apply") {
        expect(plan.appliedCandidates[0].fullyQualifiedName).toBe("java.util.ArrayList");
        expect(plan.importStatements).toEqual(["import java.util.ArrayList;\n"]);
      }
    });
  });

  describe("ED-IMPORT-001-A3: stale generations apply zero edits", () => {
    it("on-the-fly planning yields zero edits when generation changed from expected", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const plan = planAutoImport({
        symbolName: "ArrayList",
        candidates,
        documentText: doc,
        projectFactsStatus: "ready",
        generation: 5,
        expectedGeneration: 4, // Mismatched generation
      });

      expect(plan.outcome).toBe("none");
      if (plan.outcome === "none") {
        expect(plan.reason).toBe("stale-generation");
      }
    });

    it("paste auto-import planning yields zero edits when generation is stale", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const plan = planPasteAutoImports({
        pastedText: "ArrayList<String> list = new ArrayList<>();",
        documentText: doc,
        candidates,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          pasteImportMode: "all",
        },
        projectFactsStatus: "ready",
        generation: 7,
        expectedGeneration: 6, // Stale!
      });

      expect(plan.outcome).toBe("none");
      if (plan.outcome === "none") {
        expect(plan.reason).toBe("stale-generation");
      }
    });

    it("planning yields zero edits when project facts status is untrusted or unready", () => {
      const candidates = parseProviderImportCandidates(providerUniqueActions);
      const doc = "package com.example;\n\npublic class Foo {\n}\n";

      const untrustedPlan = planAutoImport({
        symbolName: "ArrayList",
        candidates,
        documentText: doc,
        projectFactsStatus: "untrusted",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(untrustedPlan.outcome).toBe("none");
      if (untrustedPlan.outcome === "none") {
        expect(untrustedPlan.reason).toBe("untrusted-facts");
      }

      const loadingPlan = planPasteAutoImports({
        pastedText: "ArrayList<String> list;",
        documentText: doc,
        candidates,
        projectFactsStatus: "loading",
        generation: 1,
        expectedGeneration: 1,
      });
      expect(loadingPlan.outcome).toBe("none");
      if (loadingPlan.outcome === "none") {
        expect(loadingPlan.reason).toBe("unready-facts");
      }
    });
  });

  describe("ED-IMPORT-001-A4: provider-backed fixture proves import and one undo", () => {
    it("executes atomic paste + provider imports in CodeMirror and reverses completely in one undo", () => {
      const initialDoc = [
        "package com.example.service;",
        "",
        "public class OrderService {",
        "  public void process() {",
        "    // cursor here",
        "  }",
        "}",
        "",
      ].join("\n");

      const cursorOffset = initialDoc.indexOf("// cursor here");
      const view = new EditorView({
        state: EditorState.create({
          doc: initialDoc,
          selection: EditorSelection.cursor(cursorOffset),
          extensions: [history()],
        }),
      });

      // Provider code actions simulate language server response
      const providerActions = [
        { title: "Import 'List' (java.util.List)" },
        { title: "Import 'HashMap' (java.util.HashMap)" },
      ];
      const parsed = parseProviderImportCandidates(providerActions);

      const pasteSnippet = "List<String> items = new ArrayList<>();\n    HashMap<String, Object> map = new HashMap<>();";

      const pastePlan = planPasteAutoImports({
        pastedText: pasteSnippet,
        documentText: initialDoc,
        candidates: parsed,
        settings: {
          ...DEFAULT_AUTO_IMPORT_SETTINGS,
          pasteImportMode: "all",
        },
        projectFactsStatus: "ready",
        generation: 1,
        expectedGeneration: 1,
      });

      expect(pastePlan.outcome).toBe("auto-apply");
      if (pastePlan.outcome !== "auto-apply") throw new Error("Plan failed");

      // Verify import statements produced
      expect(pastePlan.importStatements).toEqual([
        "import java.util.List;\n",
        "import java.util.HashMap;\n",
      ]);

      // Execute paste with auto-imports on the real CodeMirror editor
      const applied = pasteEditorWithAutoImports(view, {
        pastedText: pasteSnippet,
        importStatements: pastePlan.importStatements,
      });
      expect(applied).toBe(true);

      const documentAfterPaste = view.state.doc.toString();
      // Verify import statements inserted at correct package-relative location
      expect(documentAfterPaste).toContain("package com.example.service;\nimport java.util.List;\nimport java.util.HashMap;\n");
      // Verify pasted snippet inserted at cursor
      expect(documentAfterPaste).toContain("List<String> items = new ArrayList<>();");

      // CRITICAL A4 ACCEPTANCE: Single transaction means exactly one undo entry in the undo stack
      expect(undoDepth(view.state)).toBe(1);

      // Perform a single undo
      const undone = undo(view);
      expect(undone).toBe(true);

      // Verify the entire document is restored to its exact pre-paste preimage in one step!
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(undoDepth(view.state)).toBe(0);

      view.destroy();
    });
  });
});
