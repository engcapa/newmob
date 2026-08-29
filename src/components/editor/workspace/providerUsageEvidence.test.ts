import { describe, expect, it } from "vitest";
import {
  classifyUsageOwnership,
  buildProviderUsageEvidenceReport,
} from "./providerUsageEvidence";
import type { UsageSymbolIdentity } from "./usageQuerySession";

describe("ED-USAGE-002: providerUsageEvidence usage role, ownership, and completeness", () => {
  const workspaceRoots = ["/workspace"];

  const querySymbol: UsageSymbolIdentity = {
    uri: "file:///workspace/src/com/example/User.java",
    range: {
      start: { line: 10, character: 18 },
      end: { line: 10, character: 22 },
    },
    displayName: "name",
    providerSymbolId: "sym-123",
  };

  describe("URI ownership classification", () => {
    it("classifies workspace file URIs", () => {
      expect(classifyUsageOwnership("file:///workspace/src/com/example/User.java", workspaceRoots)).toBe("workspace");
    });

    it("classifies external and library URIs", () => {
      expect(classifyUsageOwnership("file:///opt/jdk21/lib/src.zip", workspaceRoots)).toBe("external");
      expect(classifyUsageOwnership("jar:file:///root/.m2/repo.jar!/Class.class", workspaceRoots)).toBe("library");
    });

    it("classifies decompiled jdt URIs", () => {
      expect(classifyUsageOwnership("jdt://contents/rt.jar/java.lang/String.class", workspaceRoots)).toBe("decompiled");
      expect(classifyUsageOwnership("cfr://decompiled/Class.class", workspaceRoots)).toBe("decompiled");
    });
  });

  describe("Evidence report generation and role preservation", () => {
    it("faithfully preserves provider-reported roles without text guessing", () => {
      const locations = [
        // 1. Declaration
        {
          uri: "file:///workspace/src/com/example/User.java",
          range: { start: { line: 10, character: 18 }, end: { line: 10, character: 22 } },
          path: "/workspace/src/com/example/User.java",
        },
        // 2. Explicit write role
        {
          uri: "file:///workspace/src/com/example/UserService.java",
          range: { start: { line: 45, character: 8 }, end: { line: 45, character: 12 } },
          path: "/workspace/src/com/example/UserService.java",
          role: "write" as const,
        },
        // 3. Explicit read role
        {
          uri: "file:///workspace/src/com/example/UserController.java",
          range: { start: { line: 30, character: 24 }, end: { line: 30, character: 28 } },
          path: "/workspace/src/com/example/UserController.java",
          role: "read" as const,
        },
        // 4. Plain reference without provider role -> stays 'unknown'
        {
          uri: "file:///workspace/src/com/example/UserDTO.java",
          range: { start: { line: 15, character: 12 }, end: { line: 15, character: 16 } },
          path: "/workspace/src/com/example/UserDTO.java",
        },
        // 5. Decompiled library reference
        {
          uri: "jdt://contents/rt.jar/java.lang/Object.class",
          range: { start: { line: 100, character: 4 }, end: { line: 100, character: 8 } },
        },
      ];

      const report = buildProviderUsageEvidenceReport({
        symbol: querySymbol,
        locations,
        workspaceRoots,
        providerId: "jdtls",
        providerGeneration: 4,
        projectFingerprint: "mvnw:hash-123:/opt/jdk21",
        completeness: "complete",
      });

      expect(report.totalFound).toBe(5);
      expect(report.completeness).toBe("complete");

      expect(report.roleCounts.declaration).toBe(1);
      expect(report.roleCounts.write).toBe(1);
      expect(report.roleCounts.read).toBe(1);
      expect(report.roleCounts.unknown).toBe(2);

      expect(report.ownershipCounts.workspace).toBe(4);
      expect(report.ownershipCounts.decompiled).toBe(1);
      expect(report.ownershipCounts.library).toBe(0);
    });

    it("tracks partial completeness on truncated provider responses", () => {
      const report = buildProviderUsageEvidenceReport({
        symbol: querySymbol,
        locations: [],
        workspaceRoots,
        completeness: "partial",
      });

      expect(report.completeness).toBe("partial");
      expect(report.totalFound).toBe(0);
    });
  });
});
