import { describe, expect, it, beforeEach } from "vitest";
import { JavaSemanticIndex } from "./javaSemanticIndex";
import { JavaInspectionEngine } from "./javaInspectionEngine";
import { SemanticRefactorEngine } from "./semanticRefactorPlan";

describe("Java Semantic Foundation, Inspection & Refactor Suite (J1-J3)", () => {
  let index: JavaSemanticIndex;
  let inspectionEngine: JavaInspectionEngine;
  let refactorEngine: SemanticRefactorEngine;

  beforeEach(() => {
    index = new JavaSemanticIndex();
    inspectionEngine = new JavaInspectionEngine();
    refactorEngine = new SemanticRefactorEngine();
  });

  it("J1: indexes Java classes, methods, and type hierarchies", () => {
    const javaCode = `package com.example.service;

public class OrderService extends BaseService implements IService {
    public void processOrder() {
        validate();
    }
}`;
    index.indexFile("/src/OrderService.java", javaCode);

    const symbols = index.findSymbols("OrderService");
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0].kind).toBe("class");

    const hierarchy = index.getTypeHierarchy("com.example.service.OrderService");
    expect(hierarchy.superTypes).toContain("BaseService");
    expect(hierarchy.superTypes).toContain("IService");
  });

  it("J2: detects dead code, constant conditions, and probable null dereferences", () => {
    const buggyCode = `public class Calculator {
    public int calc(int a) {
        if (true) {
            return 42;
            int dead = a + 1;
        }
        Object obj = null;
        obj.toString();
        return 0;
    }
}`;

    const diagnostics = inspectionEngine.inspectFile("/src/Calculator.java", buggyCode, index);

    const deadCodeDiag = diagnostics.find((d) => d.ruleId === "java.deadCode");
    expect(deadCodeDiag).toBeDefined();

    const constCondDiag = diagnostics.find((d) => d.ruleId === "java.constantCondition");
    expect(constCondDiag).toBeDefined();

    const nullDerefDiag = diagnostics.find((d) => d.ruleId === "java.nullDereference");
    expect(nullDerefDiag).toBeDefined();
  });

  it("J3: creates semantic rename plan and checks conflicts", () => {
    const file1 = `public class Service {
    public void execute() {
        run();
    }
}`;
    index.indexFile("/src/Service.java", file1);

    const fileContents = new Map<string, string>();
    fileContents.set("/src/Service.java", file1);

    const plan = refactorEngine.createRenamePlan({
      symbolName: "run",
      newName: "execute",
      fileId: "/src/Service.java",
      index,
      fileContents,
    });

    expect(plan.operation).toBe("rename");
    expect(plan.editGroups.length).toBeGreaterThan(0);
    expect(plan.rollbackSnapshot["/src/Service.java"]).toBe(file1);
  });

  it("J3: blocks safe delete when external usages exist", () => {
    const file1 = `public class Util {
    public static void helper() {}
}`;
    const file2 = `public class Consumer {
    public void test() {
        helper();
    }
}`;
    index.indexFile("/src/Util.java", file1);
    index.indexFile("/src/Consumer.java", file2);

    const fileContents = new Map<string, string>();
    fileContents.set("/src/Util.java", file1);
    fileContents.set("/src/Consumer.java", file2);

    const plan = refactorEngine.createSafeDeletePlan({
      symbolName: "helper",
      fileId: "/src/Util.java",
      index,
      fileContents,
    });

    expect(plan.conflicts.some((c) => c.severity === "blocking")).toBe(true);
  });
});
