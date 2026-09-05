import { create } from "zustand";
import {
  workspaceIngestMavenProject,
  workspaceIngestGradleProject,
  type MavenToolingProvenance,
  type GradleToolingProvenance,
} from "../lib/editor/workspaceTooling";
import {
  buildProjectStructureSnapshotV2,
  type ProjectStructureSnapshotV2,
} from "../components/editor/workspace/projectStructureModel";
import type { JavaProjectModuleV1 } from "../components/editor/workspace/projectAnalysisModel";

export type ProjectFactsStatus = "idle" | "loading" | "ready" | "degraded" | "untrusted" | "failed";

export interface WorkspaceProjectFactsEntry {
  workspaceRoot: string;
  generation: number;
  status: ProjectFactsStatus;
  reason: string | null;
  fingerprint: string | null;
  structure: ProjectStructureSnapshotV2 | null;
  provenance: MavenToolingProvenance | GradleToolingProvenance | null;
  isStale: boolean;
  abortController?: AbortController | null;
}

export interface FetchProjectFactsOptions {
  trusted: boolean;
  javaHome?: string | null;
  mavenExecutable?: string | null;
  gradleExecutable?: string | null;
  offline?: boolean;
  toolKind?: "maven" | "gradle" | "auto";
}

interface ProjectFactsState {
  workspaces: Record<string, WorkspaceProjectFactsEntry>;
  getWorkspaceFacts: (workspaceRoot: string) => WorkspaceProjectFactsEntry;
  invalidate: (workspaceRoot: string, reason?: string) => void;
  fetchProjectFacts: (workspaceRoot: string, options: FetchProjectFactsOptions) => Promise<WorkspaceProjectFactsEntry>;
  resetWorkspace: (workspaceRoot: string) => void;
}

interface ToolingResultShape<Module, Provenance> {
  status: string;
  modules: Module[];
  provenance: Provenance | null;
  errorMessage: string | null;
}

/**
 * ED-PROJECT-005 A4: a missing or malformed tooling response (for example the
 * browser stub preview, which has no build backend) must surface as a typed
 * prerequisite failure naming what is missing — never as a raw TypeError
 * from dereferencing the response.
 */
const KNOWN_TOOLING_STATUSES = ["ready", "untrusted", "degraded", "failed"] as const;
type KnownToolingStatus = (typeof KNOWN_TOOLING_STATUSES)[number];

function normalizeToolingResult<Module, Provenance>(
  res: ToolingResultShape<Module, Provenance> | null | undefined,
  toolLabel: string,
): { status: KnownToolingStatus; modules: Module[]; provenance: Provenance | null; errorMessage: string | null } {
  if (
    res &&
    (KNOWN_TOOLING_STATUSES as readonly string[]).includes(res.status) &&
    Array.isArray(res.modules)
  ) {
    return {
      status: res.status as KnownToolingStatus,
      modules: res.modules,
      provenance: res.provenance,
      errorMessage: res.errorMessage,
    };
  }
  return {
    status: "failed",
    modules: [],
    provenance: null,
    errorMessage: `${toolLabel} tooling returned no usable result; ready project facts require a build backend`,
  };
}

const defaultEntry = (workspaceRoot: string): WorkspaceProjectFactsEntry => ({
  workspaceRoot,
  generation: 0,
  status: "idle",
  reason: null,
  fingerprint: null,
  structure: null,
  provenance: null,
  isStale: false,
  abortController: null,
});

export const useProjectFactsStore = create<ProjectFactsState>((set, get) => ({
  workspaces: {},

  getWorkspaceFacts: (workspaceRoot: string) => {
    return get().workspaces[workspaceRoot] ?? defaultEntry(workspaceRoot);
  },

  invalidate: (workspaceRoot: string, reason = "Project configuration modified") => {
    const current = get().getWorkspaceFacts(workspaceRoot);
    if (current.abortController) {
      current.abortController.abort();
    }
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceRoot]: {
          ...current,
          isStale: true,
          reason,
          abortController: null,
        },
      },
    }));
  },

  resetWorkspace: (workspaceRoot: string) => {
    const current = get().workspaces[workspaceRoot];
    if (current?.abortController) {
      current.abortController.abort();
    }
    set((state) => {
      const next = { ...state.workspaces };
      delete next[workspaceRoot];
      return { workspaces: next };
    });
  },

  fetchProjectFacts: async (workspaceRoot: string, options: FetchProjectFactsOptions) => {
    const prev = get().getWorkspaceFacts(workspaceRoot);
    if (prev.abortController) {
      prev.abortController.abort();
    }

    const nextGeneration = prev.generation + 1;
    const abortController = new AbortController();

    // 1. Trust boundary check
    if (!options.trusted) {
      const untrustedEntry: WorkspaceProjectFactsEntry = {
        workspaceRoot,
        generation: nextGeneration,
        status: "untrusted",
        reason: "Workspace is untrusted; build tooling ingestion refused (process=0)",
        fingerprint: null,
        structure: null,
        provenance: null,
        isStale: false,
        abortController: null,
      };
      set((state) => ({
        workspaces: { ...state.workspaces, [workspaceRoot]: untrustedEntry },
      }));
      return untrustedEntry;
    }

    // Set loading state
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceRoot]: {
          ...prev,
          generation: nextGeneration,
          status: "loading",
          reason: "Loading project build facts...",
          abortController,
        },
      },
    }));

    try {
      let resultStatus: ProjectFactsStatus = "ready";
      let errorMessage: string | null = null;
      let provenance: MavenToolingProvenance | GradleToolingProvenance | null = null;      let rawModules: Array<{
        id: string;
        name: string;
        root: string;
        sourceRoots: string[];
        testRoots: string[];
        resourceRoots: string[];
        dependencies: string[];
        classpath: string[];
      }> = [];

      // Determine tool kind
      const tool = options.toolKind ?? "auto";

      if (tool === "gradle") {
        const gradleRes = normalizeToolingResult(await workspaceIngestGradleProject({
          workspaceRoot,
          trusted: options.trusted,
          javaHome: options.javaHome,
          gradleExecutable: options.gradleExecutable,
          offline: options.offline,
        }), "Gradle");

        if (abortController.signal.aborted) {
          return get().getWorkspaceFacts(workspaceRoot);
        }

        if (gradleRes.status !== "ready") {
          resultStatus = gradleRes.status;
          errorMessage = gradleRes.errorMessage;
        } else {
          rawModules = gradleRes.modules;
          provenance = gradleRes.provenance;
        }
      } else if (tool === "maven") {
        const mavenRes = normalizeToolingResult(await workspaceIngestMavenProject({
          workspaceRoot,
          trusted: options.trusted,
          javaHome: options.javaHome,
          mavenExecutable: options.mavenExecutable,
          offline: options.offline,
        }), "Maven");

        if (abortController.signal.aborted) {
          return get().getWorkspaceFacts(workspaceRoot);
        }

        if (mavenRes.status !== "ready") {
          resultStatus = mavenRes.status;
          errorMessage = mavenRes.errorMessage;
        } else {
          rawModules = mavenRes.modules;
          provenance = mavenRes.provenance;
        }
      } else {
        // Auto detection: try Maven first, if not found or failed, try Gradle
        const mavenRes = normalizeToolingResult(await workspaceIngestMavenProject({
          workspaceRoot,
          trusted: options.trusted,
          javaHome: options.javaHome,
          mavenExecutable: options.mavenExecutable,
          offline: options.offline,
        }), "Maven");

        if (abortController.signal.aborted) {
          return get().getWorkspaceFacts(workspaceRoot);
        }

        if (mavenRes.status === "ready") {
          rawModules = mavenRes.modules;
          provenance = mavenRes.provenance;
        } else {
          // Try Gradle
          const gradleRes = normalizeToolingResult(await workspaceIngestGradleProject({
            workspaceRoot,
            trusted: options.trusted,
            javaHome: options.javaHome,
            gradleExecutable: options.gradleExecutable,
            offline: options.offline,
          }), "Gradle");

          if (abortController.signal.aborted) {
            return get().getWorkspaceFacts(workspaceRoot);
          }

          if (gradleRes.status === "ready") {
            rawModules = gradleRes.modules;
            provenance = gradleRes.provenance;
          } else {
            resultStatus = "failed";
            errorMessage = mavenRes.errorMessage || gradleRes.errorMessage || "No build tooling detected";
          }
        }
      }

      if (resultStatus !== "ready") {
        const failedEntry: WorkspaceProjectFactsEntry = {
          workspaceRoot,
          generation: nextGeneration,
          status: resultStatus,
          reason: errorMessage,
          fingerprint: null,
          structure: null,
          provenance,
          isStale: false,
          abortController: null,
        };
        set((state) => ({
          workspaces: { ...state.workspaces, [workspaceRoot]: failedEntry },
        }));
        return failedEntry;
      }

      // Convert raw modules to ProjectStructureSnapshotV2
      const dependenciesByModule: Record<string, string[]> = {};
      const classpathFingerprintsByModule: Record<string, string> = {};
      const buildSystem: JavaProjectModuleV1["buildSystem"] =
        tool === "gradle" || provenance?.toolKind?.startsWith("gradle") ? "gradle" : "maven";
      const convertedModules: JavaProjectModuleV1[] = rawModules.map((m): JavaProjectModuleV1 => {
        dependenciesByModule[m.id] = m.dependencies;
        classpathFingerprintsByModule[m.id] = m.classpath.join(";");
        return {
          id: m.id,
          buildSystem,
          root: m.root,
          sourceRoots: m.sourceRoots,
          testRoots: m.testRoots,
          generatedRoots: [],
          excludedRoots: [],
          dependencyFingerprint: m.classpath.join(";"),
        };
      });

      const structure = buildProjectStructureSnapshotV2({
        generation: nextGeneration,
        modules: convertedModules,
        dependenciesByModule,
        classpathFingerprintsByModule,
        source: provenance?.toolKind?.startsWith("gradle") ? "gradle-model" : "maven-model",
      });

      const fingerprint = provenance
        ? `${provenance.toolKind}:${(provenance as any).pomHash || (provenance as any).settingsHash || ""}:${provenance.javaHome || ""}`
        : null;

      const readyEntry: WorkspaceProjectFactsEntry = {
        workspaceRoot,
        generation: nextGeneration,
        status: "ready",
        reason: null,
        fingerprint,
        structure,
        provenance,
        isStale: false,
        abortController: null,
      };

      set((state) => ({
        workspaces: { ...state.workspaces, [workspaceRoot]: readyEntry },
      }));

      return readyEntry;
    } catch (err: any) {
      if (abortController.signal.aborted) {
        return get().getWorkspaceFacts(workspaceRoot);
      }
      const errorEntry: WorkspaceProjectFactsEntry = {
        workspaceRoot,
        generation: nextGeneration,
        status: "failed",
        reason: err?.message || String(err),
        fingerprint: null,
        structure: null,
        provenance: null,
        isStale: false,
        abortController: null,
      };
      set((state) => ({
        workspaces: { ...state.workspaces, [workspaceRoot]: errorEntry },
      }));
      return errorEntry;
    }
  },
}));
