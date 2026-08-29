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
});
