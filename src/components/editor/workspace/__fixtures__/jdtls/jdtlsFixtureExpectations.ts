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
  | { type: "restart-ok" }
  /** §8.20.2 W1: signatureHelp returned a usable overload family. */
  | { type: "signature-help"; minSignatures?: number; labelContains?: string; activeParameterEquals?: number }
  /** §8.20.2 W1: hover delivered non-empty provider documentation. */
  | { type: "hover-doc" }
  /** §8.20.2 W1: $/cancelRequest aborted the in-flight request before use. */
  | { type: "supersede-cancelled-first" }
  /** §8.20.2 W1: the provider declares NO channel for this reference kind. */
  | { type: "channel-absent"; channel: "typeInfoChannel" | "staticDataChannel" }
  /** §8.20.2 W1: signatureHelp recovers on a fresh session after SIGKILL. */
  | { type: "restart-signature-ok" }
  /** §8.20.3 W2: the provider reported its own identity (serverInfo). */
  | { type: "analysis-server-info" }
  /** §8.20.3 W2: import/analysis work-done progress was observed live. */
  | { type: "analysis-progress-observed" }
  /**
   * §8.20.3 W2: lifecycle-only provider — java.project.* executeCommands are
   * NOT registered, so module facts are honestly absent (degraded/partial
   * contract, never complete).
   */
  | { type: "analysis-lifecycle-only" }
  /** §8.20.3 W2: a build-file change triggered fresh provider progress. */
  | { type: "analysis-build-change-generation" }
  /** §8.20.3 W2: warm restart reached first satisfied completion faster. */
  | { type: "analysis-offline-cache-faster" }
  /** §8.20.3 W2: diagnostics flagged incomplete/missing classpath members. */
  | { type: "analysis-broken-classpath-flagged" }
  /**
   * §8.20.4 W3: the unresolved-type diagnostic IS published, but jdt.ls 1.61
   * never ANSWERS textDocument/codeAction (hang on healthy and broken files
   * alike). The trace must record that honestly instead of faking a fix.
   */
  | { type: "quickfix-provider-hang-recorded" };

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

  // ---- §8.20.2 W1: Reference Information over real jdtls. ----------------
  {
    caseId: "sig-overload-family",
    fixture: "maven-single",
    assert: { type: "signature-help", minSignatures: 2, labelContains: "append" },
    ideaExpected: "Parameter Info lists the StringBuilder.append overload family with the active one highlighted and the parameter under the caret bolded.",
  },
  {
    caseId: "sig-active-parameter-advance",
    fixture: "maven-single",
    assert: { type: "signature-help", minSignatures: 1, activeParameterEquals: 1 },
    ideaExpected: "Moving the caret past an argument comma highlights the next parameter of the matching overload (activeParameter advances).",
  },
  {
    caseId: "sig-nested-inner",
    fixture: "maven-single",
    assert: { type: "signature-help", minSignatures: 1, labelContains: "parseInt" },
    ideaExpected: "Inside a nested call the INNER invocation owns Parameter Info at its own argument list.",
  },
  {
    caseId: "sig-nested-outer",
    fixture: "maven-single",
    assert: { type: "signature-help", minSignatures: 1, labelContains: "valueOf" },
    ideaExpected: "With the caret in the outer argument list, Parameter Info resolves the outer call (String.valueOf).",
  },
  {
    caseId: "sig-generic",
    fixture: "maven-single",
    assert: { type: "signature-help", minSignatures: 1, labelContains: "singletonList" },
    ideaExpected: "Generic methods show their instantiated signature; IDEA renders <T>singletonList(T) per the inferred type arguments.",
  },
  {
    caseId: "sig-supersede-cancel",
    fixture: "maven-single",
    assert: { type: "supersede-cancelled-first" },
    ideaExpected: "Caret moves cancel the outstanding Parameter Info query; no stale tooltip ever renders from it.",
  },
  {
    caseId: "hover-project-symbol",
    fixture: "maven-single",
    assert: { type: "hover-doc" },
    ideaExpected: "Quick Documentation on a project symbol shows its javadoc rendered, with links into the project source.",
  },
  {
    caseId: "hover-jdk-symbol",
    fixture: "maven-single",
    assert: { type: "hover-doc" },
    ideaExpected: "Quick Documentation on String.valueOf shows the JDK javadoc without any download step.",
  },
  {
    caseId: "hover-library-symbol",
    fixture: "maven-single",
    assert: { type: "hover-doc" },
    ideaExpected: "Library symbols document from attached sources; without sources IDEA decompiles or shows the signature-level info instead of nothing.",
  },
  {
    caseId: "channel-type-info-absent",
    fixture: "maven-single",
    scenarioKey: "__providerChannels",
    assert: { type: "channel-absent", channel: "typeInfoChannel" },
    ideaExpected: "IDEA's Type Info (Ctrl+Shift+P) is PSI-backed; plain LSP servers expose no equivalent channel — an honest unavailable contract is required.",
  },
  {
    caseId: "channel-static-data-absent",
    fixture: "maven-single",
    scenarioKey: "__providerChannels",
    assert: { type: "channel-absent", channel: "staticDataChannel" },
    ideaExpected: "IDEA's Java Expression Static Data comes from JetBrains analysis; LSP providers expose nothing similar — discoverable action + explicit unavailable only.",
  },
  {
    caseId: "restart-signature-ok",
    fixture: "maven-single",
    assert: { type: "restart-signature-ok" },
    ideaExpected: "After a provider restart, Parameter Info recovers together with completion on the same project.",
  },

  // ---- §8.20.3 W2: Project Analysis truth over real jdtls. ---------------
  {
    caseId: "analysis-server-info",
    fixture: "maven-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-server-info" },
    ideaExpected: "IDEA knows its own build (Help → About); the workspace must equally surface WHICH provider version backs semantic features.",
  },
  {
    caseId: "analysis-progress-observed",
    fixture: "maven-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-progress-observed" },
    ideaExpected: "IDEA shows live import/analysis progress and gates smart features on it; the workspace derives its phase from exactly these provider reports.",
  },
  {
    caseId: "analysis-lifecycle-only",
    fixture: "maven-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-lifecycle-only" },
    ideaExpected: "IDEA exposes full module/source-root/classpath models via PSI; plain LSP lifecycle alone must degrade to partial — never claim complete.",
  },
  {
    caseId: "analysis-build-change-generation",
    fixture: "maven-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-build-change-generation" },
    ideaExpected: "Editing a pom/build file re-imports the project in IDEA; stale semantic results are invalidated by that generation bump.",
  },
  {
    caseId: "analysis-offline-cache-faster",
    fixture: "maven-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-offline-cache-faster" },
    ideaExpected: "IDEA's warmed indexes make project reopen faster than first import; reused provider state should show the same direction.",
  },
  {
    caseId: "analysis-server-info-gradle",
    fixture: "gradle-single",
    scenarioKey: "__analysis",
    assert: { type: "analysis-server-info" },
    ideaExpected: "Provider identity is workspace-independent infrastructure truth.",
  },
  {
    caseId: "analysis-progress-observed-multi-module",
    fixture: "maven-multi-module",
    scenarioKey: "__analysis",
    assert: { type: "analysis-progress-observed" },
    ideaExpected: "Multi-module imports report per-project progress; the phase derivation consumes it identically.",
  },
  {
    caseId: "analysis-broken-classpath-flagged",
    fixture: "maven-broken-classpath",
    scenarioKey: "__analysis",
    assert: { type: "analysis-broken-classpath-flagged" },
    ideaExpected: "Broken classpath surfaces as degraded analysis state in IDEA, explaining why semantic actions cannot be trusted there.",
  },
  {
    caseId: "import-quick-fix",
    fixture: "maven-single",
    scenarioKey: "__quickFix",
    assert: { type: "quickfix-provider-hang-recorded" },
    ideaExpected: "IDEA offers Import on an unresolved simple name and one undo restores the pre-fix state. Real jdt.ls 1.61 under this launch recipe never answers codeAction — a documented provider difference (re-open when the server-side block is identified or a newer jdt.ls responds).",
  },
];
