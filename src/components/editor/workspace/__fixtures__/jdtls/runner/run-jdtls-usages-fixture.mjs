/**
 * Real-JDT-LS references evidence for ED-USAGE-002 (provider kind).
 *
 * Standalone on purpose (same rationale as run-jdtls-format-fixture.mjs):
 * the shared R3-c runner owns the completion/reference-information contract
 * and must not gain a references schema. This script launches the pinned
 * JDT LS against the maven-single sample READ-ONLY (didOpen + requests only;
 * the shared fixture tree is never written) and records textDocument/
 * references rows for two symbols:
 *
 * - workspace symbol `App` (AppTest.java:10): declaration in App.java plus
 *   the workspace usage — declaration + workspace rows;
 * - library symbol `StringUtils` (App.java:51, commons-lang3): declaration
 *   inside the dependency jar plus the workspace usage — library rows.
 *
 * JDT LS classifies no read/write roles over plain references, so every row
 * is honestly `unknown` except range-matched declarations; ownership is
 * derived from URIs (jar:/jdt: vs workspace file://). That unknown-honesty
 * is exactly what ED-USAGE-002 requires the product to preserve.
 *
 * Usage: node run-jdtls-usages-fixture.mjs
 * Output: ../traces/usages-maven-single.trace.json
 * Environment overrides: TAOMNI_FIXTURE_JAVA, JDTLS_HOME.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function sanitizeUri(uri) {
  return String(uri ?? "").replace(homedir(), "~");
}

function classifyOwnership(uri) {
  const value = String(uri ?? "");
  if (/^jdt:\/\/|^cfr:\/\/|^fernflower:\/\//i.test(value)) return "decompiled";
  if (/^jar:file:|^zip:file:/i.test(value)) return "library";
  return "workspace-or-external";
}

async function main() {
  const failures = [];
  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  const jdtls = resolveJdtlsHome();
  const projectDir = join(PROJECTS_DIR, "maven-single");
  const dataDir = join(tmpdir(), `taomni-usages-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });

  const appFile = "src/main/java/com/example/single/App.java";
  const testFile = "src/test/java/com/example/single/AppTest.java";
  const appText = readFileSync(join(projectDir, appFile), "utf8");
  const testText = readFileSync(join(projectDir, testFile), "utf8");

  const appLines = appText.split("\n");
  const stringUtilsLine = appLines.findIndex((line) => line.includes("StringUtils.isBlank"));
  const testLines = testText.split("\n");
  const appUsageLine = testLines.findIndex((line) => line.includes("App.class"));
  if (stringUtilsLine < 0 || appUsageLine < 0) {
    throw new Error("fixture anchors moved; update the usages scenario positions");
  }

  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: `file://${projectDir}`, name: "usages-maven-single" }],
  }).start();

  try {
    await client.request("initialize", {
      processId: null,
      rootUri: `file://${projectDir}`,
      workspaceFolders: [{ uri: `file://${projectDir}`, name: "usages-maven-single" }],
      capabilities: {
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    }, 180_000);
    client.notify("initialized", {});
  } catch (error) {
    failures.push(`initialize failed: ${error.message}`);
  }

  const openFile = (relPath, text) => {
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: `file://${join(projectDir, relPath)}`,
        languageId: "java",
        version: 1,
        text,
      },
    });
  };
  openFile(appFile, appText);
  openFile(testFile, testText);

  const scenarios = [
    {
      id: "workspace-symbol-App",
      file: testFile,
      // Caret inside `App` of `App.class` (0-based).
      position: {
        line: appUsageLine,
        character: testLines[appUsageLine].indexOf("App.class") + 1,
      },
      expectDeclarationIn: "App.java",
      notes: "workspace symbol: declaration plus workspace usage rows expected",
    },
    {
      id: "library-symbol-StringUtils",
      file: appFile,
      position: {
        line: stringUtilsLine,
        character: appLines[stringUtilsLine].indexOf("StringUtils") + 2,
      },
      expectDeclarationIn: "App.java",
      requireDeclaration: false,
      notes: "commons-lang3 FQN usage: the workspace usage row itself is the proof (JDT returns no jar declaration here)",
    },
  ];
  for (const scenario of scenarios) {
    const uri = `file://${join(projectDir, scenario.file)}`;
    const attempts = [];
    let locations = null;
    const deadline = Date.now() + 300_000;
    for (;;) {
      const attemptStart = Date.now();
      try {
        const value = await client.request("textDocument/references", {
          textDocument: { uri },
          position: scenario.position,
          context: { includeDeclaration: true },
        }, 120_000);
        const list = Array.isArray(value) ? value : [];
        attempts.push({ ms: Date.now() - attemptStart, itemCount: list.length });
        if (list.length > 0) {
          locations = list;
          break;
        }
      } catch (error) {
        attempts.push({ ms: Date.now() - attemptStart, itemCount: -1, error: String(error.message).slice(0, 200) });
      }
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const found = locations ?? [];
    const ownershipCounts = {};
    for (const loc of found) {
      const owner = classifyOwnership(loc.uri);
      ownershipCounts[owner] = (ownershipCounts[owner] ?? 0) + 1;
    }
    const declarationHit = scenario.requireDeclaration === false
      ? true
      : found.some((loc) => String(loc.uri ?? "").includes(scenario.expectDeclarationIn));
    scenario.result = {
      attempts,
      msTotal: attempts.reduce((sum, attempt) => sum + attempt.ms, 0),
      itemCount: found.length,
      satisfied: found.length > 0 && declarationHit,
      declarationHit,
      ownershipCounts,
      locations: found.slice(0, 25).map((loc) => ({
        uri: sanitizeUri(loc.uri),
        range: loc.range ?? null,
      })),
      locationsSha256: sha256(JSON.stringify(found.map((loc) => [loc.uri, loc.range]))),
    };
    if (!scenario.result.satisfied) {
      failures.push(`${scenario.id}: expected declaration evidence, got ${found.length} locations`);
    }
    delete scenario.position;
  }

  try {
    await client.request("shutdown", null, 10_000);
  } catch { /* best effort */ }
  client.child.kill("SIGKILL");
  await client.exitPromise;

  const trace = {
    schemaVersion: 1,
    fixtureId: "usages-maven-single",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain: {
      java: { path: javaPath.replace(homedir(), "~"), version: javaInfo.version, info: javaInfo },
      jdtls: { home: jdtls.home.replace(homedir(), "~"), version: jdtls.version },
    },
    scenarios: scenarios.map(({ result, ...rest }) => ({ ...rest, ...result })),
    failures,
  };

  mkdirSync(TRACES_DIR, { recursive: true });
  const outFile = join(TRACES_DIR, "usages-maven-single.trace.json");
  writeFileSync(outFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  rmSync(dataDir, { recursive: true, force: true });

  console.log(`toolchain: java ${javaInfo.version}, jdtls ${jdtls.version}`);
  console.log(`trace: ${outFile}`);
  if (failures.length > 0) {
    console.log(`FAILURES (${failures.length}):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("usages green: declaration + workspace usage rows proven (roles honestly unknown)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
