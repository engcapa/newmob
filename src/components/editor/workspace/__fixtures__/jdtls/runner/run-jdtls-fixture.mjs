/**
 * Real-provider acceptance runner for Basic Completion (§8.19.4 R3-c).
 *
 * Starts actual jdtls processes (mirroring the production launch recipe in
 * src-tauri/src/lsp.rs: same JVM product flags, shared config area, -data
 * workspace, and the same completion client capabilities incl.
 * resolveSupport.additionalTextEdits), drives the documented scenarios per
 * fixture project, verifies import-on-resolve and edit reversibility against
 * hashes, kills/restarts the provider, and writes one sanitized JSON trace
 * per fixture under ../traces/.
 *
 * Usage: node run-jdtls-fixture.mjs [--fixture <id>]...
 * Environment overrides: TAOMNI_FIXTURE_JAVA, JDTLS_HOME, TAOMNI_FIXTURE_GRADLE.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, sha256 } from "./lsp-client.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");
const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");
const TRACES_DIR = join(FIXTURE_ROOT, "traces");

// ---------------------------------------------------------------------------
// Toolchain resolution (pinned versions recorded into every trace)
// ---------------------------------------------------------------------------

function resolveJava() {
  const candidate = process.env.TAOMNI_FIXTURE_JAVA
    ?? "/data/dev/jdk-21/bin/java";
  if (!existsSync(candidate)) throw new Error(`java not found at ${candidate}; set TAOMNI_FIXTURE_JAVA`);
  return candidate;
}

function javaVersion(javaPath) {
  const out = spawnSync(javaPath, ["-version"], { encoding: "utf8" });
  const line = (out.stderr || "").split("\n")[0] ?? "";
  const version = line.match(/version "([^"]+)"/)?.[1] ?? "unknown";
  return { line: line.trim(), major: Number.parseInt(version.split(".")[0] ?? "0", 10), version };
}

function resolveJdtlsHome() {
  const home = process.env.JDTLS_HOME ?? join(homedir(), ".local/share/jdtls");
  const pluginsDir = join(home, "plugins");
  if (!existsSync(pluginsDir)) throw new Error(`jdtls plugins/ missing under ${home}; set JDTLS_HOME`);
  let launcherJar = join(pluginsDir, "org.eclipse.equinox.launcher.jar");
  if (!existsSync(launcherJar)) {
    const found = readdirSync(pluginsDir).find((name) =>
      name.startsWith("org.eclipse.equinox.launcher_") && name.endsWith(".jar"));
    if (!found) throw new Error("equinox launcher jar not found");
    launcherJar = join(pluginsDir, found);
  }
  const core = readdirSync(pluginsDir).find((name) => name.startsWith("org.eclipse.jdt.ls.core_"));
  return {
    home,
    launcherJar,
    configArea: join(home, "config_linux"),
    version: core?.replace("org.eclipse.jdt.ls.core_", "") ?? "unknown",
  };
}

function resolveGradleDist() {
  const override = process.env.TAOMNI_FIXTURE_GRADLE;
  if (override && existsSync(join(override, "bin/gradle"))) return override;
  const dists = join(homedir(), ".gradle/wrapper/dists");
  if (!existsSync(dists)) return null;
  const candidates = [];
  for (const entry of readdirSync(dists)) {
    const match = entry.match(/^gradle-(\d+\.\d+(?:\.\d+)?)-bin$/);
    if (!match) continue;
    // Wrapper dists unpack to <entry>/<hash>/gradle-<version>/{bin,lib,…}.
    for (const hash of readdirSync(join(dists, entry))) {
      const home = join(dists, entry, hash, `gradle-${match[1]}`);
      if (existsSync(join(home, "bin/gradle"))) {
        candidates.push({ version: match[1], home });
        break;
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0] ?? null;
}

/** Mirrors the Linux branch of the production jdtls launch recipe. */
function launchArgs(jdtls, dataDir) {
  return [
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dosgi.checkConfiguration=true",
    `-Dosgi.sharedConfiguration.area=${jdtls.configArea}`,
    "-Dosgi.sharedConfiguration.area.readOnly=true",
    "-Dosgi.configuration.cascaded=true",
    "-Dlog.level=ERROR",
    "--add-modules=ALL-SYSTEM",
    "--add-opens", "java.base/java.util=ALL-UNNAMED",
    "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    "-jar", jdtls.launcherJar,
    "-data", dataDir,
  ];
}

/** Completion-relevant client capabilities, copied from lsp.rs initialize. */
function clientCapabilities() {
  return {
    window: { workDoneProgress: true },
    textDocument: {
      synchronization: { dynamicRegistration: true, didSave: true },
      completion: {
        dynamicRegistration: true,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          insertReplaceSupport: true,
          documentationFormat: ["markdown", "plaintext"],
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      },
      // §8.20.2 W1: mirrors the production signatureHelp block verbatim —
      // without it jdtls (correctly) answers textDocument/signatureHelp
      // with no signatures.
      signatureHelp: {
        dynamicRegistration: true,
        contextSupport: true,
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      // §8.20.4 W3: mirrors the production codeAction block verbatim —
      // without codeActionLiteralSupport jdtls answers textDocument/codeAction
      // with an empty list (LSP clients that cannot render literals).
      codeAction: {
        dynamicRegistration: true,
        isPreferredSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit", "command"] },
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
              "source.fixAll",
            ],
          },
        },
      },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
    },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeConfiguration: { dynamicRegistration: true },
    },
  };
}

/** Mirrors the production `java.*` initialization settings (lsp.rs
 * JavaLanguageSettings defaults). Notably `signatureHelp.enabled: true` —
 * jdt.ls gates textDocument/signatureHelp behind this flag (default off),
 * so omitting it silently yields empty signatures. */
function initializationSettings(gradleHome) {
  return {
    settings: {
      java: {
        completion: { enabled: true },
        errors: { incompleteClasspath: { severity: "warning" } },
        import: {
          maven: { enabled: true },
          gradle: {
            enabled: true,
            wrapper: { enabled: true },
            offline: { enabled: false },
            ...(gradleHome ? { home: gradleHome } : {}),
          },
        },
        sources: {
          organizeImports: { starThreshold: 99, staticStarThreshold: 99 },
        },
        saveActions: { organizeImports: false },
        codeGeneration: {
          hashCodeEquals: { useJava7Objects: true },
          useBlocks: true,
          generateComments: false,
          toString: { template: "${object.className} [${member.name()}=${member.value}, ${otherMembers}]" },
        },
        referencesCodeLens: { enabled: false },
        implementationsCodeLens: { enabled: false },
        signatureHelp: { enabled: true },
        inlayHints: { parameterNames: { enabled: "all" } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture matrix (§8.19.4 scenario coverage)
// ---------------------------------------------------------------------------

const APP_MAIN = "src/main/java/com/example/single/App.java";
const APP_TEST = "src/test/java/com/example/single/AppTest.java";

// §8.20.2 W1 anchors inside signatureTargets() (see projects/maven-single).
const SIG_OVERLOAD_LINE = 'sb.append("alpha");';
const SIG_THREE_ARG_LINE = 'sb.append("ab", 0, 1);';
const SIG_NESTED_LINE = 'String nested = String.valueOf(Integer.parseInt("42"));';
const SIG_GENERIC_LINE = "java.util.Collections.singletonList(\"x\");";
const SIG_PROJECT_SYMBOL_LINE = "new App().signatureTargets();";
const SIG_LIBRARY_SYMBOL_LINE = 'org.apache.commons.lang3.StringUtils.isBlank("x");';

/**
 * Every case locates one bare token in one file, requests completion at the
 * token end, applies expectations, optionally resolves the matched item, and
 * optionally verifies that reverting the merged acceptance restores the
 * original document hash exactly. Cases with `kind` run the §8.20.2 W1
 * reference-information scenarios instead (signatureHelp / hover /
 * supersede-cancel against real jdtls).
 */
const FIXTURES = {
  "maven-single": {
    buildTool: "maven",
    filesToOpen: [
      { path: APP_MAIN, tokens: ["Stri", "Arrays.", "appen", "StringUti"] },
      { path: APP_TEST, tokens: ["Asser"] },
    ],
    cases: [
      { id: "jdk-type", file: APP_MAIN, token: "Stri", expect: { labelEquals: "String", detailContains: "java.lang" } },
      { id: "static-member", file: APP_MAIN, token: "Arrays.", trigger: ".", expect: { labelEquals: "asList" } },
      { id: "generic-overload", file: APP_MAIN, token: "appen", expect: { labelStartsWith: "appen" }, recordOverloadsOf: "appen" },
      {
        id: "dependency-source-import",
        file: APP_MAIN,
        token: "StringUti",
        expect: { labelEquals: "StringUtils", detailContains: "org.apache.commons.lang3" },
        // jdtls also offers com.sun.tools.javac.util.StringUtils (JDK compiler
        // internals) as a same-name twin; recorded via matchedDetail.
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import org.apache.commons.lang3.StringUtils;" },
        verifyRevert: true,
      },
      {
        id: "test-source-set",
        file: APP_TEST,
        token: "Asser",
        expect: { anyLabelIn: ["Assert", "assertTrue", "assertFalse"] },
        notes: "candidate must come from junit test scope (proves test source set import)",
      },

      // ---- §8.20.2 W1: Parameter Info over a real overloaded family. ----
      {
        kind: "signature",
        id: "sig-overload-family",
        file: APP_MAIN,
        lineText: SIG_OVERLOAD_LINE,
        prefix: "sb.append(",
        expectSignature: { minSignatures: 2, labelContains: "append" },
        notes: "StringBuilder.append overload family; caret right after the open paren → activeParameter 0",
      },
      {
        kind: "signature",
        id: "sig-active-parameter-advance",
        file: APP_MAIN,
        lineText: SIG_THREE_ARG_LINE,
        prefix: "sb.append(\"ab\",",
        expectSignature: { minSignatures: 1, activeParameterEquals: 1 },
        notes: "caret between args of the 3-arg CharSequence,int,int overload → activeParameter advances to 1",
      },
      {
        kind: "signature",
        id: "sig-nested-inner",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        prefix: "Integer.parseInt(",
        expectSignature: { minSignatures: 1, labelContains: "parseInt" },
        notes: "inner call of a nested expression owns the tooltip at its own paren",
      },
      {
        kind: "signature",
        id: "sig-nested-outer",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        prefix: "String.valueOf(",
        expectSignature: { minSignatures: 1, labelContains: "valueOf" },
        notes: "outer call resolves when the caret sits at the outer argument list",
      },
      {
        kind: "signature",
        id: "sig-generic",
        file: APP_MAIN,
        lineText: SIG_GENERIC_LINE,
        prefix: "java.util.Collections.singletonList(",
        expectSignature: { minSignatures: 1, labelContains: "singletonList" },
        notes: "generic method signature; labels recorded for IDEA compare",
      },
      {
        kind: "supersede-cancel",
        id: "sig-supersede-cancel",
        file: APP_MAIN,
        lineText: SIG_OVERLOAD_LINE,
        prefix: "sb.append(",
        notes: "$/cancelRequest on the in-flight request mirrors the production cancel bridge; second request must satisfy",
      },

      // ---- §8.20.2 W1: Quick Documentation at project/JDK/library symbols.
      {
        kind: "hover",
        id: "hover-project-symbol",
        file: APP_MAIN,
        lineText: SIG_PROJECT_SYMBOL_LINE,
        token: "signatureTargets",
        expectHover: { contentsPresent: true },
        notes: "project symbol carries javadoc; provider must surface it through hover",
      },
      {
        kind: "hover",
        id: "hover-jdk-symbol",
        file: APP_MAIN,
        lineText: SIG_NESTED_LINE,
        token: "valueOf",
        expectHover: { contentsPresent: true },
        notes: "JDK class documentation attached to String.valueOf",
      },
      {
        kind: "hover",
        id: "hover-library-symbol",
        file: APP_MAIN,
        lineText: SIG_LIBRARY_SYMBOL_LINE,
        token: "isBlank",
        expectHover: { contentsPresent: true },
        notes: "commons-lang3 dependency symbol — synthesized from .class metadata when sources are absent",
      },
    ],
    restartAfterCases: { file: APP_MAIN, token: "Stri", expect: { labelEquals: "String" } },
    // §8.20.3 W2: a build-file change must bump the provider's analysis
    // generation (fresh import progress), and reverting must restore the model.
    buildChangeScenario: { file: "pom.xml" },
    // §8.20.4 W3 DoD: unresolved-type + import quick fix with post-image hash
    // and exact undo, against the real provider.
    quickFixScenario: {
      id: "import-quick-fix",
      file: "src/main/java/com/example/single/QuickFixTarget.java",
      symbol: "StringUtils",
    },
  },

  "maven-multi-module": {
    buildTool: "maven",
    filesToOpen: [{ path: "app/src/main/java/com/example/app/Main.java", tokens: ["CoreU", "Resu"] }],
    cases: [
      {
        id: "cross-module-type",
        file: "app/src/main/java/com/example/app/Main.java",
        token: "CoreU",
        expect: { labelEquals: "CoreUtil", detailContains: "com.example.core.CoreUtil" },
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import com.example.core.CoreUtil;" },
        verifyRevert: true,
      },
      {
        id: "ambiguous-same-name-types",
        file: "app/src/main/java/com/example/app/Main.java",
        token: "Resu",
        expect: { distinctDetailCountForLabelMin: ["Result", 2] },
        notes: "IDEA shows both twins with their FQNs; user picks one, resolve imports exactly that one",
      },
    ],
  },

  "gradle-single": {
    buildTool: "gradle",
    filesToOpen: [{ path: "src/main/java/org/example/gsingle/GApp.java", tokens: ["Stri"] }],
    cases: [
      { id: "gradle-import-sanity", file: "src/main/java/org/example/gsingle/GApp.java", token: "Stri", expect: { labelEquals: "String", detailContains: "java.lang" } },
    ],
  },

  "gradle-multi-module": {
    buildTool: "gradle",
    filesToOpen: [{ path: "app/src/main/java/org/example/gapp/GMain.java", tokens: ["GCo"] }],
    cases: [
      {
        id: "cross-module-type",
        file: "app/src/main/java/org/example/gapp/GMain.java",
        token: "GCo",
        expect: { labelEquals: "GCore" },
        resolveExpect: { additionalEditCountMin: 1, additionalEditTextIncludes: "import org.example.gcore.GCore;" },
        verifyRevert: true,
      },
    ],
  },

  "maven-broken-classpath": {
    buildTool: "maven",
    filesToOpen: [{ path: "src/main/java/com/example/broken/Broken.java", tokens: ["MissingUti", "Stri"] }],
    collectDiagnostics: true,
    cases: [
      {
        id: "missing-dependency-candidate-absent",
        file: "src/main/java/com/example/broken/Broken.java",
        token: "MissingUti",
        expect: { labelAbsent: "MissingUtil" },
        notes: "broken classpath must not fabricate the dependency type",
      },
      {
        id: "jdk-still-completes-on-broken-classpath",
        file: "src/main/java/com/example/broken/Broken.java",
        token: "Stri",
        expect: { labelEquals: "String", detailContains: "java.lang" },
        notes: "java.lang completion survives the unresolvable dependency",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

/**
 * LSP position (0-based) of the END of the completion target token. Targets
 * are bare-token lines inside `completionTargets()` blocks, so matching a
 * whole trimmed line disambiguates from the same identifier used in compiled
 * code earlier in the file.
 */
function locateTokenEnd(text, needle) {
  const lines = text.split("\n");
  const target = needle.trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== target) continue;
    const indent = line.length - line.trimStart().length;
    return { line: i, character: indent + target.length };
  }
  // Fallback: member-completion targets end a line with the prefix, e.g.
  // `new StringBuilder().appen`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimEnd().endsWith(target)) continue;
    const indent = line.length - line.trimStart().length;
    return { line: i, character: indent + line.trim().length };
  }
  throw new Error(`bare token line ${JSON.stringify(needle)} not found in fixture source`);
}

function itemsFrom(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : (result.items ?? []);
}

/**
 * Normalize TextEdit vs InsertReplaceEdit (the client advertises
 * insertReplaceSupport, so jdtls may answer with {insert, replace, newText}).
 * Acceptance simulation applies the REPLACE range — IDEA semantics for
 * accepting over the typed prefix.
 */
function normalizeEdit(edit) {
  if (!edit) return null;
  const range = edit.range ?? edit.replace ?? edit.insert ?? null;
  if (!range || !range.start || !range.end) return null;
  return { range: { start: range.start, end: range.end }, newText: String(edit.newText ?? "") };
}

/** Absolute UTF-16 offset of an LSP position inside one exact text. */
function absOffset(text, position) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line; i++) {
    if (i >= lines.length) throw new Error(`position line ${position.line} outside document`);
    offset += lines[i].length + 1;
  }
  return offset + position.character;
}

/**
 * Apply the merged acceptance EXACTLY like a CodeMirror change set: every
 * edit is converted to an absolute PRE-image offset first, then applied
 * descending so earlier replacements never shift later offsets.
 * @returns {{applied: string, undo: () => string}}
 */
function simulateAcceptance(original, primaryEdit, additionalEdits) {
  const planned = [primaryEdit, ...additionalEdits]
    .map((edit) => ({
      start: absOffset(original, edit.range.start),
      end: absOffset(original, edit.range.end),
      newText: edit.newText,
      previous: original.slice(
        absOffset(original, edit.range.start),
        absOffset(original, edit.range.end),
      ),
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = original;
  // Inverses carry POST-image spans. Edits are applied descending, so every
  // later (lower-offset) edit shifts all previously recorded inverse spans
  // by its length delta — tracked here so undo() is exact.
  const inverses = [];
  for (const edit of planned) {
    if (edit.end > out.length || edit.start > edit.end) {
      throw new Error(`edit range [${edit.start},${edit.end}) invalid for length ${out.length}`);
    }
    const delta = edit.newText.length - (edit.end - edit.start);
    if (delta !== 0) {
      for (const inverse of inverses) {
        if (inverse.start >= edit.end) {
          inverse.start += delta;
          inverse.end += delta;
        }
      }
    }
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    inverses.push({ start: edit.start, end: edit.start + edit.newText.length, previous: edit.previous });
  }
  return {
    applied: out,
    undo() {
      let restored = out;
      // Recorded descending; restoring in the same order never disturbs
      // already-restored higher spans.
      for (const inverse of inverses) {
        restored = restored.slice(0, inverse.start) + inverse.previous + restored.slice(inverse.end);
      }
      return restored;
    },
  };
}

function editOrderKey(edit) {
  return edit.range.start.line * 1_000_000 + edit.range.start.character;
}

function buildModelFingerprint(fixtureId) {
  const root = join(PROJECTS_DIR, fixtureId);
  const parts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(pom\.xml|build\.gradle|settings\.gradle)$/.test(entry.name)) {
        parts.push(`${full}:${sha256(readFileSync(full, "utf8"))}`);
      }
    }
  };
  walk(root);
  parts.sort();
  return sha256(parts.join("\n"));
}

async function startSession(jdtls, fixtureId, options = {}) {
  const projectDir = join(PROJECTS_DIR, fixtureId);
  const dataDir = join(tmpdir(), `taomni-r3-${fixtureId}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });
  const diagnosticsLog = [];
  const registeredMethods = [];
  const registeredExecuteCommands = [];
  const progressEvents = [];
  const rawDiagnosticsByUri = new Map();
  const client = new LspClient(options.javaPath, launchArgs(jdtls, dataDir), {
    onDiagnostics: (params) => {
      for (const diagnostic of params?.diagnostics ?? []) {
        diagnosticsLog.push({
          severity: diagnostic.severity ?? null,
          source: diagnostic.source ?? null,
          message: String(diagnostic.message ?? ""),
          uriSanitized: String(params.uri ?? "").startsWith("file://")
            ? String(params.uri).slice("file://".length)
            : String(params.uri ?? ""),
        });
      }
    },
    // §8.20.2 W1: jdtls registers several capabilities dynamically instead of
    // declaring them statically in initialize — record the registrations so
    // providerChannels can distinguish "absent" from "registered later".
    onRegisterCapability: (params) => {
      for (const registration of params?.registrations ?? []) {
        if (!registration?.method) continue;
        registeredMethods.push(registration.method);
        if (registration.method === "workspace/executeCommand") {
          for (const command of registration.registerOptions?.commands ?? []) {
            if (typeof command === "string") registeredExecuteCommands.push(command);
          }
        }
      }
    },
    // §8.20.3 W2: work-done progress is the provider's import/analysis lifecycle.
    onRawDiagnostics: (params) => {
      if (!params?.uri) return;
      rawDiagnosticsByUri.set(String(params.uri), Array.isArray(params.diagnostics) ? params.diagnostics : []);
    },
    onWorkDoneProgress: (params) => {
      if (!params?.token) return;
      progressEvents.push({
        token: String(params.token),
        kind: params.value?.kind ?? null,
        title: params.value?.title ?? null,
        message: params.value?.message ?? null,
        percentage: typeof params.value?.percentage === "number" ? params.value.percentage : null,
      });
    },
  }).start();
  const startedAt = Date.now();
  const initializeResult = await client.request("initialize", {
    processId: null,
    rootUri: `file://${projectDir}`,
    workspaceFolders: [{ uri: `file://${projectDir}`, name: fixtureId }],
    initializationOptions: initializationSettings(options.gradleHome ?? null),
    capabilities: clientCapabilities(),
  }, 180_000);
  client.notify("initialized", {});
  return {
    client,
    diagnosticsLog,
    registeredMethods,
    registeredExecuteCommands,
    progressEvents,
    rawDiagnosticsByUri,
    serverInfo: initializeResult?.serverInfo ?? null,
    serverCapabilities: initializeResult?.capabilities ?? {},
    startedAt,
    msToInitialize: Date.now() - startedAt,
    projectDir,
    dataDir,
  };
}

// ---------------------------------------------------------------------------
// §8.20.3 W2: Project Analysis snapshot collection (provider-owned facts)
// ---------------------------------------------------------------------------

const BUILD_DESCRIPTOR_FILES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

function collectBuildFileHashes(projectDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["target", "build", ".git", "node_modules"].includes(entry.name)) {
          walk(full, depth + 1);
        }
        continue;
      }
      if (!BUILD_DESCRIPTOR_FILES.has(entry.name)) continue;
      found.push({ path: full, sha256: sha256(readFileSync(full, "utf8")) });
    }
  };
  walk(projectDir, 0);
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}

async function executeCommandProbe(client, command, args) {
  return client.request("workspace/executeCommand", { command, arguments: args });
}

/**
 * Provider-owned analysis snapshot for one settled session: server identity,
 * registered executeCommands (gating truth), java project list + classpath
 * probe when available, build-file hashes and the import progress trail.
 */
async function collectAnalysisSnapshot(session, mainUri) {
  const registered = [...new Set(session.registeredExecuteCommands)].sort();
  const snapshot = {
    serverInfo: session.serverInfo
      ? {
        name: session.serverInfo.name ?? null,
        version: session.serverInfo.version ?? null,
      }
      : null,
    registeredCommands: registered,
    javaProjects: [],
    classpathProbe: null,
    probeReason: null,
    buildFiles: collectBuildFileHashes(session.projectDir).map((file) => ({
      ...file,
      path: file.path.replaceAll(session.projectDir, "${project}"),
    })),
    importProgress: {
      events: session.progressEvents.length,
      beginTokens: new Set(
        session.progressEvents.filter((event) => event.kind === "begin").map((event) => event.token),
      ).size,
      titles: [...new Set(session.progressEvents.map((event) => event.title).filter(Boolean))].slice(0, 8),
      anyWithPercentage: session.progressEvents.some((event) => event.percentage !== null),
    },
  };

  if (registered.includes("java.project.list")) {
    try {
      const value = await executeCommandProbe(session.client, "java.project.list", []);
      snapshot.javaProjects = (Array.isArray(value) ? value : value?.projects ?? [])
        .map((item) => ({
          id: typeof item === "string" ? item : item?.uri ?? item?.rootUri ?? "",
          rootUri: typeof item === "string" ? item : item?.uri ?? item?.rootUri ?? null,
        }))
        .filter((item) => item.id);
    } catch (error) {
      snapshot.probeReason = `java.project.list-failed:${error.message.split("\n")[0]}`;
    }
  } else {
    snapshot.probeReason = "command-not-registered:java.project.list";
  }

  if (registered.includes("java.project.getClasspaths")) {
    try {
      const value = await executeCommandProbe(session.client, "java.project.getClasspaths", [mainUri]);
      const entries = Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string")
        : Array.isArray(value?.classpaths)
          ? value.classpaths.filter((entry) => typeof entry === "string")
          : null;
      if (entries) {
        const sorted = [...entries].sort();
        snapshot.classpathProbe = {
          root: typeof value?.root === "string"
            ? value.root.replace(/^file:\/\//, "").replaceAll(session.projectDir, "${project}")
            : null,
          entryCount: sorted.length,
          entriesSha256: sha256(sorted.join("\n")),
          sampleKinds: sorted.slice(0, 4).map((entry) => (entry.includes(".jar") ? "jar" : "dir")),
        };
      } else {
        snapshot.probeReason = "java.project.getClasspaths-unrecognized-shape";
      }
    } catch (error) {
      snapshot.probeReason = `java.project.getClasspaths-failed:${error.message.split("\n")[0]}`;
    }
  } else if (!snapshot.probeReason) {
    snapshot.probeReason = "command-not-registered:java.project.getClasspaths";
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// §8.20.4 W3: unresolved-type + import quick fix over real jdtls
// ---------------------------------------------------------------------------

async function runQuickFixScenario(session, spec) {
  const record = {
    caseId: spec.id,
    file: spec.file,
    diagnosticMessage: null,
    actionTitle: null,
    actionKind: null,
    isPreferred: null,
    offeredTitles: [],
    resolved: false,
    resolveFailure: null,
    importInsertText: null,
    appliedSha256: null,
    originalSha256: null,
    revertedRestoresOriginalHash: false,
    msTotal: 0,
    satisfied: false,
    reason: null,
  };
  const startedAt = Date.now();
  const abs = join(session.projectDir, spec.file);
  const uri = `file://${abs}`;
  const text = openFile(session.client, session.projectDir, spec.file);
  // Precise caret range for the simple name (pushed publishDiagnostics carry
  // no range in this runner's reduced log; the fixture line is fixed).
  const symbolPos = locateTokenInLine(
    text,
    'boolean blank = StringUtils.isBlank("x");',
    spec.symbol,
  );
  const symbolRange = {
    start: symbolPos,
    end: { line: symbolPos.line, character: symbolPos.character + spec.symbol.length },
  };

  // Poll for the unresolved-symbol diagnostic exactly the way production
  // receives it: server-PUSHED publishDiagnostics (the runner logs those),
  // falling back to a workspace pull request when push stays silent.
  let diagnostic = null;
  const deadline = Date.now() + 240_000;
  while (!diagnostic && Date.now() < deadline) {
    // Preferred: the RAW pushed payload — echoing the server's own object
    // (exact code + range) back as context is what jdtls matches against.
    const rawKey = [...session.rawDiagnosticsByUri.keys()]
      .find((key) => key.endsWith(spec.file));
    const rawItems = rawKey ? session.rawDiagnosticsByUri.get(rawKey) ?? [] : [];
    diagnostic = rawItems.find((item) => (
      typeof item.message === "string"
      && item.message.includes(spec.symbol)
      && /cannot be resolved/i.test(item.message)
    )) ?? null;
    if (!diagnostic) {
      // Fallback: reduced log + synthesized precise symbol range.
      const pushed = session.diagnosticsLog
        .filter((entry) => entry.uriSanitized.endsWith(spec.file))
        .find((entry) => (
          entry.message.includes(spec.symbol)
          && /cannot be resolved/i.test(entry.message)
        ));
      if (pushed) {
        diagnostic = {
          range: symbolRange,
          message: pushed.message,
          severity: pushed.severity,
          source: pushed.source,
        };
      }
    }
    if (!diagnostic) await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
  if (!diagnostic) {
    record.reason = `unresolved ${spec.symbol} diagnostic never appeared`;
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.diagnosticMessage = String(diagnostic.message).split("\n")[0];

  // jdtls may answer an EMPTY literal list while a (re-)import settles or
  // while it reconciles the very diagnostic just published — poll until the
  // provider offers something or the budget runs out.
  const codeActionParams = {
    textDocument: { uri },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic], triggerKind: 2 },
  };
  let list = [];
  let codeActionTimeouts = 0;
  const actionDeadline = Date.now() + 180_000;
  while (list.length === 0 && Date.now() < actionDeadline) {
    const actions = await session.client.request(
      "textDocument/codeAction",
      codeActionParams,
      240_000,
    ).catch(() => null);
    if (actions === null) codeActionTimeouts += 1;
    list = Array.isArray(actions) ? actions : [];
    if (list.length === 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
  }
  record.offeredTitles = list.map((action) => action.title).slice(0, 8);
  const picked = list.find((action) => (
    /^import /i.test(action.title ?? "") && (action.title ?? "").includes(spec.symbol)
  )) ?? null;
  if (!picked) {
    // jdt.ls 1.61 observation: textDocument/codeAction never responds (hang,
    // not empty) for BOTH healthy and broken documents, regardless of
    // extendedClientCapabilities. Record that as first-class provider truth;
    // the runner treats it as a documented difference, not an infra failure.
    if (list.length === 0 && codeActionTimeouts > 0) {
      record.providerHang = { attempts: codeActionTimeouts };
      record.reason = `provider-hang: textDocument/codeAction gave no response across ${codeActionTimeouts} attempt(s) (healthy + broken files alike)`;
    } else {
      record.reason = `no import quick fix offered; saw ${record.offeredTitles.join(" | ") || "nothing"}`;
    }
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.actionTitle = picked.title;
  record.actionKind = picked.kind ?? null;
  record.isPreferred = picked.isPreferred === true;

  let merged = picked;
  if (picked.data !== undefined) {
    try {
      const resolvedAction = await session.client.request("textDocument/codeAction/resolve", picked);
      record.resolved = true;
      merged = { ...picked, ...(resolvedAction ?? {}) };
    } catch (error) {
      record.resolveFailure = error.message.split("\n")[0];
      // Keep the raw action; some servers answer edits inline despite data.
    }
  }

  const targetEdits = merged.edit?.changes?.[uri]
    ?? merged.edit?.changes?.[encodeURI(uri)]
    ?? (merged.edit?.documentChanges ?? [])
      .filter((change) => change.textDocument?.uri === uri || change.textDocument?.uri === encodeURI(uri))
      .flatMap((change) => change.edits ?? []);
  const normalized = targetEdits.map(normalizeEdit).filter(Boolean);
  const importEdit = normalized.find((edit) => /^import /.test(edit.newText.trim()));
  if (!normalized.length || !importEdit) {
    record.reason = "quick fix produced no import edit for this document";
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.importInsertText = importEdit.newText.trim();
  record.originalSha256 = sha256(text);
  const simulation = simulateAcceptance(text, normalized[0], normalized.slice(1));
  record.appliedSha256 = sha256(simulation.applied);
  const restored = simulation.undo();
  record.revertedRestoresOriginalHash = sha256(restored) === record.originalSha256;
  record.satisfied = record.revertedRestoresOriginalHash
    && record.appliedSha256 !== record.originalSha256;
  if (!record.satisfied) {
    record.reason = record.revertedRestoresOriginalHash
      ? "post-image equals original (no visible change applied)"
      : "undo did not restore the original hash";
  }

  // Cancel probe mirrors the production bridge: fire, cancel on the wire,
  // record whatever the provider does (null / -32800 / still-full are all
  // honest outcomes worth pinning per provider version).
  const probeParams = {
    textDocument: { uri },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic], triggerKind: 2 },
  };
  const tracked = session.client.requestTracked("textDocument/codeAction", probeParams);
  session.client.cancelRequest(tracked.id);
  try {
    const value = await tracked.promise;
    record.quickFixCancel = {
      outcome: "resolved",
      empty: !Array.isArray(value) || value.length === 0,
    };
  } catch (error) {
    record.quickFixCancel = { outcome: `rejected:${error.code ?? "?"}` };
  }
  record.msTotal = Date.now() - startedAt;
  return record;
}

function openFile(client, projectDir, relPath) {
  const abs = join(projectDir, relPath);
  const text = readFileSync(abs, "utf8");
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: `file://${abs}`,
      languageId: "java",
      version: 1,
      text,
    },
  });
  return text;
}

async function requestCompletion(client, uri, position, trigger) {
  const startedAt = Date.now();
  const result = await client.request("textDocument/completion", {
    textDocument: { uri },
    position,
    context: trigger
      ? { triggerKind: 2, triggerCharacter: trigger }
      : { triggerKind: 1 },
  });
  return { result, ms: Date.now() - startedAt };
}

/**
 * Poll completion until the expectation predicate passes (project import can
 * take minutes on first contact) or the budget runs out.
 */
async function waitForCase(client, uri, position, trigger, expectFn, budgetMs) {
  const attempts = [];
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    const { result, ms } = await requestCompletion(client, uri, position, trigger);
    last = { result, ms };
    attempts.push({ ms, itemCount: itemsFrom(result).length });
    const evaluation = expectFn(itemsFrom(result));
    if (evaluation.ok) {
      return { attempts, final: result, msToSatisfy: Date.now() - (deadline - budgetMs), satisfied: true, evaluation };
    }
    if (Date.now() > deadline) {
      return { attempts, final: result, satisfied: false, evaluation };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
}

/** jdtls decorates labels ("String - java.lang", "asList(int…)"); strip it. */
function baseLabel(item) {
  return String(item.label ?? "").split(" - ")[0].split("(")[0].trim();
}

// ---------------------------------------------------------------------------
// W1 reference-information scenarios (§8.20.2)
// ---------------------------------------------------------------------------

/** Locate a line by its trimmed content; returns the 0-based line + indent. */
function locateLineByContent(text, needle) {
  const lines = text.split("\n");
  const target = needle.trim();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== target) continue;
    return { line: i, indent: lines[i].length - lines[i].trimStart().length };
  }
  throw new Error(`line ${JSON.stringify(needle)} not found in fixture source`);
}

/** Caret right after `prefix` inside the located line (unique substring). */
function locateAfterPrefix(text, lineContent, prefix) {
  const { line } = locateLineByContent(text, lineContent);
  const raw = text.split("\n")[line];
  const index = raw.indexOf(prefix);
  if (index < 0) throw new Error(`prefix ${JSON.stringify(prefix)} not found on line ${JSON.stringify(lineContent)}`);
  return { line, character: index + prefix.length };
}

/** Caret at the middle of `token` inside the located line (hover target). */
function locateTokenInLine(text, lineContent, token) {
  const { line } = locateLineByContent(text, lineContent);
  const raw = text.split("\n")[line];
  const index = raw.indexOf(token);
  if (index < 0) throw new Error(`token ${JSON.stringify(token)} not found on line ${JSON.stringify(lineContent)}`);
  return { line, character: index + Math.floor(token.length / 2) };
}

async function requestSignatureHelp(client, uri, position) {
  const startedAt = Date.now();
  const result = await client.request("textDocument/signatureHelp", {
    textDocument: { uri },
    position,
    context: { triggerKind: 1, isRetrigger: false },
  });
  return { result, ms: Date.now() - startedAt };
}

/**
 * Poll signatureHelp until the expectation predicate passes (the importer
 * may still be warming up after a fresh session).
 */
async function waitForSignature(client, uri, position, expectFn, budgetMs) {
  const attempts = [];
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { result, ms } = await requestSignatureHelp(client, uri, position);
    attempts.push({ ms, signaturesCount: result?.signatures?.length ?? 0 });
    const evaluation = expectFn(result ?? {});
    if (evaluation.ok) {
      return { attempts, final: result ?? {}, satisfied: true, evaluation };
    }
    if (Date.now() > deadline) {
      return { attempts, final: result ?? {}, satisfied: false, evaluation };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
}

function evaluateSignatureExpect(expect, result) {
  const signatures = result?.signatures ?? [];
  if (expect.minSignatures !== undefined && signatures.length < expect.minSignatures) {
    return { ok: false, reason: `expected ≥${expect.minSignatures} signatures, got ${signatures.length}` };
  }
  if (
    expect.labelContains !== undefined
    && !signatures.some((signature) => String(signature.label ?? "").includes(expect.labelContains))
  ) {
    return {
      ok: false,
      reason: `no signature label containing ${expect.labelContains}; saw ${signatures.map((s) => s.label).slice(0, 6).join(" | ")}`,
    };
  }
  if (expect.activeParameterEquals !== undefined && result.activeParameter !== expect.activeParameterEquals) {
    return {
      ok: false,
      reason: `expected activeParameter=${expect.activeParameterEquals}, got ${result.activeParameter} (${signatures.map((s) => s.label).slice(0, 4).join(" | ")})`,
    };
  }
  return { ok: true };
}

/** Normalize hover contents into plain text + a coarse kind tag. */
function hoverText(contents) {
  if (!contents) return { text: "", kind: null };
  if (typeof contents === "string") return { text: contents, kind: "plaintext" };
  if (Array.isArray(contents)) return { text: contents.map((c) => hoverText(c).text).join("\n"), kind: "markup-array" };
  if (contents.kind && typeof contents.value === "string") return { text: contents.value, kind: contents.kind };
  if (typeof contents.value === "string") return { text: contents.value, kind: "marked-string" };
  return { text: "", kind: "unknown" };
}

function httpsLinksIn(text) {
  return [...new Set(String(text).match(/https:\/\/[^\s<>"')\]]+/g) ?? [])];
}

function evaluateExpect(expect, items) {
  if (!expect) return { ok: true };
  const labels = items.map((item) => item.label ?? "");
  if (expect.labelEquals !== undefined) {
    const labelHits = items.filter((item) => baseLabel(item) === expect.labelEquals);
    if (labelHits.length === 0) {
      return { ok: false, reason: `no item labelled ${expect.labelEquals}; saw ${labels.slice(0, 12).join(", ")}` };
    }
    // Same-name twins are disambiguated by detail (FQ name): only a candidate
    // whose detail carries the expected package proves the right source.
    const hit = expect.detailContains
      ? labelHits.find((item) => String(item.detail ?? "").includes(expect.detailContains))
      : labelHits[0];
    if (!hit) {
      return {
        ok: false,
        reason: `${expect.labelEquals} candidates lack expected detail ${expect.detailContains}: ${labelHits.map((item) => item.detail ?? "?").join(" | ")}`,
      };
    }
    return { ok: true, matchedItem: hit, matchedDetail: hit.detail ?? null };
  }
  if (expect.labelStartsWith !== undefined) {
    const hit = items.find((item) => baseLabel(item).startsWith(expect.labelStartsWith));
    if (!hit) return { ok: false, reason: `no item starting with ${expect.labelStartsWith}` };
    return { ok: true, matchedItem: hit };
  }
  if (expect.anyLabelIn !== undefined) {
    const hit = items.find((item) => expect.anyLabelIn.includes(baseLabel(item)));
    if (!hit) return { ok: false, reason: `none of ${expect.anyLabelIn.join("/")} present; saw ${labels.slice(0, 12).join(", ")}` };
    return { ok: true, matchedItem: hit };
  }
  if (expect.labelAbsent !== undefined) {
    const bad = items.filter((item) => baseLabel(item).includes(expect.labelAbsent));
    if (bad.length > 0) return { ok: false, reason: `${expect.labelAbsent} unexpectedly completed (${bad[0].detail ?? ""})` };
    return { ok: true };
  }
  if (expect.distinctDetailCountForLabelMin !== undefined) {
    const [label, min] = expect.distinctDetailCountForLabelMin;
    // Same-name ambiguity shows up as identical labels with distinct details;
    // fall back to the raw label when decoration is absent.
    const twins = items.filter((item) => baseLabel(item) === label);
    const identities = new Set(twins.map((item) => String(item.detail ?? "") || String(item.label)));
    if (identities.size < min) {
      return { ok: false, reason: `expected ≥${min} distinct candidates for ${label}, got ${identities.size}: ${[...identities].join(" | ")}` };
    }
    return { ok: true, distinctDetails: [...identities], matchedItem: twins[0] };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function makeSanitizer(projectDir) {
  const homes = [homedir(), tmpdir()];
  return (value) => {
    if (typeof value === "string") {
      let out = value.replaceAll(projectDir, "${project}");
      out = out.replaceAll(FIXTURE_ROOT, "${fixtures}");
      for (const home of homes) out = out.replaceAll(home, "~");
      return out;
    }
    if (Array.isArray(value)) return value.map(makeSanitizer(projectDir));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, makeSanitizer(projectDir)(inner)]));
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// Per-fixture driver
// ---------------------------------------------------------------------------

async function runFixture(fixtureId, toolchain, jdtls, gradleHome) {
  const spec = FIXTURES[fixtureId];
  const trace = {
    schemaVersion: 1,
    fixtureId,
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain,
    buildModelFingerprint: buildModelFingerprint(fixtureId),
    scenarios: [],
    failures: [],
  };

  const session = await startSession(jdtls, fixtureId, { gradleHome, javaPath: toolchain.java.path });
  const openedUris = new Map();

  try {
    // §8.20.2 W1: record which reference channels the provider actually
    // declares. Type Info / Expression Static Data have no standard LSP
    // method; an honest absence probe here is the evidence for their L0/L1
    // unavailable contract (unsupported trace is valid evidence).
    const caps = session.serverCapabilities ?? {};
    const capabilityJson = JSON.stringify(caps).toLowerCase();
    trace.providerChannels = {
      signatureHelpProvider: !!caps?.textDocument?.signatureHelpProvider,
      hoverProvider: !!caps?.textDocument?.hoverProvider,
      declaredTypeInfoChannel: /typeinfo/.test(capabilityJson),
      declaredStaticDataChannel: /staticdata|expressionstaticdata/.test(capabilityJson),
      topLevelCapabilityKeys: Object.keys(caps).sort(),
    };

    for (const fileSpec of spec.filesToOpen) {
      const text = openFile(session.client, session.projectDir, fileSpec.path);
      openedUris.set(fileSpec.path, { uri: `file://${join(session.projectDir, fileSpec.path)}`, text });
    }

    // Give the importer a moment to publish progress; cases poll anyway.
    for (const testCase of spec.cases) {
      const entry = openedUris.get(testCase.file);

      // ---- §8.20.2 W1 reference-information scenarios. ------------------
      if (testCase.kind === "signature" || testCase.kind === "supersede-cancel") {
        const position = locateAfterPrefix(entry.text, testCase.lineText, testCase.prefix);
        const scenario = {
          caseId: testCase.id,
          file: testCase.file,
          kind: testCase.kind,
          position,
          scopeRequested: "default",
          signatureHelp: null,
          supersede: null,
          notes: testCase.notes ?? null,
        };
        if (testCase.kind === "signature") {
          const wait = await waitForSignature(
            session.client,
            entry.uri,
            position,
            (result) => evaluateSignatureExpect(testCase.expectSignature, result),
            240_000,
          );
          scenario.signatureHelp = {
            attempts: wait.attempts.length,
            msTotal: Math.round(wait.attempts.reduce((sum, attempt) => sum + attempt.ms, 0)),
            signaturesCount: wait.final?.signatures?.length ?? 0,
            labels: (wait.final?.signatures ?? []).map((signature) => String(signature.label ?? "")),
            activeSignature: wait.final?.activeSignature ?? null,
            activeParameter: wait.final?.activeParameter ?? null,
            satisfied: wait.satisfied,
            evaluationReason: wait.evaluation.ok ? null : wait.evaluation.reason,
          };
          if (!wait.satisfied) trace.failures.push(`${testCase.id}: ${wait.evaluation.reason}`);
        } else {
          // supersede-cancel: fire, cancel on the wire, then re-request.
          const params = {
            textDocument: { uri: entry.uri },
            position,
            context: { triggerKind: 1, isRetrigger: false },
          };
          const firstStartedAt = Date.now();
          const first = session.client.requestTracked("textDocument/signatureHelp", params);
          session.client.cancelRequest(first.id);
          let firstCancelled = false;
          let firstOutcome = null;
          try {
            const raw = await first.promise;
            firstOutcome = "resolved-empty";
            firstCancelled = !raw || !Array.isArray(raw.signatures) || raw.signatures.length === 0;
          } catch (error) {
            firstOutcome = `rejected:${error.code ?? "?"}`;
            firstCancelled = true;
          }
          const second = await waitForSignature(
            session.client,
            entry.uri,
            position,
            (result) => evaluateSignatureExpect({ minSignatures: 1 }, result),
            240_000,
          );
          scenario.supersede = {
            firstOutcome,
            firstCancelled,
            msFirst: Date.now() - firstStartedAt,
            secondSatisfied: second.satisfied,
            msSecond: Math.round(second.attempts.reduce((sum, attempt) => sum + attempt.ms, 0)),
          };
          if (!firstCancelled) trace.failures.push(`${testCase.id}: cancelled request returned usable signatures`);
          if (!second.satisfied) trace.failures.push(`${testCase.id}: post-cancel request did not satisfy`);
        }
        trace.scenarios.push(scenario);
        continue;
      }

      if (testCase.kind === "hover") {
        const position = locateTokenInLine(entry.text, testCase.lineText, testCase.token);
        let hover = null;
        for (let attempt = 0; attempt < 40 && !(hover?.contentsPresent); attempt++) {
          const startedAt = Date.now();
          const result = await session.client.request("textDocument/hover", {
            textDocument: { uri: entry.uri },
            position,
          });
          const { text, kind } = hoverText(result?.contents);
          if (!hover) {
            hover = {
              msFirst: Date.now() - startedAt,
              attempts: 0,
              contentsPresent: false,
              contentsKind: null,
              externalLinks: [],
              excerpt: null,
              satisfied: false,
              evaluationReason: null,
            };
          }
          hover.attempts += 1;
          if (text.trim()) {
            hover.contentsKind = kind;
            hover.externalLinks = httpsLinksIn(text).slice(0, 5);
            // Bounded sanitized excerpt — evidence without embedding docs.
            hover.excerpt = text.replace(/\s+/g, " ").slice(0, 160);
            const present = text.trim().length > 0;
            hover.contentsPresent = present;
            hover.satisfied = present || !testCase.expectHover?.contentsPresent;
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
        }
        if (hover && !hover.contentsPresent) {
          hover.evaluationReason = "provider returned empty contents";
        }
        const scenario = {
          caseId: testCase.id,
          file: testCase.file,
          kind: "hover",
          position,
          scopeRequested: "default",
          hover,
          notes: testCase.notes ?? null,
        };
        if (testCase.expectHover?.contentsPresent && !hover?.contentsPresent) {
          trace.failures.push(`${testCase.id}: ${hover?.evaluationReason ?? "no contents recorded"}`);
        }
        trace.scenarios.push(scenario);
        continue;
      }

      // ---- Existing completion flow. ------------------------------------
      const scenario = {
        caseId: testCase.id,
        file: testCase.file,
        position: locateTokenEnd(entry.text, testCase.token),
        trigger: testCase.trigger ?? null,
        scopeRequested: "default",
        requests: [],
        resolve: null,
        acceptance: null,
        notes: testCase.notes ?? null,
      };

      const wait = await waitForCase(
        session.client,
        entry.uri,
        scenario.position,
        testCase.trigger,
        (items) => evaluateExpect(testCase.expect, items),
        240_000,
      );
      scenario.requests.push({
        attempts: wait.attempts.length,
        msTotal: Math.round(wait.msToSatisfy ?? 0),
        itemCount: itemsFrom(wait.final).length,
        isIncomplete: !Array.isArray(wait.final) && wait.final?.isIncomplete === true,
        satisfied: wait.satisfied,
        matchedDetail: wait.evaluation.matchedDetail ?? null,
        evaluationReason: wait.evaluation.ok ? null : wait.evaluation.reason,
      });
      let matched = wait.evaluation.matchedItem;

      try {
        if (wait.satisfied && matched && (testCase.resolveExpect || testCase.verifyRevert)) {
          const resolveStarted = Date.now();
          const resolved = await session.client.request("completionItem/resolve", matched, 30_000);
          // The resolved item replaces the raw echo; keep it for later cases.
          matched = { ...matched, ...(resolved ?? {}) };
          const additional = ((resolved?.additionalTextEdits ?? [])
            .map(normalizeEdit)
            .filter(Boolean));
          scenario.resolve = {
            ms: Date.now() - resolveStarted,
            additionalEditCount: additional.length,
            additionalEditTexts: additional.map((edit) => edit.newText),
          };
          if (testCase.resolveExpect) {
            if (additional.length < testCase.resolveExpect.additionalEditCountMin) {
              trace.failures.push(`${testCase.id}: expected ≥${testCase.resolveExpect.additionalEditCountMin} additional edits, got ${additional.length}`);
            }
            if (
              testCase.resolveExpect.additionalEditTextIncludes
              && !additional.some((edit) => edit.newText.includes(testCase.resolveExpect.additionalEditTextIncludes))
            ) {
              trace.failures.push(`${testCase.id}: additional edits lack ${testCase.resolveExpect.additionalEditTextIncludes}`);
            }
          }
          if (testCase.verifyRevert) {
            const primary = normalizeEdit(matched.textEdit) ?? {
              range: { start: { ...scenario.position }, end: { ...scenario.position } },
              newText: String(resolved?.insertText ?? baseLabel(matched)),
            };
            const simulation = simulateAcceptance(entry.text, primary, additional);
            const restored = simulation.undo();
            scenario.acceptance = {
              originalSha256: sha256(entry.text),
              appliedSha256: sha256(simulation.applied),
              revertedSha256: sha256(restored),
              revertRestoresOriginalHash: sha256(restored) === sha256(entry.text),
            };
            if (!scenario.acceptance.revertRestoresOriginalHash) {
              trace.failures.push(`${testCase.id}: reverting the merged acceptance did not restore the original document hash`);
            }
          }
        }
      } catch (caseError) {
        trace.failures.push(`${testCase.id}: acceptance simulation error — ${caseError.message}`);
      }

      if (testCase.recordOverloadsOf) {
        scenario.overloads = itemsFrom(wait.final)
          .filter((item) => item.label?.startsWith(testCase.recordOverloadsOf))
          .map((item) => ({ label: item.label, detail: item.detail ?? null }));
      }

      if (!wait.satisfied) {
        trace.failures.push(`${testCase.id}: ${wait.evaluation.reason}`);
      }
      trace.scenarios.push(scenario);
    }


    // ---- §8.20.4 W3: unresolved-type import quick fix (DoD trace). --------
    if (spec.quickFixScenario) {
      trace.quickFix = await runQuickFixScenario(session, spec.quickFixScenario);
      if (!trace.quickFix.satisfied && !trace.quickFix.reason?.startsWith("provider-hang")) {
        trace.failures.push(`quick-fix: ${trace.quickFix.reason}`);
      }
    }

    // ---- §8.20.3 W2: Project Analysis snapshot on the settled session. ----
    const mainEntry = openedUris.get(spec.filesToOpen[0].path);
    const analysis = await collectAnalysisSnapshot(session, mainEntry.uri);
    analysis.diagnosticFlags = {
      incompleteOrMissingMentioned: session.diagnosticsLog.some((entry) => (
        /incomplete|missing|could not be resolved|unresolved/i.test(entry.message)
      )),
    };
    trace.analysis = analysis;
    trace.analysisTiming = {
      firstCompletionSatisfiedMs: (() => {
        for (const scenario of trace.scenarios) {
          const last = scenario.requests?.at(-1);
          if (last?.satisfied && scenario.position) {
            return Date.now() - session.startedAt;
          }
        }
        return null;
      })(),
    };

    // Build-file change → fresh import progress (generation bump evidence),
    // then a byte-exact revert whose classpath fingerprint returns to baseline.
    if (spec.buildChangeScenario) {
      const relFile = spec.buildChangeScenario.file;
      const absPath = join(session.projectDir, relFile);
      const original = readFileSync(absPath, "utf8");
      const eventsBefore = session.progressEvents.length;
      writeFileSync(absPath, `${original}\n<!-- w2-generation-bump-probe -->\n`);
      session.client.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: `file://${absPath}`, type: 2 }],
      });
      let reimportObserved = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const fresh = session.progressEvents.slice(eventsBefore);
        if (fresh.some((event) => event.kind === "begin")) {
          reimportObserved = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      }
      writeFileSync(absPath, original);
      session.client.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: `file://${absPath}`, type: 2 }],
      });
      // Give the importer time to chew on the revert before the probe.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      let classpathShaAfterRevert = null;
      try {
        const value = await executeCommandProbe(
          session.client,
          "java.project.getClasspaths",
          [mainEntry.uri],
        );
        const entries = Array.isArray(value)
          ? value.filter((entry) => typeof entry === "string")
          : Array.isArray(value?.classpaths) ? value.classpaths : [];
        classpathShaAfterRevert = sha256([...entries].sort().join("\n"));
      } catch {
        classpathShaAfterRevert = null;
      }
      analysis.buildChange = {
        mutatedFile: relFile,
        reimportProgressObserved: reimportObserved,
        revertedByteExact: readFileSync(absPath, "utf8") === original,
        // Meaningful only when a classpath probe exists to compare against;
        // lifecycle-only providers leave this null instead of implying drift.
        classpathStableAfterRevert: analysis.classpathProbe?.entriesSha256
          ? classpathShaAfterRevert !== null
            && classpathShaAfterRevert === analysis.classpathProbe.entriesSha256
          : null,
      };
      if (!reimportObserved) {
        trace.failures.push(`build-change: no provider progress after ${relFile} change`);
      }
      if (!analysis.buildChange.revertedByteExact) {
        trace.failures.push(`build-change: ${relFile} not restored byte-exactly`);
      }
    }


    if (spec.restartAfterCases) {
      const restartStarted = Date.now();
      await session.client.kill();
      const second = await startSession(jdtls, fixtureId, { gradleHome, javaPath: toolchain.java.path });
      try {
        const reopenSpec = spec.restartAfterCases;
        const text = openFile(second.client, second.projectDir, reopenSpec.file);
        const wait = await waitForCase(
          second.client,
          `file://${join(second.projectDir, reopenSpec.file)}`,
          locateTokenEnd(text, reopenSpec.token),
          null,
          (items) => evaluateExpect(reopenSpec.expect, items),
          240_000,
        );
        // §8.20.2 W1: Parameter Info must also recover after the provider is
        // SIGKILLed and the session rebuilt — same evidence bar as completion.
        let signatureOkAfterRestart = false;
        let signatureReason = "not run";
        if (fixtureId === "maven-single") {
          const sigText = openFile(second.client, second.projectDir, APP_MAIN);
          const sigWait = await waitForSignature(
            second.client,
            `file://${join(second.projectDir, APP_MAIN)}`,
            locateAfterPrefix(sigText, SIG_OVERLOAD_LINE, "sb.append("),
            (result) => evaluateSignatureExpect({ minSignatures: 1 }, result),
            240_000,
          );
          signatureOkAfterRestart = sigWait.satisfied;
          signatureReason = sigWait.evaluation.reason ?? null;
          if (!sigWait.satisfied) trace.failures.push(`restart-signature: ${sigWait.evaluation.reason}`);
        }
        trace.restart = {
          performed: true,
          msToReadyAfterRestart: Date.now() - restartStarted,
          completionOkAfterRestart: wait.satisfied,
          signatureHelpOkAfterRestart: fixtureId === "maven-single" ? signatureOkAfterRestart : null,
          reason: wait.evaluation.reason ?? null,
          signatureReason,
        };
        // §8.20.3 W2 offline-cache hint: a warm second session should reach
        // its first satisfied completion noticeably faster than the cold one.
        const firstMs = trace.analysisTiming?.firstCompletionSatisfiedMs ?? null;
        const restartFirstMs = wait.satisfied ? Date.now() - second.startedAt : null;
        trace.analysisTiming = {
          ...trace.analysisTiming,
          offlineCacheHint: {
            coldSessionFirstSatisfiedMs: firstMs,
            restartedSessionFirstSatisfiedMs: restartFirstMs,
            fasterThanCold: firstMs !== null && restartFirstMs !== null
              ? restartFirstMs < firstMs
              : null,
          },
        };
        if (!wait.satisfied) trace.failures.push(`restart: ${wait.evaluation.reason}`);
      } finally {
        await second.client.shutdown().catch(() => {});
        rmSync(second.dataDir, { recursive: true, force: true });
      }
    }

    if (spec.collectDiagnostics) {
      trace.diagnosticsSummary = {
        count: session.diagnosticsLog.length,
        mentionsMissingLib: session.diagnosticsLog.some((d) => d.message.includes("missing-lib")),
        sampleMessages: session.diagnosticsLog.slice(0, 3).map((d) => d.message.split("\n")[0]),
      };
    }
  } finally {
    await session.client.shutdown().catch(() => {});
    rmSync(session.dataDir, { recursive: true, force: true });
  }

  // §8.20.2 W1: distinguish "statically declared", "dynamically registered"
  // and "proven by a satisfied scenario" — jdtls registers signatureHelp/hover
  // at runtime, so a bare static-capability read would misreport them absent.
  const staticCaps = session.serverCapabilities ?? {};
  const anySignatureOk = trace.scenarios.some((scenario) => scenario.signatureHelp?.satisfied);
  const anyHoverOk = trace.scenarios.some((scenario) => scenario.hover?.contentsPresent);
  trace.providerChannels.signatureHelpProviderDeclaredStatically = !!staticCaps?.textDocument?.signatureHelpProvider;
  trace.providerChannels.hoverProviderDeclaredStatically = !!staticCaps?.textDocument?.hoverProvider;
  trace.providerChannels.signatureHelpProvenByScenarios = anySignatureOk;
  trace.providerChannels.hoverProvenByScenarios = anyHoverOk;
  trace.providerChannels.dynamicRegistrations = [...new Set(session.registeredMethods)].sort();
  delete trace.providerChannels.signatureHelpProvider;
  delete trace.providerChannels.hoverProvider;

  const sanitize = makeSanitizer(session.projectDir);
  const sanitizedTrace = sanitize(trace);
  mkdirSync(TRACES_DIR, { recursive: true });
  const outFile = join(TRACES_DIR, `${fixtureId}.trace.json`);
  writeFileSync(outFile, `${JSON.stringify(sanitizedTrace, null, 2)}\n`, "utf8");

  return { fixtureId, outFile, failures: trace.failures };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const requested = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture") requested.push(args[++i]);
  }
  const fixtureIds = requested.length > 0 ? requested : Object.keys(FIXTURES);

  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  if (javaInfo.major < 17) throw new Error(`jdtls needs Java 17+; got ${javaInfo.line}`);
  const jdtls = resolveJdtlsHome();
  const gradle = resolveGradleDist();
  const mvnVersion = (() => {
    for (const mvn of ["/data/dev/maven/bin/mvn", "mvn"]) {
      try {
        const out = execFileSync(mvn, ["-version"], { encoding: "utf8" });
        return out.split("\n")[0]?.trim() ?? null;
      } catch {
        continue;
      }
    }
    return null;
  })();

  const toolchain = {
    java: { path: javaPath.replace(homedir(), "~"), version: javaInfo.version, info: javaInfo },
    jdtls: { home: jdtls.home.replace(homedir(), "~"), version: jdtls.version },
    gradle: gradle ? { version: gradle.version, home: gradle.home.replace(homedir(), "~") } : null,
    mavenCliDetected: mvnVersion,
  };
  console.log("toolchain:", JSON.stringify(toolchain));

  const results = [];
  for (const fixtureId of fixtureIds) {
    if (!FIXTURES[fixtureId]) throw new Error(`unknown fixture ${fixtureId}`);
    console.log(`\n=== ${fixtureId} ===`);
    const outcome = await runFixture(fixtureId, toolchain, jdtls, gradle?.home ?? null);
    console.log(`trace: ${outcome.outFile}`);
    if (outcome.failures.length > 0) {
      console.log(`FAILURES (${outcome.failures.length}):`);
      for (const failure of outcome.failures) console.log(`  - ${failure}`);
    } else {
      console.log("all cases green");
    }
    results.push(outcome);
  }

  const failed = results.filter((result) => result.failures.length > 0);
  console.log(`\n${results.length - failed.length}/${results.length} fixtures green`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
