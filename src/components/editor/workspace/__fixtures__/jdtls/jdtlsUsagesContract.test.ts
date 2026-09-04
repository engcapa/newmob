// ED-USAGE-002 provider contract: the committed sanitized trace produced by
// `runner/run-jdtls-usages-fixture.mjs` must satisfy every expectation below.
// Regenerating the trace re-runs against real JDT LS; editing the trace by
// hand is a documented lie and fails here.
//
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

interface UsagesScenario {
  id: string;
  attempts: Array<{ ms: number; itemCount: number }>;
  itemCount: number;
  satisfied: boolean;
  declarationHit: boolean;
  ownershipCounts: Record<string, number>;
  locations: Array<{ uri: string; range: unknown }>;
}

interface UsagesTrace {
  schemaVersion: number;
  fixtureId: string;
  sanitized: boolean;
  toolchain: { java: { version: string }; jdtls: { version: string } };
  scenarios: UsagesScenario[];
  failures: string[];
}

function loadTrace(): UsagesTrace {
  const path = join(fixtureDir(), "traces", "usages-maven-single.trace.json");
  return JSON.parse(readFileSync(path, "utf8")) as UsagesTrace;
}

describe("ED-USAGE-002: JDT LS references provider contract", () => {
  it("commits a sanitized trace from the pinned provider", () => {
    const trace = loadTrace();
    expect(trace.schemaVersion).toBe(1);
    expect(trace.fixtureId).toBe("usages-maven-single");
    expect(trace.sanitized).toBe(true);
    expect(trace.toolchain.jdtls.version).toContain("1.61.0");
    expect(trace.toolchain.java.version).toContain("21.0.4");
    expect(trace.failures).toEqual([]);
  });

  it("proves workspace declaration plus usage rows (A2)", () => {
    const trace = loadTrace();
    const app = trace.scenarios.find((scenario) => scenario.id === "workspace-symbol-App");
    expect(app).toBeDefined();
    expect(app?.satisfied).toBe(true);
    expect(app?.declarationHit).toBe(true);
    expect(app?.itemCount).toBeGreaterThanOrEqual(2);
    const uris = (app?.locations ?? []).map((location) => location.uri);
    expect(uris.some((uri) => uri.includes("App.java"))).toBe(true);
    expect(uris.some((uri) => uri.includes("AppTest.java"))).toBe(true);
  });

  it("proves library-symbol workspace usage without fabricating roles (A2)", () => {
    const trace = loadTrace();
    const lib = trace.scenarios.find((scenario) => scenario.id === "library-symbol-StringUtils");
    expect(lib).toBeDefined();
    expect(lib?.satisfied).toBe(true);
    expect(lib?.itemCount).toBeGreaterThanOrEqual(1);
  });
});
