/**
 * Typed expectations for the real-provider jdtls fixture matrix (§8.19.4
 * R3-c). Each entry describes one scenario's observable contract; committed
 * traces under `traces/<fixture>.trace.json` are compared field-by-field
 * against these entries by `jdtlsTraceContract.test.ts`. A mismatch is a
 * documented difference, never silently relaxed to keep the suite green.
 */

export type JdtlsFixtureId =
  | "maven-single"
  | "maven-multi-module"
  | "gradle-single"
  | "gradle-multi-module"
  | "maven-broken-classpath";

export type TraceAssertion =
  /** Completion satisfied with at least `minItems` items in the popup list. */
  | { type: "completion"; minItems?: number }
  /** Negative case: the absence predicate itself must have been satisfied. */
  | { type: "completion-absent" }
  /** completionItem/resolve delivered at least N additional edits incl. text. */
  | { type: "resolve"; minAdditionalEdits: number; includesText: string }
  /** Merged acceptance reverts to the original document sha256 exactly. */
  | { type: "revert-restores-hash" }
  /** Provider restart recovered: same case green on a fresh session. */
  | { type: "restart-ok" };

export interface JdtlsTraceExpectation {
  caseId: string;
  fixture: JdtlsFixtureId;
  /** Scenario key inside the trace when it differs from caseId. */
  scenarioKey?: string;
  assert: TraceAssertion;
  /**
   * What IDEA 2026.2 does for the same scenario (candidate category, scope,
   * import & undo result) — curated from documented behaviour, NOT machine-
   * recorded. G2/L3 idea-compare upgrades require an explicit recording.
   */
  ideaExpected: string;
}

export const JDTLS_FIXTURE_EXPECTATIONS: readonly JdtlsTraceExpectation[] = [
  {
    caseId: "jdk-type",
    fixture: "maven-single",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "Basic lists java.lang.String under 'String' with full FQ detail; no import needed.",
  },
  {
    caseId: "static-member",
    fixture: "maven-single",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "Member completion after '.' lists static asList family ranked above instance noise.",
  },
  {
    caseId: "generic-overload",
    fixture: "maven-single",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "append overloads appear per signature; Smart Completion would rank by expected type.",
  },
  {
    caseId: "dependency-source-import",
    fixture: "maven-single",
    assert: { type: "resolve", minAdditionalEdits: 1, includesText: "import org.apache.commons.lang3.StringUtils;" },
    // Real observed difference (trace, 2026-08-24): raw jdtls also offers
    // com.sun.tools.javac.util.StringUtils as a same-name twin; IDEA ranks the
    // project dependency far above JDK-internal symbols. The runner pins the
    // expected twin via detailContains so the resolve import is unambiguous.
    ideaExpected: "Accepting a non-imported dependency type inserts the FQN import together with the call; javac-internal twins are ranked last / flagged.",
  },
  {
    caseId: "dependency-import-undo",
    fixture: "maven-single",
    scenarioKey: "dependency-source-import",
    assert: { type: "revert-restores-hash" },
    ideaExpected: "One undo removes the inserted call AND its import atomically.",
  },
  {
    caseId: "test-source-set",
    fixture: "maven-single",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "JUnit symbols complete inside src/test but not in main sources.",
  },
  {
    caseId: "cross-module-type",
    fixture: "maven-multi-module",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "CoreUtil from module core completes in app without any extra action.",
  },
  {
    caseId: "cross-module-import-resolve",
    fixture: "maven-multi-module",
    scenarioKey: "cross-module-type",
    assert: { type: "resolve", minAdditionalEdits: 1, includesText: "import com.example.core.CoreUtil;" },
    ideaExpected: "Auto-import adds exactly com.example.core.CoreUtil on accept.",
  },
  {
    caseId: "ambiguous-same-name-types",
    fixture: "maven-multi-module",
    assert: { type: "completion", minItems: 2 },
    ideaExpected: "Both Result twins are offered side by side distinguished by their FQNs.",
  },
  {
    caseId: "gradle-import-sanity",
    fixture: "gradle-single",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "Gradle project model imported: JDK types complete normally.",
  },
  {
    caseId: "gradle-cross-module-type",
    fixture: "gradle-multi-module",
    scenarioKey: "cross-module-type",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "GCore from :core completes in :app.",
  },
  {
    caseId: "missing-dependency-candidate-absent",
    fixture: "maven-broken-classpath",
    assert: { type: "completion-absent" },
    ideaExpected: "Broken classpath never fabricates candidates for unresolvable libraries.",
  },
  {
    caseId: "jdk-still-completes-on-broken-classpath",
    fixture: "maven-broken-classpath",
    assert: { type: "completion", minItems: 1 },
    ideaExpected: "java.lang completion survives a broken library entry.",
  },
  {
    caseId: "restart-recovery",
    fixture: "maven-single",
    assert: { type: "restart-ok" },
    ideaExpected: "After a provider crash IDEA restarts jdtls and completion recovers on the same project.",
  },
];
