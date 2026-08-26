import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LspDocumentDescriptor } from "../../../lib/editor/lsp";
import {
  lspJavaProjectModel,
  type LspJavaProjectModelResult,
} from "../../../lib/editor/lsp";
import { sdkResolveWorkspace } from "../../../lib/editor/sdk";
import {
  deriveProjectAnalysisSnapshot,
  modulesFromProviderModel,
  sha256Hex,
  type JavaProjectAnalysisSnapshotV1,
  type ProjectClasspathProbe,
  type ProjectSdkIdentity,
} from "./projectAnalysisModel";

/**
 * §8.20.3 W2: assembles the provider-owned Project Analysis snapshot for one
 * workspace instance. Lifecycle facts come from the LSP session statuses and
 * work-done progress the shell already tracks; module/classpath/build-file
 * facts come from `lsp_java_project_model` (gated by what jdtls actually
 * registered). Nothing here guesses readiness — an unprobed provider stays
 * "analyzing", a lifecycle-only provider degrades.
 */

export interface WorkspaceProviderFactsInput {
  configured: boolean;
  active: boolean;
  opening: boolean;
  lastError: string | null;
}

export interface UseWorkspaceProjectAnalysisOptions {
  workspaceInstanceId: string;
  roots: readonly string[];
  provider: WorkspaceProviderFactsInput;
  progresses: ReadonlyArray<{
    token: string | number;
    title: string | null;
    percentage?: number | null;
  }>;
  sessionGeneration: number;
  /** Descriptor builder used to address the java session over IPC. */
  descriptorForRoot: (root: string) => LspDocumentDescriptor;
}

export interface WorkspaceProjectAnalysisController {
  snapshot: JavaProjectAnalysisSnapshotV1 | null;
  modelResult: LspJavaProjectModelResult | null;
  probing: boolean;
  refresh: () => void;
}

interface ProbeCacheEntry {
  generation: number;
  rootsKey: string;
  result: LspJavaProjectModelResult;
  at: number;
}

function rootsKey(roots: readonly string[]): string {
  return [...roots].map((root) => root.trim()).sort().join("|");
}

async function resolveSdkIdentity(root: string): Promise<ProjectSdkIdentity | null> {
  try {
    const resolution = await sdkResolveWorkspace(root);
    const java = resolution.resolved.find((entry) => (
      entry.kind === "java"
      && (entry.status === "resolved" || entry.status === "managed")
      && entry.installation
    ));
    const home = java?.installation
      ? ("path" in java.installation && typeof java.installation.path === "string"
        ? java.installation.path
        : ("location" in java.installation && typeof java.installation.location === "string"
          ? java.installation.location
          : null))
      : null;
    const version = java?.installation
      ? (("version" in java.installation) && typeof java.installation.version === "string"
        ? java.installation.version
        : null)
      : null;
    if (!home || !version) return null;
    // Hash the home — fingerprints must never carry machine-local plaintext.
    return { homeHash: sha256Hex(home), version, languageLevel: null };
  } catch {
    return null;
  }
}

export function useWorkspaceProjectAnalysis({
  workspaceInstanceId,
  roots,
  provider,
  progresses,
  sessionGeneration,
  descriptorForRoot,
}: UseWorkspaceProjectAnalysisOptions): WorkspaceProjectAnalysisController {
  const [modelResult, setModelResult] = useState<LspJavaProjectModelResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [sdkIdentity, setSdkIdentity] = useState<ProjectSdkIdentity | null>(null);
  const probeCacheRef = useRef<ProbeCacheEntry | null>(null);
  const inflightRef = useRef(false);
  const descriptorForRootRef = useRef(descriptorForRoot);
  descriptorForRootRef.current = descriptorForRoot;

  const trimmedRoots = useMemo(
    () => roots.map((root) => root.trim()).filter(Boolean),
    [roots],
  );
  const key = rootsKey(trimmedRoots);

  // JDK identity per root set (best effort; absence keeps sdk=null honest).
  useEffect(() => {
    let cancelled = false;
    if (!trimmedRoots.length) {
      setSdkIdentity(null);
      return;
    }
    void resolveSdkIdentity(trimmedRoots[0]!).then((identity) => {
      if (!cancelled) setSdkIdentity(identity);
    });
    return () => {
      cancelled = true;
    };
  }, [key, trimmedRoots]);

  const runProbe = useCallback(() => {
    if (inflightRef.current || !trimmedRoots.length || !provider.active) return;
    inflightRef.current = true;
    setProbing(true);
    void lspJavaProjectModel(descriptorForRootRef.current(trimmedRoots[0]!))
      .then((result) => {
        probeCacheRef.current = {
          generation: sessionGeneration,
          rootsKey: key,
          result,
          at: Date.now(),
        };
        setModelResult(result);
      })
      .catch((error) => {
        // IPC failure is itself a fact; surface it through probe_reason.
        probeCacheRef.current = {
          generation: sessionGeneration,
          rootsKey: key,
          result: {
            status: {
              path: "", uri: "", presetId: null, languageId: null,
              displayName: null, available: false, active: false,
              selectedCommandId: null, selectedCommand: null,
              installHint: null, error: null, capabilities: null,
            },
            active: false,
            processId: null,
            serverName: null,
            serverVersion: null,
            registeredCommands: [],
            buildFiles: [],
            javaHomeUsed: null,
            javaProjects: [],
            classpathProbe: null,
            probeReason: error instanceof Error ? error.message : String(error),
          },
          at: Date.now(),
        };
        setModelResult(probeCacheRef.current.result);
      })
      .finally(() => {
        inflightRef.current = false;
        setProbing(false);
      });
  }, [key, provider.active, sessionGeneration, trimmedRoots]);

  // Probe whenever the live session has no cached model for this generation +
  // root identity (restart bumps generation → fresh probe).
  useEffect(() => {
    if (!provider.active || !trimmedRoots.length) return;
    const cache = probeCacheRef.current;
    if (cache && cache.generation === sessionGeneration && cache.rootsKey === key) return;
    runProbe();
  }, [key, provider.active, runProbe, sessionGeneration, trimmedRoots]);

  const refresh = useCallback(() => {
    probeCacheRef.current = null;
    setModelResult(null);
    runProbe();
  }, [runProbe]);

  const snapshot = useMemo(() => {
    if (!trimmedRoots.length) return null;
    const cache = probeCacheRef.current;
    const cacheUsable = !!cache
      && cache.generation === sessionGeneration
      && cache.rootsKey === key;
    const facts = cacheUsable ? cache!.result : null;
    const probe: ProjectClasspathProbe = {
      kind: facts
        ? facts.classpathProbe
          ? "ok"
          : "unavailable"
        : "not-run",
      reason: facts?.classpathProbe
        ? null
        : facts?.probeReason ?? null,
      rootUri: facts?.classpathProbe?.rootUri ?? null,
      entryCount: facts?.classpathProbe?.entryCount ?? null,
      entriesSha256: facts?.classpathProbe?.entriesSha256 ?? null,
      completedAt: cacheUsable ? cache!.at : null,
    };
    const modules = facts
      ? modulesFromProviderModel({
        javaProjects: facts.javaProjects,
        classpathProbe: probe.kind === "ok" && probe.entriesSha256
          ? { kind: "ok", rootUri: probe.rootUri, entriesSha256: probe.entriesSha256 }
          : null,
        buildFiles: facts.buildFiles,
      })
      : [];
    return deriveProjectAnalysisSnapshot({
      workspaceId: workspaceInstanceId,
      generation: sessionGeneration,
      provider: {
        configured: provider.configured,
        active: provider.active,
        opening: provider.opening,
        lastError: provider.lastError,
        processId: facts?.processId ?? null,
        serverName: facts?.serverName ?? null,
        serverVersion: facts?.serverVersion ?? null,
        registeredCommands: facts?.registeredCommands ?? [],
      },
      progress: progresses,
      probe,
      modules: facts ? modules : null,
      build: {
        roots: trimmedRoots,
        buildFiles: facts?.buildFiles ?? [],
        sdk: sdkIdentity,
      },
    });
  }, [
    key,
    progresses,
    provider.active,
    provider.configured,
    provider.lastError,
    provider.opening,
    sdkIdentity,
    sessionGeneration,
    trimmedRoots,
    workspaceInstanceId,
  ]);

  return { snapshot, modelResult, probing, refresh };
}
