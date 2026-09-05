import { describe, expect, it } from "vitest";
import {
  planCleanup,
  planRearrange,
  type CleanupInput,
  type RearrangeInput,
} from "./rearrangeCleanupWorkflow";

describe("ED-STYLE-002: Rearrange / Cleanup independent workflows", () => {
  describe("planRearrange", () => {
    it("fails closed when rearrange is unsupported by provider with honest reason", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: false,
        capabilities: { rearrangeSupported: false },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No member-rearrangement provider is available");
      }
    });

    it("rejects read-only files honestly", () => {
      const input: RearrangeInput = {
        scope: "file",
        targetPath: "/repo/libs/String.class",
        languageId: "java",
        readOnly: true,
        hasSelection: false,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("is read-only");
      }
    });

    it("executes when provider explicitly advertises rearrange capability", () => {
      const input: RearrangeInput = {
        scope: "selection",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        hasSelection: true,
        capabilities: { rearrangeSupported: true },
      };

      const decision = planRearrange(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "selection",
        stage: "rearrange",
      });
    });
  });

  describe("planCleanup", () => {
    it("fails closed when cleanup is unsupported by provider", () => {
      const input: CleanupInput = {
        scope: "file",
        targetPath: "/repo/src/Main.java",
        languageId: "java",
        readOnly: false,
        capabilities: { cleanupSupported: false },
      };

      const decision = planCleanup(input);
      expect(decision.kind).toBe("unavailable");
      if (decision.kind === "unavailable") {
        expect(decision.reason).toContain("No code cleanup provider is available");
      }
    });

    it("executes when cleanup is supported with profile", () => {
      const input: CleanupInput = {
        scope: "module",
        targetPath: "/repo/app",
        languageId: "java",
        readOnly: false,
        profileId: "full-cleanup",
        capabilities: { cleanupSupported: true, supportedProfiles: ["full-cleanup"] },
      };

      const decision = planCleanup(input);
      expect(decision).toEqual({
        kind: "execute",
        scope: "module",
        stage: "cleanup",
        profileId: "full-cleanup",
      });
    });
  });
});
