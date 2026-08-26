// The frontend TS program has no node type globals (@types/node is not part
// of the app build); these imports are resolved by vitest at runtime.
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JDTLS_FIXTURE_EXPECTATIONS,
  type JdtlsFixtureId,
} from "./jdtlsFixtureExpectations";

/**
 * §8.19.4 R3-c trace contract: the committed sanitized traces produced by
 * `runner/run-jdtls-fixture.mjs` must satisfy every expectation. These tests
 * gate the provider evidence — regenerating traces re-runs against real
 * jdtls; editing expectations without rerunning the runner is a documented
 * lie and will fail here.
 */

/**
 * Resolve the fixtures directory without trusting import.meta.url: vitest
 * environments (jsdom) may rewrite it, so anchor on the repo layout instead.
 * `process` is reached through globalThis because the frontend tsconfig has
 * no DOM+node merged globals.
 */
function fixtureDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "src/components/editor/workspace/__fixtures__/jdtls"),
    // Fallback for runs started inside src/components/editor/workspace.
    join(cwd, "__fixtures__/jdtls"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "traces"))) ?? candidates[0];
}

const TRACE_DIR = fixtureDir();
const FIXTURE_IDS = [...new Set(JDTLS_FIXTURE_EXPECTATIONS.map((entry) => entry.fixture))];

interface TraceScenario {
  caseId: string;
  kind?: string;
  requests?: Array<{ satisfied: boolean; itemCount: number; evaluationReason: string | null }>;
  resolve?: { additionalEditCount: number; additionalEditTexts: readonly string[] } | null;
  acceptance?: { revertRestoresOriginalHash: boolean } | null;
  signatureHelp?: {
    satisfied: boolean;
    signaturesCount: number;
    labels: readonly string[];
    activeParameter: number | null;
    evaluationReason: string | null;
  } | null;
  supersede?: {
    firstOutcome: string;
    firstCancelled: boolean;
    secondSatisfied: boolean;
  } | null;
  hover?: {
    contentsPresent: boolean;
    contentsKind: string | null;
    externalLinks: readonly string[];
    excerpt: string | null;
    evaluationReason: string | null;
  } | null;
}

interface ProviderChannels {
  signatureHelpProvider: boolean;
  hoverProvider: boolean;
  declaredTypeInfoChannel: boolean;
  declaredStaticDataChannel: boolean;
}

interface FixtureTrace {
  schemaVersion: number;
  fixtureId: JdtlsFixtureId;
  sanitized: boolean;
  toolchain: Record<string, unknown>;
  buildModelFingerprint: string;
  scenarios: TraceScenario[];
  providerChannels?: ProviderChannels;
  restart?: {
    performed: boolean;
    completionOkAfterRestart: boolean;
    signatureHelpOkAfterRestart?: boolean | null;
  };
  failures: readonly string[];
}

function loadTrace(fixtureId: JdtlsFixtureId): FixtureTrace | null {
  const path = join(TRACE_DIR, "traces", `${fixtureId}.trace.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as FixtureTrace;
}

describe("§8.19.4 real jdtls trace contract", () => {
  for (const fixtureId of FIXTURE_IDS) {
    it(`has a committed sanitized trace for ${fixtureId}`, () => {
      const trace = loadTrace(fixtureId);
      expect(trace, `missing traces/${fixtureId}.trace.json — run runner/run-jdtls-fixture.mjs`).not.toBeNull();
      expect(trace!.schemaVersion).toBe(1);
      expect(trace!.sanitized).toBe(true);
      expect(trace!.buildModelFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("records a pinned toolchain", () => {
    const any = loadTrace(FIXTURE_IDS[0])!;
    expect((any.toolchain.jdtls as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
    expect((any.toolchain.java as { info: { major: number } }).info.major).toBe(21);
  });

  it("keeps absolute home/project paths out of the traces", () => {
    for (const fixtureId of FIXTURE_IDS) {
      const raw = readFileSync(join(TRACE_DIR, "traces", `${fixtureId}.trace.json`), "utf8");
      expect(raw, fixtureId).not.toContain("/home/zhyhang");
      // The runner's throwaway -data workspaces never survive sanitization.
      expect(raw, fixtureId).not.toMatch(/taomni-r3-/);
    }
  });

  for (const entry of JDTLS_FIXTURE_EXPECTATIONS) {
    it(`${entry.caseId} (${entry.fixture})`, () => {
      const trace = loadTrace(entry.fixture)!;
      const scenario = trace.scenarios.find((candidate) => candidate.caseId === (entry.scenarioKey ?? entry.caseId));

      switch (entry.assert.type) {
        case "completion":
        case "completion-absent": {
          expect(scenario, `scenario ${entry.caseId} missing from ${entry.fixture} trace`).toBeDefined();
          const last = scenario!.requests?.at(-1);
          expect(last?.satisfied, scenario ? (last?.evaluationReason ?? undefined) : undefined).toBe(true);
          if (entry.assert.type === "completion" && entry.assert.minItems !== undefined) {
            expect(last!.itemCount).toBeGreaterThanOrEqual(entry.assert.minItems);
          }
          break;
        }
        case "resolve": {
          // Local binding: TS narrowing of `entry.assert` does not survive
          // into the predicate closure below.
          const assertion = entry.assert;
          expect(scenario?.resolve, `no resolve recorded for ${entry.caseId}`).not.toBeNull();
          expect(scenario!.resolve!.additionalEditCount).toBeGreaterThanOrEqual(assertion.minAdditionalEdits);
          expect(
            scenario!.resolve!.additionalEditTexts.some((text) => text.includes(assertion.includesText)),
            JSON.stringify(scenario!.resolve!.additionalEditTexts),
          ).toBe(true);
          break;
        }
        case "revert-restores-hash": {
          expect(scenario?.acceptance, `no acceptance record for ${entry.caseId}`).not.toBeNull();
          expect(scenario!.acceptance!.revertRestoresOriginalHash).toBe(true);
          break;
        }
        case "restart-ok": {
          expect(trace.restart?.performed).toBe(true);
          expect(trace.restart?.completionOkAfterRestart).toBe(true);
          break;
        }
        case "signature-help": {
          const assertion = entry.assert;
          expect(scenario?.signatureHelp, `no signatureHelp record for ${entry.caseId}`).not.toBeNull();
          expect(scenario!.signatureHelp!.satisfied, scenario!.signatureHelp!.evaluationReason ?? undefined).toBe(true);
          expect(scenario!.signatureHelp!.signaturesCount).toBeGreaterThanOrEqual(assertion.minSignatures ?? 1);
          if (assertion.labelContains !== undefined) {
            expect(
              scenario!.signatureHelp!.labels.some((label) => label.includes(assertion.labelContains!)),
              JSON.stringify(scenario!.signatureHelp!.labels),
            ).toBe(true);
          }
          if (assertion.activeParameterEquals !== undefined) {
            expect(scenario!.signatureHelp!.activeParameter).toBe(assertion.activeParameterEquals);
          }
          break;
        }
        case "hover-doc": {
          expect(scenario?.hover, `no hover record for ${entry.caseId}`).not.toBeNull();
          expect(scenario!.hover!.contentsPresent, scenario!.hover!.evaluationReason ?? undefined).toBe(true);
          break;
        }
        case "supersede-cancelled-first": {
          expect(scenario?.supersede, `no supersede record for ${entry.caseId}`).not.toBeNull();
          expect(scenario!.supersede!.firstCancelled).toBe(true);
          // The replacement request must satisfy — cancel is not a outage.
          expect(scenario!.supersede!.secondSatisfied).toBe(true);
          break;
        }
        case "channel-absent": {
          const channels = trace.providerChannels;
          expect(channels, `no providerChannels record in ${entry.fixture} trace`).toBeDefined();
          const declared = entry.assert.channel === "typeInfoChannel"
            ? channels!.declaredTypeInfoChannel
            : channels!.declaredStaticDataChannel;
          expect(declared, `${entry.fixture} unexpectedly declares a channel; the unavailable contract must be re-evaluated`).toBe(false);
          break;
        }
        case "restart-signature-ok": {
          expect(trace.restart?.performed).toBe(true);
          expect(trace.restart?.signatureHelpOkAfterRestart, "signatureHelp did not recover after restart").toBe(true);
          break;
        }
      }
    });
  }

  it("restart recovery is recorded green", () => {
    const trace = loadTrace("maven-single")!;
    expect(trace.restart?.performed).toBe(true);
    expect(trace.restart?.completionOkAfterRestart).toBe(true);
  });
});
