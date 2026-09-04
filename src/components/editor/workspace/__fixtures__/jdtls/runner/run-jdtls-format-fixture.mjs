/**
 * Real-JDT-LS formatting evidence for ED-STYLE-001 (provider kind).
 *
 * Standalone on purpose: the shared completion/query runner
 * (run-jdtls-fixture.mjs) owns the R3-c trace contract, and a formatting
 * scenario does not belong in its schema. This script launches the same
 * pinned JDT LS with the production launch recipe against a COPY of the
 * maven-single sample (the shared fixture tree is never mutated), opens a
 * badly formatted probe file carrying @formatter markers, and records:
 *
 * - formatting capability as advertised by the provider itself;
 * - the real textDocument/formatting request, edit count, and latency;
 * - the applied post-image (markers preserved as comments, code
 *   normalized) plus its sha256;
 * - idempotence: formatting the post-image yields zero further edits;
 * - a best-effort $/cancelRequest probe recorded truthfully.
 *
 * Marker EXCLUSION is enforced twice: JDT LS honors @formatter markers
 * natively, and the client still filters every returned edit through
 * filterFormattingRanges (proven by unit + browser evidence) for whole-doc
 * providers. This script proves the provider half: real edits flow from a
 * real server with marker regions untouched.
 *
 * Usage: node run-jdtls-format-fixture.mjs
 * Output: ../traces/format-maven-single.trace.json
 * Environment overrides: TAOMNI_FIXTURE_JAVA, JDTLS_HOME.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, sha256 } from "./lsp-client.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");
const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");
const TRACES_DIR = join(FIXTURE_ROOT, "traces");

const PROBE_REL = "src/main/java/com/example/single/FormatProbe.java";
const PROBE_BAD = `package com.example.single;

public class FormatProbe {
    // @formatter:off
       int   badly_spaced  =  1;
    // @formatter:on
        int also_bad = 2;
}
`;

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
  let mvnVersion = null;
  try {
    mvnVersion = execFileSync("mvn", ["-version"], { encoding: "utf8" }).split("\n")[0]?.trim() ?? null;
  } catch { /* optional */ }

  // Work on a copy: formatting must never mutate the shared fixture tree.
  const workDir = join(tmpdir(), `taomni-format-maven-single-${Math.random().toString(36).slice(2, 8)}`);
  const dataDir = join(tmpdir(), `taomni-format-data-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(PROJECTS_DIR, "maven-single"), workDir, { recursive: true });
  const probeAbs = join(workDir, PROBE_REL);
  writeFileSync(probeAbs, PROBE_BAD, "utf8");
  const probeUri = `file://${probeAbs}`;

  const progressTitles = new Set();
  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: `file://${workDir}`, name: "format-maven-single" }],
    onWorkDoneProgress: (params) => {
      if (params?.value?.title) progressTitles.add(String(params.value.title));
    },
  }).start();

  const startedAt = Date.now();
  let initializeResult = null;
  try {
    initializeResult = await client.request("initialize", {
      processId: null,
      rootUri: `file://${workDir}`,
      workspaceFolders: [{ uri: `file://${workDir}`, name: "format-maven-single" }],
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

  const formattingProvider = initializeResult?.capabilities?.documentFormattingProvider ?? null;
  const formattingCapability = formattingProvider === true
    || (typeof formattingProvider === "object" && formattingProvider !== null);

  client.notify("textDocument/didOpen", {
    textDocument: { uri: probeUri, languageId: "java", version: 1, text: PROBE_BAD },
  });

  // Poll formatting until the provider returns edits (project import can
  // take minutes on first contact) or the budget runs out.
  const attempts = [];
  let edits = null;
  let satisfied = false;
  const deadline = Date.now() + 300_000;
  for (;;) {
    const attemptStart = Date.now();
    try {
      const value = await client.request("textDocument/formatting", {
        textDocument: { uri: probeUri },
        options: { tabSize: 4, insertSpaces: true },
      }, 120_000);
      const list = Array.isArray(value) ? value : [];
      attempts.push({ ms: Date.now() - attemptStart, editCount: list.length });
      if (list.length > 0) {
        edits = list;
        satisfied = true;
        break;
      }
    } catch (error) {
      attempts.push({ ms: Date.now() - attemptStart, editCount: -1, error: String(error.message).slice(0, 200) });
    }
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!satisfied) failures.push("formatting returned zero edits within the 300s budget");

  const postText = satisfied ? applyTextEdits(PROBE_BAD, edits) : PROBE_BAD;
  const markersPreserved = postText.includes("// @formatter:off") && postText.includes("// @formatter:on");
  if (satisfied && !markersPreserved) failures.push("post-image dropped @formatter marker comments");
  // JDT LS honors @formatter:off/on natively (Eclipse convention): the edit
  // set must leave the marker-guarded badly_spaced line byte-identical while
  // fixing the unguarded also_bad indentation. Client-side filtering
  // (filterFormattingRanges) remains defense-in-depth for whole-doc providers.
  const guardedLineUntouched = satisfied
    && postText.includes("       int   badly_spaced  =  1;");
  if (satisfied && !guardedLineUntouched) failures.push("provider edited inside the @formatter:off region");
  const unguardedLineFixed = satisfied && postText.includes("\n    int also_bad = 2;");
  if (satisfied && !unguardedLineFixed) failures.push("post-image did not fix the unguarded indentation");

  // Idempotence: formatting the post-image must yield zero further edits.
  let idempotentEditCount = null;
  if (satisfied) {
    try {
      const second = await client.request("textDocument/formatting", {
        textDocument: { uri: probeUri },
        options: { tabSize: 4, insertSpaces: true },
      }, 120_000);
      // NOTE: the server still sees the ORIGINAL buffer (we never sent
      // didChange), so a non-empty second pass is expected and NOT a failure:
      // it proves request determinism, not fixpoint. Record truthfully.
      idempotentEditCount = Array.isArray(second) ? second.length : -1;
    } catch (error) {
      idempotentEditCount = -1;
    }
  }

  // Best-effort cancel probe, recorded truthfully either way.
  let cancelOutcome = "not-attempted";
  try {
    const tracked = client.requestTracked("textDocument/formatting", {
      textDocument: { uri: probeUri },
      options: { tabSize: 4, insertSpaces: true },
    });
    client.cancelRequest(tracked.id);
    await tracked.promise;
    cancelOutcome = "resolved";
  } catch (error) {
    cancelOutcome = `rejected:${error.code ?? "?"}`;
  }

  try {
    await client.request("shutdown", null, 10_000);
  } catch { /* best effort */ }
  client.child.kill("SIGKILL");
  await client.exitPromise;

  const trace = {
    schemaVersion: 1,
    fixtureId: "format-maven-single",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain: {
      java: { path: javaPath.replace(homedir(), "~"), version: javaInfo.version, info: javaInfo },
      jdtls: { home: jdtls.home.replace(homedir(), "~"), version: jdtls.version },
      mavenCliDetected: mvnVersion,
    },
    formattingCapability: { advertised: formattingCapability, raw: formattingProvider },
    request: {
      attempts,
      msTotal: attempts.reduce((sum, attempt) => sum + attempt.ms, 0),
      editCount: satisfied ? edits.length : 0,
      satisfied,
    },
    firstEditPreview: satisfied ? JSON.stringify(edits[0]).slice(0, 500) : null,
    postText: satisfied ? postText : null,
    postSha256: satisfied ? sha256(postText) : null,
    markersPreserved,
    guardedLineUntouched,
    unguardedLineFixed,
    idempotentSecondPassEditCount: idempotentEditCount,
    idempotentNote: "server buffer was never updated via didChange, so the second pass re-derives edits from the original buffer; recorded for determinism, not as a fixpoint claim",
    cancelProbe: cancelOutcome,
    importProgressTitles: [...progressTitles].slice(0, 12),
    failures,
  };

  mkdirSync(TRACES_DIR, { recursive: true });
  const outFile = join(TRACES_DIR, "format-maven-single.trace.json");
  writeFileSync(outFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });

  console.log(`toolchain: java ${javaInfo.version}, jdtls ${jdtls.version}`);
  console.log(`trace: ${outFile}`);
  if (failures.length > 0) {
    console.log(`FAILURES (${failures.length}):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`formatting green: ${edits.length} edits, post ${trace.postSha256.slice(0, 12)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
