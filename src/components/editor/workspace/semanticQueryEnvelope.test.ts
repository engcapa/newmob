import { describe, expect, it } from "vitest";
import type { LspLocation } from "../../../lib/editor/lsp";
import {
  applyRoleFilter,
  buildSemanticEnvelope,
  roleClassificationAvailable,
  type UsageQueryV3,
} from "./semanticQueryEnvelope";

const location = (line: number): LspLocation => ({
  uri: `file:///repo/A.java`,
  path: "/repo/A.java",
  range: { start: { line, character: 4 }, end: { line, character: 12 } },
});

const evidenceInput = {
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 3 },
  projectFingerprint: "e".repeat(64),
  uri: "file:///repo/A.java",
  revision: 4,
} as const;

describe("buildSemanticEnvelope §8.20.5", () => {
  it("wraps results with the kind-specific capability and never claims complete", () => {
    const envelope = buildSemanticEnvelope({
      kind: "usages",
      evidence: evidenceInput,
      results: [location(1), location(2)],
    });
    expect(envelope.queryId).toMatch(/^usages:usages\.find:3:\d+$/);
    expect(envelope.evidence.capabilityId).toBe("usages.find");
    expect(envelope.evidence.coverage.complete).toBe(false);
    expect(envelope.evidence.coverage.reason).toContain("completeness not claimed");
    expect(envelope.nextPageToken).toBeNull();
    expect(envelope.results).toHaveLength(2);
  });

  it("mints distinct query ids per kind and request", () => {
    const a = buildSemanticEnvelope({ kind: "declaration", evidence: evidenceInput, results: [] });
    const b = buildSemanticEnvelope({ kind: "call-hierarchy", evidence: evidenceInput, results: [] });
    expect(a.queryId).not.toBe(b.queryId);
    expect(a.evidence.capabilityId).toBe("navigation.declaration");
    expect(b.evidence.capabilityId).toBe("hierarchy.call");
  });
});

describe("applyRoleFilter §8.20.5 honesty rule", () => {
  it("keeps unknown-role rows regardless of filter state", () => {
    const rows = [{ role: "unknown" as const }, { role: "read" as const }];
    expect(applyRoleFilter(rows, ["write"])).toEqual([{ role: "unknown" }]);
    expect(applyRoleFilter(rows, [])).toEqual(rows);
  });

  it("filters by provider-assigned roles when a provider supplies them", () => {
    const rows = [
      { role: "read" as const },
      { role: "write" as const },
      { role: "declaration" as const },
      { role: "unknown" as const },
    ];
    expect(applyRoleFilter(rows, ["read", "write"]).map((row) => row.role))
      .toEqual(["read", "write", "unknown"]);
  });

  it("roleClassificationAvailable is false for empty or partially classified sets", () => {
    expect(roleClassificationAvailable([])).toBe(false);
    expect(roleClassificationAvailable([{ role: "read" }, { role: "unknown" }])).toBe(false);
    expect(roleClassificationAvailable([{ role: "read" }, { role: "write" }])).toBe(true);
  });

  it("validates UsageQueryV3 structure matches §8.20.5", () => {
    const query: UsageQueryV3 = {
      symbol: {
        uri: "file:///repo/A.java",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        displayName: "A",
        providerSymbolId: "sym-1",
      },
      scope: "project",
      includeDeclaration: true,
      includeLibraries: false,
      roleFilter: ["read", "write"],
    };
    expect(query.scope).toBe("project");
    expect(query.roleFilter).toEqual(["read", "write"]);
    expect(query.symbol.displayName).toBe("A");
  });
});
