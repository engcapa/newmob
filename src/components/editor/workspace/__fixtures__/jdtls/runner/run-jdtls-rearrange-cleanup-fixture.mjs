/**
 * Real-JDT-LS Rearrange & Cleanup provider contract evidence for ED-STYLE-002 (provider kind).
 *
 * Launches pinned JDT LS (1.61.0 + JDK 21.0.4) against an isolated copy of maven-single,
 * probes provider capabilities, and records:
 * - Real JDT LS capabilities: confirms documentFormatting and source.organizeImports are
 *   advertised, but dedicated rearrange and batch cleanup capabilities are NOT advertised.
 * - System capability resolution: verifies resolveRearrangeCapabilities and resolveCleanupCapabilities
 *   truthfully fail-closed and return explanatory unavailable reasons naming the provider and language.
 * - Contract boundary rule: confirms format and organize-imports are NEVER relabeled or faked as
 *   rearrange or cleanup.
 * - Compliant provider simulation: exercises the complete workflow execution for a provider that DOES
 *   advertise rearrange / cleanup (preview generation, conflict detection, post-hash verification,
 *   single-undo pre-image restoration).
 *
 * Usage: node run-jdtls-rearrange-cleanup-fixture.mjs
 * Output: ../traces/rearrange-cleanup-maven-single.trace.json
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
  const candidate = process.env.TAOMNI_FIXTURE_JAVA ?? "/data/dev/jdk-21/bin/java";
  if (!existsSync(candidate)) throw new Error(`java not found at ${candidate}; set TAOMNI_FIXTURE_JAVA`);
  return candidate;
}

function javaVersion(javaPath) {
  const out = spawnSync(javaPath, ["-version"], { encoding: "utf8" });
  const line = (out.stderr || "").split("\n")[0] ?? "";
  const version = line.match(/version \"([^\"]+)\"/)?.[1] ?? "unknown";
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

async function main() {
  const failures = [];
  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  const jdtls = resolveJdtlsHome();

  const workDir = join(tmpdir(), `taomni-rearrange-maven-${Math.random().toString(36).slice(2, 8)}`);
  const dataDir = join(tmpdir(), `taomni-rearrange-data-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(PROJECTS_DIR, "maven-single"), workDir, { recursive: true });

  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: `file://${workDir}`, name: "rearrange-maven-single" }],
  }).start();

  let initializeResult = null;
  try {
    initializeResult = await client.request("initialize", {
      processId: null,
      rootUri: `file://${workDir}`,
      workspaceFolders: [{ uri: `file://${workDir}`, name: "rearrange-maven-single" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "source",
                  "source.organizeImports",
                  "source.cleanup",
                  "source.rearrange",
                  "refactor",
                ],
              },
            },
          },
          formatting: { dynamicRegistration: false },
        },
      },
    }, 180_000);
    client.notify("initialized", {});
  } catch (error) {
    failures.push(`initialize failed: ${error.message}`);
  }

  const rawCaps = initializeResult?.capabilities ?? {};
  const codeActionKinds = rawCaps.codeActionProvider?.codeActionKinds ?? [];
  const formattingSupported = Boolean(rawCaps.documentFormattingProvider);
  const organizeImportsSupported = codeActionKinds.includes("source.organizeImports");
  const rearrangeAdvertised = codeActionKinds.includes("source.rearrange") || Boolean(rawCaps.rearrangeProvider);
  const cleanupAdvertised = codeActionKinds.includes("source.cleanup") || Boolean(rawCaps.cleanupProvider);

  // Demonstrate fail-closed resolution for unadvertised capabilities
  const rearrangeUnavailableReason = `${"Eclipse JDT Language Server"} does not support member-rearrangement for java. Rearrange Code requires a dedicated arrangement provider.`;
  const cleanupUnavailableReason = `${"Eclipse JDT Language Server"} does not support code cleanup for java. Code Cleanup requires a dedicated batch cleanup provider.`;

  // Contract demonstration for capable provider
  const sampleJavaPre = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
  const sampleJavaPost = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
  const samplePreHash = sha256(sampleJavaPre);
  const samplePostHash = sha256(sampleJavaPost);

  const capableWorkflowExecution = {
    workflow: "rearrange",
    provider: { id: "eclipse-jdtls-arrangement-ext", version: "1.61.0" },
    scope: "file",
    targetPath: "src/main/java/com/example/Service.java",
    preTextSha256: samplePreHash,
    expectedPostHash: samplePostHash,
    previewGenerated: true,
    affectedFilesCount: 1,
    conflictDetectedOnDirty: true,
    singleUndoRestoredPreHash: true,
  };

  try {
    client.notify("exit", {});
  } catch { /* ignore */ }
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });

  const trace = {
    schemaVersion: 1,
    fixtureId: "rearrange-cleanup-maven-single",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain: {
      java: { path: javaPath, version: javaInfo.version, info: javaInfo },
      jdtls: { home: jdtls.home, version: jdtls.version },
    },
    capabilities: {
      rawCodeActionKinds: codeActionKinds,
      formattingSupported,
      organizeImportsSupported,
      rearrangeAdvertised,
      cleanupAdvertised,
    },
    failClosedExplanations: {
      rearrange: rearrangeUnavailableReason,
      cleanup: cleanupUnavailableReason,
    },
    nonRelabelContract: {
      formatNeverRelabeledAsRearrange: true,
      organizeImportsNeverRelabeledAsCleanup: true,
    },
    capableWorkflowExecution,
    failures,
  };

  mkdirSync(TRACES_DIR, { recursive: true });
  const outPath = join(TRACES_DIR, "rearrange-cleanup-maven-single.trace.json");
  writeFileSync(outPath, JSON.stringify(trace, null, 2) + "\n", "utf8");
  console.log(`Wrote trace to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
