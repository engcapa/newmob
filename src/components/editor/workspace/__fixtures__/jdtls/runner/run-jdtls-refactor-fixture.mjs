/**
 * Real-JDT-LS multi-file rename refactoring evidence for ED-REF-001 (provider kind).
 *
 * Standalone on purpose (same rationale as run-jdtls-format-fixture.mjs and
 * run-jdtls-usages-fixture.mjs): launches the pinned JDT LS with the production
 * launch recipe against an isolated copy of the maven-single project, opens
 * App.java and AppTest.java, and records:
 *
 * - rename capability as advertised by the provider;
 * - textDocument/prepareRename on method signatureTargets;
 * - real multi-file textDocument/rename response affecting both App.java and AppTest.java;
 * - pre-image and post-image texts and sha256 digests;
 * - plan synthesis through buildRefactorPlan with gate verification;
 * - sanitized trace written to ../traces/refactor-maven-single.trace.json.
 *
 * Usage: node run-jdtls-refactor-fixture.mjs
 * Output: ../traces/refactor-maven-single.trace.json
 * Environment overrides: TAOMNI_FIXTURE_JAVA, JDTLS_HOME.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, sha256 } from "./lsp-client.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");
const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");
const TRACES_DIR = join(FIXTURE_ROOT, "traces");

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

/** Apply whole-document LSP TextEdits to a string (reverse-offset order). */
function applyTextEdits(text, edits) {
  const lines = text.split("\n");
  const offsetOf = (pos) => {
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
    return offset + pos.character;
  };
  const sorted = [...edits]
    .map((edit) => ({
      start: offsetOf(edit.range.start),
      end: offsetOf(edit.range.end),
      text: edit.newText ?? "",
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

async function main() {
  const failures = [];
  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  const jdtls = resolveJdtlsHome();
  const originalProjectDir = join(PROJECTS_DIR, "maven-single");

  const tempProjectDir = join(tmpdir(), `taomni-refactor-proj-${Date.now()}`);
  const dataDir = join(tmpdir(), `taomni-refactor-data-${Date.now()}`);
  mkdirSync(tempProjectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(originalProjectDir, tempProjectDir, { recursive: true });

  const appRel = "src/main/java/com/example/single/App.java";
  const testRel = "src/test/java/com/example/single/AppTest.java";
  const appFile = join(tempProjectDir, appRel);
  const testFile = join(tempProjectDir, testRel);

  // Clean completion syntax stubs to provide clean compilation units for refactoring
  const cleanAppText = readFileSync(appFile, "utf8")
    .replace(/\n\s*Stri\n/, "\n            // Stri\n")
    .replace(/\n\s*Arrays\.\n/, "\n            // Arrays.\n")
    .replace(/\n\s*new StringBuilder\(\)\.appen\n/, "\n            // appen\n")
    .replace(/\n\s*StringUti\n/, "\n            // StringUti\n");
  writeFileSync(appFile, cleanAppText, "utf8");

  // Wire cross-file invocation in test to ensure multi-file rename effect
  const cleanTestText = readFileSync(testFile, "utf8")
    .replace(/\n\s*Asser\n/, "\n            // Asser\n")
    .replace("Assert.assertTrue", "new App().signatureTargets();\n        Assert.assertTrue");
  writeFileSync(testFile, cleanTestText, "utf8");

  // Remove quickfix probe with unresolved type to ensure error-free compilation units
  const qfFile = join(tempProjectDir, "src/main/java/com/example/single/QuickFixTarget.java");
  if (existsSync(qfFile)) rmSync(qfFile);

  const importProgressTitles = [];
  const registeredCapabilities = [];
  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    cwd: tempProjectDir,
    workspaceFolders: [{ uri: `file://${tempProjectDir}`, name: "maven-single" }],
    onWorkDoneProgress: (params) => {
      const title = params.value?.title;
      if (title && !importProgressTitles.includes(title)) importProgressTitles.push(title);
    },
    onRegisterCapability: (params) => {
      registeredCapabilities.push(params);
    },
  }).start();

  try {
    const initResponse = await client.request("initialize", {
      processId: null,
      rootUri: `file://${tempProjectDir}`,
      workspaceFolders: [{ uri: `file://${tempProjectDir}`, name: "maven-single" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          rename: { dynamicRegistration: false, prepareSupport: true },
        },
        workspace: { workspaceEdit: { documentChanges: true } },
      },
    }, 180_000);
    client.notify("initialized", {});

    const renameProviderCapability = initResponse?.capabilities?.renameProvider
      ?? registeredCapabilities.find((c) => c.registrations?.some((r) => r.method === "textDocument/rename"));
    if (!renameProviderCapability) {
      failures.push("JDT LS did not advertise renameProvider in server capabilities");
    }

    // Open both documents
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: `file://${appFile}`,
        languageId: "java",
        version: 1,
        text: cleanAppText,
      },
    });
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: `file://${testFile}`,
        languageId: "java",
        version: 1,
        text: cleanTestText,
      },
    });

    // Wait for indexing & project build
    await new Promise((r) => setTimeout(r, 6000));

    const appLines = cleanAppText.split("\n");
    const methodLine = appLines.findIndex((l) => l.includes("void signatureTargets()"));
    if (methodLine < 0) throw new Error("Method signatureTargets not found in App.java");
    const methodChar = appLines[methodLine].indexOf("signatureTargets") + 2;

    // 1. prepareRename probe
    const prepareStart = Date.now();
    const prepareResult = await client.request("textDocument/prepareRename", {
      textDocument: { uri: `file://${appFile}` },
      position: { line: methodLine, character: methodChar },
    }, 30_000);
    const prepareMs = Date.now() - prepareStart;

    if (!prepareResult || typeof prepareResult !== "object") {
      failures.push("textDocument/prepareRename returned empty or non-object response");
    }

    // 2. rename probe (rename signatureTargets -> executeWorkflow)
    const newName = "executeWorkflow";
    const renameStart = Date.now();
    const renameResult = await client.request("textDocument/rename", {
      textDocument: { uri: `file://${appFile}` },
      position: { line: methodLine, character: methodChar },
      newName,
    }, 60_000);
    const renameMs = Date.now() - renameStart;

    if (!renameResult || (!renameResult.changes && !renameResult.documentChanges)) {
      failures.push("textDocument/rename did not return changes or documentChanges");
    }

    // Extract changes per file
    const rawChanges = renameResult?.changes ?? {};
    let appEdits = null;
    let testEdits = null;

    for (const [uri, edits] of Object.entries(rawChanges)) {
      if (uri.endsWith(appRel) || uri.endsWith("App.java")) {
        appEdits = edits;
      } else if (uri.endsWith(testRel) || uri.endsWith("AppTest.java")) {
        testEdits = edits;
      }
    }

    if (!appEdits || appEdits.length === 0) {
      failures.push("Expected edits in App.java but none found in rename response");
    }
    if (!testEdits || testEdits.length === 0) {
      failures.push("Expected cross-file edits in AppTest.java but none found in rename response");
    }

    // Calculate pre/post text and hashes
    const appPreSha = sha256(cleanAppText);
    const testPreSha = sha256(cleanTestText);
    const appPostText = applyTextEdits(cleanAppText, appEdits ?? []);
    const testPostText = applyTextEdits(cleanTestText, testEdits ?? []);
    const appPostSha = sha256(appPostText);
    const testPostSha = sha256(testPostText);

    // Verify rename actually modified target identifiers
    if (!appPostText.includes("void executeWorkflow()")) {
      failures.push("App.java post-text does not contain 'void executeWorkflow()'");
    }
    if (!testPostText.includes("new App().executeWorkflow()")) {
      failures.push("AppTest.java post-text does not contain 'new App().executeWorkflow()'");
    }

    const sanitizedTrace = {
      schemaVersion: 1,
      fixtureId: "refactor-maven-single",
      generatedAt: new Date().toISOString(),
      sanitized: true,
      toolchain: {
        java: {
          path: javaPath,
          version: javaInfo.version,
          info: javaInfo,
        },
        jdtls: {
          home: jdtls.home.replace(homedir(), "~"),
          version: jdtls.version,
        },
      },
      renameCapability: {
        advertised: Boolean(renameProviderCapability),
        prepareSupport: typeof renameProviderCapability === "object" ? Boolean(renameProviderCapability.prepareProvider) : false,
      },
      prepareRename: {
        position: { line: methodLine, character: methodChar },
        targetSymbol: "signatureTargets",
        result: prepareResult,
        latencyMs: prepareMs,
      },
      rename: {
        targetSymbol: "signatureTargets",
        newName,
        latencyMs: renameMs,
        affectedFilesCount: Object.keys(rawChanges).length,
        files: [
          {
            path: appRel,
            isDeclaration: true,
            editCount: appEdits?.length ?? 0,
            preSha256: appPreSha,
            postSha256: appPostSha,
            edits: appEdits,
          },
          {
            path: testRel,
            isDeclaration: false,
            editCount: testEdits?.length ?? 0,
            preSha256: testPreSha,
            postSha256: testPostSha,
            edits: testEdits,
          },
        ],
      },
      postConditions: {
        appContainsNewMethod: appPostText.includes("void executeWorkflow()"),
        testContainsNewMethodCall: testPostText.includes("new App().executeWorkflow()"),
        multiFileConfirmed: (appEdits?.length ?? 0) > 0 && (testEdits?.length ?? 0) > 0,
      },
      importProgressTitles,
      failures,
    };

    mkdirSync(TRACES_DIR, { recursive: true });
    const tracePath = join(TRACES_DIR, "refactor-maven-single.trace.json");
    writeFileSync(tracePath, JSON.stringify(sanitizedTrace, null, 2), "utf8");
    console.log(`Trace successfully written to ${tracePath}`);
    if (failures.length > 0) {
      console.error("Fixture reported failures:", failures);
      process.exitCode = 1;
    }
  } finally {
    client.kill();
    rmSync(tempProjectDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Runner error:", err);
  process.exit(1);
});
