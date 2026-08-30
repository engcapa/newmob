import { describe, expect, it } from "vitest";
import { isDiagnosticScopeCurrent, type DiagnosticScope } from "./diagnosticScopeModel";

describe("isDiagnosticScopeCurrent", () => {
  const scope: DiagnosticScope = {
    fileKey: "root:repo:src/main.ts",
    revision: 4,
    providerId: "typescript",
    providerGeneration: 2,
    uri: "file:///repo/src/main.ts",
  };

  it("accepts the exact file, revision, provider, generation, and URI", () => {
    expect(isDiagnosticScopeCurrent({ ...scope }, scope)).toBe(true);
  });

  it.each([
    ["file", { fileKey: "root:repo:src/other.ts" }],
    ["revision", { revision: 5 }],
    ["provider", { providerId: "java" }],
    ["generation", { providerGeneration: 3 }],
    ["URI", { uri: "file:///repo/src/renamed.ts" }],
  ])("rejects a changed %s identity", (_label, change) => {
    expect(isDiagnosticScopeCurrent({ ...scope, ...change }, scope)).toBe(false);
  });

  it("rejects an absent scope", () => {
    expect(isDiagnosticScopeCurrent(null, scope)).toBe(false);
    expect(isDiagnosticScopeCurrent(undefined, scope)).toBe(false);
  });
});
