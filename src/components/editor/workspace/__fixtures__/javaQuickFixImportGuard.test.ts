import { describe, expect, it } from "vitest";

const FORBIDDEN_SYMBOLS = [
  "javaQuickFix",
  "JDK_KNOWN_TYPES",
  "createJavaImportCodeActions",
  "generateJavaImportWorkspaceEdit",
  "getJavaJdkCompletionCandidates",
];

const productionSources = import.meta.glob(
  [
    "/src/**/*.{ts,tsx}",
    "!/src/**/__fixtures__/**",
    "!/src/**/*.test.{ts,tsx}",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("P0-J1 javaQuickFix containment guard", () => {
  it("production sources never import or reference the Java quick-fix fixture", () => {
    expect(Object.keys(productionSources).length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const [file, content] of Object.entries(productionSources)) {
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (content.includes(symbol)) {
          offenders.push(`${file} references ${symbol}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
