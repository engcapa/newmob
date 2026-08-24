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
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
    },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeConfiguration: { dynamicRegistration: true },
    },
  };
}

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
            ...(gradleHome ? { home: gradleHome } : {}),
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture matrix (§8.19.4 scenario coverage)
// ---------------------------------------------------------------------------

const APP_MAIN = "src/main/java/com/example/single/App.java";
const APP_TEST = "src/test/java/com/example/single/AppTest.java";

/**
 * Every case locates one bare token in one file, requests completion at the
 * token end, applies expectations, optionally resolves the matched item, and
 * optionally verifies that reverting the merged acceptance restores the
 * original document hash exactly.
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
    ],
    restartAfterCases: { file: APP_MAIN, token: "Stri", expect: { labelEquals: "String" } },
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
  }).start();
  const startedAt = Date.now();
  await client.request("initialize", {
    processId: null,
    rootUri: `file://${projectDir}`,
    workspaceFolders: [{ uri: `file://${projectDir}`, name: fixtureId }],
    initializationOptions: initializationSettings(options.gradleHome ?? null),
    capabilities: clientCapabilities(),
  }, 180_000);
  client.notify("initialized", {});
  return { client, diagnosticsLog, msToInitialize: Date.now() - startedAt, projectDir, dataDir };
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
    for (const fileSpec of spec.filesToOpen) {
      const text = openFile(session.client, session.projectDir, fileSpec.path);
      openedUris.set(fileSpec.path, { uri: `file://${join(session.projectDir, fileSpec.path)}`, text });
    }

    // Give the importer a moment to publish progress; cases poll anyway.
    for (const testCase of spec.cases) {
      const entry = openedUris.get(testCase.file);
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
        trace.restart = {
          performed: true,
          msToReadyAfterRestart: Date.now() - restartStarted,
          completionOkAfterRestart: wait.satisfied,
          reason: wait.evaluation.reason ?? null,
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
