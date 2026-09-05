// ED-STYLE-001 provider contract: the committed sanitized trace produced by
// `runner/run-jdtls-format-fixture.mjs` must satisfy every expectation below.
// These tests gate the provider evidence — regenerating the trace re-runs
// against real JDT LS; editing the trace by hand to satisfy the assertions
// is a documented lie. The trace file carries the full request/result facts;
// this suite pins the acceptance-relevant subset.
//
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
// @ts-expect-error node webcrypto without DOM+node merged globals
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

interface FormatTrace {
  schemaVersion: number;
  fixtureId: string;
  sanitized: boolean;
  toolchain: { java: { version: string }; jdtls: { version: string } };
  formattingCapability: { advertised: boolean };
  request: { editCount: number; satisfied: boolean; attempts: Array<{ ms: number; editCount: number }> };
  postText: string | null;
  postSha256: string | null;
  markersPreserved: boolean;
  guardedLineUntouched: boolean;
  unguardedLineFixed: boolean;
  failures: string[];
}

function loadTrace(): FormatTrace {
  const path = join(fixtureDir(), "traces", "format-maven-single.trace.json");
  return JSON.parse(readFileSync(path, "utf8")) as FormatTrace;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("ED-STYLE-001: JDT LS formatting provider contract", () => {
  it("commits a sanitized trace from the pinned provider", () => {
    const trace = loadTrace();
    expect(trace.schemaVersion).toBe(1);
    expect(trace.fixtureId).toBe("format-maven-single");
    expect(trace.sanitized).toBe(true);
    expect(trace.toolchain.jdtls.version).toContain("1.61.0");
    expect(trace.toolchain.java.version).toContain("21.0.4");
    expect(trace.failures).toEqual([]);
  });

  it("advertises real documentFormatting capability and returns edits (A1/A3)", () => {
    const trace = loadTrace();
    expect(trace.formattingCapability.advertised).toBe(true);
    expect(trace.request.satisfied).toBe(true);
    expect(trace.request.editCount).toBeGreaterThanOrEqual(1);
    expect(trace.request.attempts.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps marker comments and the guarded line byte-identical (A2)", () => {
    const trace = loadTrace();
    expect(trace.markersPreserved).toBe(true);
    expect(trace.guardedLineUntouched).toBe(true);
    expect(trace.postText).toContain("// @formatter:off");
    expect(trace.postText).toContain("       int   badly_spaced  =  1;");
  });

  it("normalizes the unguarded indentation with a matching post hash (A4 preimage)", () => {
    const trace = loadTrace();
    expect(trace.unguardedLineFixed).toBe(true);
    expect(trace.postText).toContain("\n    int also_bad = 2;");
    expect(trace.postSha256).toBe(sha256(trace.postText ?? ""));
  });
});
