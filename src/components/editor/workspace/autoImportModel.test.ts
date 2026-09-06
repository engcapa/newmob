import { describe, expect, it } from "vitest";
import {
  planAutoImport,
  scanPastedTypeTokens,
  DEFAULT_AUTO_IMPORT_SETTINGS,
  type AutoImportCandidate,
} from "./autoImportModel";

describe("ED-IMPORT-001: autoImportModel on-the-fly and paste auto-import", () => {
  const docWithPackage = `package com.example;

public class MyService {
    List<String> items;
}
`;

  const docWithImports = `package com.example;

import java.util.Map;
import java.util.Set;

public class MyService {
}
`;

  const listCandidates: AutoImportCandidate[] = [
    {
      symbolName: "List",
      fullyQualifiedName: "java.util.List",
      sourcePackage: "java.util",
      origin: "classpath",
      priority: 10,
    },
    {
      symbolName: "List",
      fullyQualifiedName: "java.awt.List",
      sourcePackage: "java.awt",
      origin: "classpath",
      priority: 1,
    },
  ];

  it("auto-applies single unambiguous candidate on-the-fly", () => {
    const candidate: AutoImportCandidate = {
      symbolName: "ArrayList",
      fullyQualifiedName: "java.util.ArrayList",
      sourcePackage: "java.util",
      origin: "provider",
    };

    const plan = planAutoImport({
      symbolName: "ArrayList",
      candidates: [candidate],
      documentText: docWithImports,
    });

    expect(plan.outcome).toBe("auto-apply");
    if (plan.outcome === "auto-apply") {
      expect(plan.candidate.fullyQualifiedName).toBe("java.util.ArrayList");
      expect(plan.importStatement).toBe("import java.util.ArrayList;\n");
      expect(plan.insertionOffset).toBeGreaterThan(0);
    }
  });

  it("identifies ambiguous candidates and requests user choice", () => {
    const plan = planAutoImport({
      symbolName: "List",
      candidates: listCandidates,
      documentText: docWithPackage,
    });

    expect(plan.outcome).toBe("ambiguous");
    if (plan.outcome === "ambiguous") {
      expect(plan.candidates).toHaveLength(2);
      expect(plan.candidates[0].fullyQualifiedName).toBe("java.util.List");
      expect(plan.requiresPrompt).toBe(true);
    }
  });

  it("filters out excluded package candidates", () => {
    const candidates: AutoImportCandidate[] = [
      {
        symbolName: "Unsafe",
        fullyQualifiedName: "sun.misc.Unsafe",
        sourcePackage: "sun.misc",
        origin: "classpath",
      },
    ];

    const plan = planAutoImport({
      symbolName: "Unsafe",
      candidates,
      documentText: docWithPackage,
      settings: DEFAULT_AUTO_IMPORT_SETTINGS,
    });

    expect(plan.outcome).toBe("none");
    if (plan.outcome === "none") {
      expect(plan.reason).toBe("excluded");
    }
  });

  it("ignores already imported types", () => {
    const candidate: AutoImportCandidate = {
      symbolName: "Map",
      fullyQualifiedName: "java.util.Map",
      sourcePackage: "java.util",
      origin: "classpath",
    };

    const plan = planAutoImport({
      symbolName: "Map",
      candidates: [candidate],
      documentText: docWithImports,
    });

    expect(plan.outcome).toBe("none");
    if (plan.outcome === "none") {
      expect(plan.reason).toBe("already-imported");
    }
  });

  it("respects paste import modes (ask, none, all)", () => {
    const candidate: AutoImportCandidate = {
      symbolName: "UUID",
      fullyQualifiedName: "java.util.UUID",
      sourcePackage: "java.util",
      origin: "classpath",
    };

    // Mode: none
    const planNone = planAutoImport({
      symbolName: "UUID",
      candidates: [candidate],
      documentText: docWithPackage,
      settings: { ...DEFAULT_AUTO_IMPORT_SETTINGS, pasteImportMode: "none" },
      isPaste: true,
    });
    expect(planNone.outcome).toBe("none");
    if (planNone.outcome === "none") {
      expect(planNone.reason).toBe("paste-mode-none");
    }

    // Mode: ask
    const planAsk = planAutoImport({
      symbolName: "UUID",
      candidates: [candidate],
      documentText: docWithPackage,
      settings: { ...DEFAULT_AUTO_IMPORT_SETTINGS, pasteImportMode: "ask" },
      isPaste: true,
    });
    expect(planAsk.outcome).toBe("ambiguous");

    // Mode: all
    const planAll = planAutoImport({
      symbolName: "UUID",
      candidates: [candidate],
      documentText: docWithPackage,
      settings: { ...DEFAULT_AUTO_IMPORT_SETTINGS, pasteImportMode: "all" },
      isPaste: true,
    });
    expect(planAll.outcome).toBe("auto-apply");
  });

  it("scans pasted code for capitalized type tokens", () => {
    const pasted = `
      List<String> items = new ArrayList<>();
      Map<UUID, UserDTO> userMap = Maps.newHashMap();
    `;
    const tokens = scanPastedTypeTokens(pasted);
    expect(tokens).toEqual(["List", "String", "ArrayList", "Map", "UUID", "UserDTO", "Maps"]);
  });

  it("parses provider import candidates and assigns priorities (ED-IMPORT-001-A1)", async () => {
    const { parseProviderImportCandidates } = await import("./autoImportModel");
    const actions = [
      { title: "Import 'List' (java.awt.List)" },
      { title: "Import 'List' (java.util.List)" },
      { title: "Add import 'java.io.File'" },
    ];

    const parsed = parseProviderImportCandidates(actions);
    expect(parsed).toHaveLength(3);

    const listCandidates = parsed.filter((c) => c.symbolName === "List");
    expect(listCandidates).toHaveLength(2);

    const utilList = listCandidates.find((c) => c.fullyQualifiedName === "java.util.List");
    const awtList = listCandidates.find((c) => c.fullyQualifiedName === "java.awt.List");

    expect(utilList?.priority).toBeGreaterThan(awtList?.priority ?? 0);
  });

  it("applies zero edits when generation is stale or facts are unready (ED-IMPORT-001-A3)", () => {
    const candidate: AutoImportCandidate = {
      symbolName: "ArrayList",
      fullyQualifiedName: "java.util.ArrayList",
      sourcePackage: "java.util",
      origin: "provider",
    };

    // Stale generation
    const planStale = planAutoImport({
      symbolName: "ArrayList",
      candidates: [candidate],
      documentText: docWithImports,
      generation: 2,
      expectedGeneration: 3,
    });
    expect(planStale.outcome).toBe("none");
    if (planStale.outcome === "none") {
      expect(planStale.reason).toBe("stale-generation");
    }

    // Unready facts
    const planUnready = planAutoImport({
      symbolName: "ArrayList",
      candidates: [candidate],
      documentText: docWithImports,
      projectFactsStatus: "loading",
    });
    expect(planUnready.outcome).toBe("none");
    if (planUnready.outcome === "none") {
      expect(planUnready.reason).toBe("unready-facts");
    }
  });

  it("proves paste and on-the-fly settings are completely independent (ED-IMPORT-001-A2)", () => {
    const candidate: AutoImportCandidate = {
      symbolName: "UUID",
      fullyQualifiedName: "java.util.UUID",
      sourcePackage: "java.util",
      origin: "classpath",
    };

    // on-the-fly OFF, paste ALL -> paste should auto-apply
    const planPaste = planAutoImport({
      symbolName: "UUID",
      candidates: [candidate],
      documentText: docWithPackage,
      settings: {
        ...DEFAULT_AUTO_IMPORT_SETTINGS,
        addUnambiguousImportsOnTheFly: false,
        pasteImportMode: "all",
      },
      isPaste: true,
    });
    expect(planPaste.outcome).toBe("auto-apply");

    // on-the-fly ON, paste NONE -> paste should NOT auto-apply
    const planNoPaste = planAutoImport({
      symbolName: "UUID",
      candidates: [candidate],
      documentText: docWithPackage,
      settings: {
        ...DEFAULT_AUTO_IMPORT_SETTINGS,
        addUnambiguousImportsOnTheFly: true,
        pasteImportMode: "none",
      },
      isPaste: true,
    });
    expect(planNoPaste.outcome).toBe("none");
    if (planNoPaste.outcome === "none") {
      expect(planNoPaste.reason).toBe("paste-mode-none");
    }
  });

  it("plans paste auto-imports and builds atomic change transaction (ED-IMPORT-001-A4)", async () => {
    const { planPasteAutoImports, buildPasteWithImportsChanges } = await import("./autoImportModel");
    const pasted = "List<String> list = new ArrayList<>();";
    const candidates: AutoImportCandidate[] = [
      {
        symbolName: "List",
        fullyQualifiedName: "java.util.List",
        sourcePackage: "java.util",
        origin: "classpath",
        priority: 10,
      },
      {
        symbolName: "ArrayList",
        fullyQualifiedName: "java.util.ArrayList",
        sourcePackage: "java.util",
        origin: "provider",
        priority: 10,
      },
    ];

    const plan = planPasteAutoImports({
      pastedText: pasted,
      documentText: docWithPackage,
      candidates,
      settings: { ...DEFAULT_AUTO_IMPORT_SETTINGS, pasteImportMode: "all" },
      projectFactsStatus: "ready",
      generation: 1,
      expectedGeneration: 1,
    });

    expect(plan.outcome).toBe("auto-apply");
    if (plan.outcome === "auto-apply") {
      expect(plan.appliedCandidates).toHaveLength(2);
      expect(plan.importStatements).toContain("import java.util.List;\n");
      expect(plan.importStatements).toContain("import java.util.ArrayList;\n");

      // Build single atomic change transaction
      const pasteOffset = docWithPackage.indexOf("List<String>");
      const tx = buildPasteWithImportsChanges({
        documentText: docWithPackage,
        pasteOffset,
        pastedText: pasted,
        importStatements: plan.importStatements,
        insertionOffset: plan.insertionOffset,
      });

      expect(tx.changes.length).toBeGreaterThanOrEqual(1);
      expect(tx.newDocumentText).toContain("import java.util.List;\n");
      expect(tx.newDocumentText).toContain("import java.util.ArrayList;\n");
      expect(tx.newDocumentText).toContain(pasted);
    }
  });
});
