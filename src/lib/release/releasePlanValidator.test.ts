import { describe, expect, it } from "vitest";
import {
  validateArtifactPath,
  evaluateChannelCompliance,
  type ReleasePlan,
} from "./releasePlanValidator";

describe("ED-REL-003: releasePlanValidator channel and artifact root constraints", () => {
  const allowedRoots = ["qa-ui-auto-report", "evidence"];

  const samplePlan: ReleasePlan = {
    version: 1,
    releaseChannels: {
      "linux-daily-editor": {
        platform: "linux",
        requiredCapabilities: ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
        requiredEvidenceLayers: ["unit", "browser"],
        evidenceRoots: allowedRoots,
      },
    },
  };

  describe("validateArtifactPath", () => {
    it("accepts valid repo-relative paths within allowed evidence roots", () => {
      const res1 = validateArtifactPath("qa-ui-auto-report/report.html", allowedRoots);
      expect(res1.valid).toBe(true);
      expect(res1.normalizedPath).toBe("qa-ui-auto-report/report.html");

      const res2 = validateArtifactPath("evidence/screenshots/tc-ide-c0.png", allowedRoots);
      expect(res2.valid).toBe(true);
    });

    it("rejects absolute paths on Linux and Windows", () => {
      const posixAbs = validateArtifactPath("/tmp/evidence/report.html", allowedRoots);
      expect(posixAbs.valid).toBe(false);
      expect(posixAbs.reason).toBe("absolute-path-rejected");

      const winAbs = validateArtifactPath("C:\\Users\\runner\\evidence\\report.html", allowedRoots);
      expect(winAbs.valid).toBe(false);
      expect(winAbs.reason).toBe("absolute-path-rejected");
    });

    it("rejects directory traversal and parent directory escape", () => {
      const traversal1 = validateArtifactPath("qa-ui-auto-report/../../etc/passwd", allowedRoots);
      expect(traversal1.valid).toBe(false);
      expect(traversal1.reason).toBe("traversal-rejected");

      const traversal2 = validateArtifactPath("evidence/../secret.txt", allowedRoots);
      expect(traversal2.valid).toBe(false);
      expect(traversal2.reason).toBe("traversal-rejected");
    });

    it("rejects paths outside approved evidence roots", () => {
      const outside = validateArtifactPath("src/components/editor/test.png", allowedRoots);
      expect(outside.valid).toBe(false);
      expect(outside.reason).toBe("disallowed-root");
    });
  });

  describe("evaluateChannelCompliance", () => {
    it("evaluates compliant channel when all requirements and artifact constraints are met", () => {
      const compliance = evaluateChannelCompliance(
        "linux-daily-editor",
        samplePlan,
        ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
        ["unit", "browser"],
        ["qa-ui-auto-report/summary.json", "evidence/runs/log.txt"],
      );

      expect(compliance.compliant).toBe(true);
      expect(compliance.missingCapabilities).toEqual([]);
      expect(compliance.missingLayers).toEqual([]);
      expect(compliance.invalidArtifacts).toEqual([]);
    });

    it("detects missing required capabilities or missing evidence layers", () => {
      const compliance = evaluateChannelCompliance(
        "linux-daily-editor",
        samplePlan,
        ["C0-save-pipeline"], // Missing C3 and C4
        ["unit"], // Missing browser
        ["evidence/summary.json"],
      );

      expect(compliance.compliant).toBe(false);
      expect(compliance.missingCapabilities).toContain("C3-clipboard-session");
      expect(compliance.missingCapabilities).toContain("C4-tab-policy");
      expect(compliance.missingLayers).toContain("browser");
    });

    it("fails compliance if any evidence artifact violates path constraints", () => {
      const compliance = evaluateChannelCompliance(
        "linux-daily-editor",
        samplePlan,
        ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
        ["unit", "browser"],
        ["/tmp/bad-leak.png"],
      );

      expect(compliance.compliant).toBe(false);
      expect(compliance.invalidArtifacts).toHaveLength(1);
      expect(compliance.invalidArtifacts[0].reason).toContain("Absolute artifact paths are forbidden");
    });
  });
});
