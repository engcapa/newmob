/**
 * §8.20.3 W2 provider-owned Project Analysis fact source.
 *
 * This model answers "can I trust semantic actions right now, and why not"
 * from provider-reported lifecycle facts (session state, work-done progress,
 * executeCommand registrations, classpath probes). It is deliberately NOT a
 * symbol/reference index and must never be presented as one — the freshness
 * ledger in `workspaceSemanticIndex.ts` keeps its own compatibility surface
 * while UI copy calls it Provider freshness.
 */

export type ProjectAnalysisPhase =
  | "unconfigured"
  | "scanning"
  | "importing"
  | "analyzing"
  | "ready"
  | "degraded"
  | "offline"
  | "error";

export interface ProjectAnalysisProgressEntry {
  token: string;
  title: string;
  percentage: number | null;
}

export interface JavaProjectModuleV1 {
  id: string;
  buildSystem: "maven" | "gradle" | "plain";
  root: string;
  sourceRoots: readonly string[];
  testRoots: readonly string[];
  generatedRoots: readonly string[];
  excludedRoots: readonly string[];
  dependencyFingerprint: string;
}

export interface ProjectSdkIdentity {
  homeHash: string;
  version: string;
  languageLevel: string | null;
}

/** Provider-side facts gathered through the `lsp_java_project_model` IPC. */
export interface ProjectProviderFacts {
  configured: boolean;
  /** A jdtls session is live for this workspace's java roots. */
  active: boolean;
  /** Session start is in flight (no ready session yet). */
  opening: boolean;
  lastError: string | null;
  processId: number | null;
  serverName: string | null;
  serverVersion: string | null;
  /** `workspace/executeCommand` command names the provider registered. */
  registeredCommands: readonly string[];
}

export interface ProjectClasspathProbe {
  kind: "not-run" | "ok" | "unavailable" | "failed";
  reason: string | null;
  rootUri: string | null;
  entryCount: number | null;
  entriesSha256: string | null;
  completedAt: number | null;
}

export interface ProjectBuildModelInputs {
  roots: readonly string[];
  buildFiles: readonly { path: string; sha256: string }[];
  sdk: ProjectSdkIdentity | null;
}

export interface ProjectAnalysisSnapshotInputs {
  workspaceId: string;
  generation: number;
  provider: ProjectProviderFacts;
  progress: ReadonlyArray<{
    token: string | number;
    title: string | null;
    percentage?: number | null;
  }>;
  probe: ProjectClasspathProbe;
  modules: readonly JavaProjectModuleV1[] | null;
  build: ProjectBuildModelInputs;
  now?: number;
}

export interface JavaProjectAnalysisSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  generation: number;
  provider: { id: "jdtls"; version: string | null; processId: number | null };
  phase: ProjectAnalysisPhase;
  projectFingerprint: string;
  sdk: ProjectSdkIdentity | null;
  modules: readonly JavaProjectModuleV1[];
  progress: readonly ProjectAnalysisProgressEntry[];
  completeness: "unknown" | "partial" | "complete";
  diagnostics: readonly string[];
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// SHA-256 (sync, dependency-free) — fingerprints must be computable inside
// pure reducers and jsdom tests, so WebCrypto's async subtle API is not an
// option here. Standard FIPS implementation over UTF-8 input.
// ---------------------------------------------------------------------------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function sha256HexBytes(message: Uint8Array): string {
  const bitLength = message.length * 8;
  // Padded length: message + 0x80 + zeros + 8-byte big-endian bit length,
  // rounded up to a multiple of 64 bytes.
  const paddedLength = (((message.length + 9) / 64) | 0) * 64 + 64;
  const words = new Uint32Array(paddedLength / 4);
  for (let index = 0; index < message.length; index += 1) {
    words[index >> 2] |= message[index]! << ((3 - (index & 3)) * 8);
  }
  words[message.length >> 2] |= 0x80 << ((3 - (message.length & 3)) * 8);
  words[words.length - 1] = bitLength >>> 0;
  if (bitLength > 0xffffffff) {
    words[words.length - 2] = Math.floor(bitLength / 0x100000000) >>> 0;
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < words.length; offset += 16) {
    for (let index = 0; index < 16; index += 1) w[index] = words[offset + index]!;
    for (let index = 16; index < 64; index += 1) {
      const s0 = ((w[index - 15]!) >>> 7 | (w[index - 15]!) << 25)
        ^ ((w[index - 15]!) >>> 18 | (w[index - 15]!) << 14)
        ^ ((w[index - 15]!) >>> 3);
      const s1 = ((w[index - 2]!) >>> 17 | (w[index - 2]!) << 15)
        ^ ((w[index - 2]!) >>> 19 | (w[index - 2]!) << 13)
        ^ ((w[index - 2]!) >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const bigS1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + ch + SHA_K[index]! + w[index]!) >>> 0;
      const bigS0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${toHex(h0)}${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}${toHex(h5)}${toHex(h6)}${toHex(h7)}`;
}

export function sha256Hex(input: string): string {
  return sha256HexBytes(utf8Bytes(input));
}

// ---------------------------------------------------------------------------
// Phase derivation
// ---------------------------------------------------------------------------

const IMPORT_TITLE_PATTERN = /import|sync|gradle|maven|build\.ui|configure/i;
const ANALYZE_TITLE_PATTERN = /analy|index|validat|build/i;

export function classifyProgressTitle(title: string | null): "importing" | "analyzing" | null {
  if (!title) return null;
  if (IMPORT_TITLE_PATTERN.test(title)) return "importing";
  if (ANALYZE_TITLE_PATTERN.test(title)) return "analyzing";
  // Any provider-reported work means the analysis pipeline is busy even when
  // the title does not match a known bucket — never report ready underneath
  // live progress.
  return "analyzing";
}

function toProgressEntries(
  progress: ProjectAnalysisSnapshotInputs["progress"],
): ProjectAnalysisProgressEntry[] {
  return progress.map((entry) => ({
    token: String(entry.token),
    title: entry.title ?? "",
    percentage: entry.percentage ?? null,
  }));
}

/**
 * Pure state machine. Every transition is explainable from the inputs so the
 * UI can always answer WHY a semantic action is unavailable (DoD §8.20.3).
 */
export function deriveProjectAnalysisSnapshot(
  inputs: ProjectAnalysisSnapshotInputs,
): JavaProjectAnalysisSnapshotV1 {
  const now = inputs.now ?? Date.now();
  const diagnostics: string[] = [];
  const progressEntries = toProgressEntries(inputs.progress);

  const providerVersion = inputs.provider.serverVersion;
  const fingerprint = computeProjectFingerprint({
    roots: inputs.build.roots,
    buildFiles: inputs.build.buildFiles,
    sdk: inputs.build.sdk,
    providerId: inputs.provider.configured ? "jdtls" : null,
    providerVersion,
    classpathEntriesSha256: inputs.probe.kind === "ok" ? inputs.probe.entriesSha256 : null,
    moduleFingerprints: (inputs.modules ?? []).map((module) => module.dependencyFingerprint),
  });

  let phase: ProjectAnalysisPhase;
  if (!inputs.provider.configured) {
    phase = "unconfigured";
  } else if (!inputs.provider.active && !inputs.provider.opening && inputs.provider.lastError) {
    phase = "error";
    diagnostics.push(inputs.provider.lastError);
  } else if (inputs.provider.opening) {
    phase = "scanning";
  } else if (!inputs.provider.active) {
    phase = "offline";
  } else {
    const buckets = progressEntries
      .map((entry) => classifyProgressTitle(entry.title))
      .filter((bucket): bucket is "importing" | "analyzing" => bucket !== null);
    if (buckets.includes("importing")) {
      phase = "importing";
    } else if (buckets.length > 0) {
      phase = "analyzing";
    } else if (inputs.probe.kind === "ok") {
      phase = "ready";
    } else if (inputs.probe.kind === "failed") {
      phase = "degraded";
      diagnostics.push(`semantic-probe-failed: ${inputs.probe.reason ?? "unknown"}`);
    } else if (inputs.probe.kind === "unavailable") {
      phase = "degraded";
      diagnostics.push(`semantic-probe-unavailable: ${inputs.probe.reason ?? "unknown"}`);
    } else {
      // Active with settled progress but no probe result yet: readiness is
      // unproven until at least one semantic probe succeeds.
      phase = "analyzing";
    }
  }

  // Completeness: "complete" requires the provider to have handed over module
  // details (list + classpath fingerprint), not just lifecycle reports.
  let completeness: JavaProjectAnalysisSnapshotV1["completeness"];
  if (phase !== "ready" && phase !== "degraded") {
    completeness = "unknown";
  } else if (inputs.modules && inputs.modules.length > 0 && inputs.probe.kind === "ok") {
    completeness = "complete";
  } else if (inputs.modules && inputs.modules.length > 0) {
    completeness = "partial";
    diagnostics.push("module-list-present-without-classpath-probe");
  } else {
    completeness = "partial";
    diagnostics.push("lifecycle-only-provider-facts");
  }

  return {
    schemaVersion: 1,
    workspaceId: inputs.workspaceId,
    generation: inputs.generation,
    provider: {
      id: "jdtls",
      version: providerVersion,
      processId: inputs.provider.processId,
    },
    phase,
    projectFingerprint: fingerprint,
    sdk: inputs.build.sdk,
    modules: [...(inputs.modules ?? [])],
    progress: progressEntries,
    completeness,
    diagnostics,
    startedAt: inputs.provider.active || inputs.provider.opening ? now : null,
    completedAt: phase === "ready" || phase === "degraded" ? now : null,
  };
}

/**
 * Canonical project fingerprint. Inputs are hashed, never embedded verbatim:
 * absolute home paths must not appear plaintext anywhere in persisted or
 * displayed facts (§8.20.3).
 */
export function computeProjectFingerprint(inputs: {
  roots: readonly string[];
  buildFiles: readonly { path: string; sha256: string }[];
  sdk: ProjectSdkIdentity | null;
  providerId: string | null;
  providerVersion: string | null;
  classpathEntriesSha256: string | null;
  moduleFingerprints: readonly string[];
}): string {
  const canonical = [
    ["roots", [...inputs.roots].map((root) => root.trim()).filter(Boolean).sort().join("|")],
    ["build", [...inputs.buildFiles]
      .map((file) => `${file.path}:${file.sha256}`)
      .sort()
      .join("|")],
    ["sdk", inputs.sdk ? `${inputs.sdk.homeHash}:${inputs.sdk.version}:${inputs.sdk.languageLevel ?? "-"}` : "-"],
    ["provider", `${inputs.providerId ?? "-"}:${inputs.providerVersion ?? "-"}`],
    ["classpath", inputs.classpathEntriesSha256 ?? "-"],
    ["modules", [...inputs.moduleFingerprints].sort().join("|")],
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return sha256Hex(canonical);
}

/**
 * A snapshot goes stale when any identity dimension moved: roots changed,
 * a build file hash differs, JDK identity changed, or the LSP session was
 * restarted (generation bump). Stale snapshots must not gate semantic
 * readiness until a fresh probe succeeds.
 */
export function projectSnapshotStaleFor(
  snapshot: JavaProjectAnalysisSnapshotV1,
  candidate: {
    generation: number;
    roots: readonly string[];
    buildFiles: readonly { path: string; sha256: string }[];
    sdk: ProjectSdkIdentity | null;
    providerVersion: string | null;
    classpathEntriesSha256: string | null;
  },
): boolean {
  if (snapshot.generation !== candidate.generation) return true;
  const freshFingerprint = computeProjectFingerprint({
    roots: candidate.roots,
    buildFiles: candidate.buildFiles,
    sdk: candidate.sdk,
    providerId: snapshot.provider.id,
    providerVersion: candidate.providerVersion ?? snapshot.provider.version,
    classpathEntriesSha256: candidate.classpathEntriesSha256,
    moduleFingerprints: snapshot.modules.map((module) => module.dependencyFingerprint),
  });
  return freshFingerprint !== snapshot.projectFingerprint;
}

// ---------------------------------------------------------------------------
// Provider model → modules mapping (pure; unit-tested)
// ---------------------------------------------------------------------------

export interface ProviderModelModulesInput {
  javaProjects: readonly { id: string; rootUri: string | null }[];
  classpathProbe: { kind: string; rootUri: string | null; entriesSha256: string | null } | null;
  buildFiles: readonly { path: string }[];
}

function normalizePath(value: string): string {
  // Provider roots arrive as file:// URIs; build-file hashes as fs paths.
  // Normalize both to plain paths so prefix matching works across the mix.
  const stripped = value.startsWith("file://") ? decodeURIComponent(value.slice("file://".length)) : value;
  return stripped.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Build-system classification from LOCAL descriptor names at a module root —
 * a presentation-level label, not provider semantics; source/test roots stay
 * empty until a richer provider channel exists. */
function buildSystemForRoot(rootUri: string, buildFiles: ProviderModelModulesInput["buildFiles"]): JavaProjectModuleV1["buildSystem"] {
  const root = normalizePath(rootUri).toLowerCase();
  if (/\.gradle(\.kts)?$/.test(root)) return "gradle";
  if (buildFiles.some((file) => /\/pom\.xml$/i.test(normalizePath(file.path)) && normalizePath(file.path).startsWith(`${root}/`))) {
    return "maven";
  }
  if (buildFiles.some((file) => /\/build\.gradle(\.kts)?$/i.test(normalizePath(file.path)) && normalizePath(file.path).startsWith(`${root}/`))) {
    return "gradle";
  }
  return "plain";
}

export function modulesFromProviderModel(input: ProviderModelModulesInput): JavaProjectModuleV1[] {
  const probeOk = input.classpathProbe?.kind === "ok";
  const probeRoot = input.classpathProbe?.rootUri ? normalizePath(input.classpathProbe.rootUri) : null;
  return input.javaProjects.map((project) => {
    const root = project.rootUri ?? project.id;
    // The classpath probe binds to exactly one project; only that binding
    // earns a dependency fingerprint.
    const bound = probeOk
      && probeRoot !== null
      && (normalizePath(root) === probeRoot
        || normalizePath(root).endsWith(probeRoot)
        || probeRoot.endsWith(normalizePath(root)));
    const singleProjectFallback = probeOk
      && input.javaProjects.length === 1
      && !!input.classpathProbe?.entriesSha256;
    return {
      id: project.id || root,
      buildSystem: buildSystemForRoot(root, input.buildFiles),
      root,
      sourceRoots: [],
      testRoots: [],
      generatedRoots: [],
      excludedRoots: [],
      dependencyFingerprint: (bound || singleProjectFallback)
        ? input.classpathProbe?.entriesSha256 ?? ""
        : "",
    };
  });
}
