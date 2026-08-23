/**
 * Typed expectations for the versionable jdtls fixture matrix (§8.18.3).
 *
 * Each entry describes one fixture case's observable contract. Real traces
 * are recorded per the README and compared field-by-field against these
 * expectations; a mismatch is a documented difference, never silently
 * relaxed to keep the suite green.
 */

export interface JdtlsFixtureExpectation {
  caseId: string;
  fixture: "maven-multi-module" | "gradle-single" | "ambiguous-types"
    | "snippet-method" | "static-import" | "dependency-source";
  request:
    | { kind: "completion"; mode: "typing" | "trigger" | "explicit"; ordinal: number }
    | { kind: "resolve"; label: string }
    | { kind: "acceptance"; oneDispatch: true; oneUndo: true }
    | { kind: "stale"; cause: "provider-restart" | "revision-change" };
  expect: {
    minCandidates?: number;
    isIncomplete?: boolean;
    truncatedMayBeTrue?: boolean;
    additionalEditsMin?: number;
    ambiguityChoices?: number;
    choiceOptions?: readonly string[];
    negativeNoJavaImport?: boolean;
  };
}

export const JDTLS_FIXTURE_EXPECTATIONS: readonly JdtlsFixtureExpectation[] = [
  {
    caseId: "basic-typing-dot",
    fixture: "maven-multi-module",
    request: { kind: "completion", mode: "trigger", ordinal: 1 },
    expect: { minCandidates: 1, isIncomplete: false, truncatedMayBeTrue: true },
  },
  {
    caseId: "explicit-repeat-ordinal",
    fixture: "maven-multi-module",
    request: { kind: "completion", mode: "explicit", ordinal: 2 },
    // Honest label: provider scope unchanged unless expansion is advertised.
    expect: { minCandidates: 0 },
  },
  {
    caseId: "resolve-auto-import",
    fixture: "static-import",
    request: { kind: "resolve", label: "Arrays.asList" },
    expect: { additionalEditsMin: 1 },
  },
  {
    caseId: "ambiguous-import-user-choice",
    fixture: "ambiguous-types",
    request: { kind: "acceptance", oneDispatch: true, oneUndo: true },
    expect: { ambiguityChoices: 2 },
  },
  {
    caseId: "snippet-choice-tabstops",
    fixture: "snippet-method",
    request: { kind: "acceptance", oneDispatch: true, oneUndo: true },
    expect: { choiceOptions: ["void", "int"] },
  },
  {
    caseId: "no-java-import-for-ts",
    fixture: "gradle-single",
    request: { kind: "stale", cause: "provider-restart" },
    expect: { negativeNoJavaImport: true },
  },
];
