import type { WorkspaceProjectFactsEntry } from "../../../stores/projectFactsStore";
import { isPathExcluded, type ProjectStructureSnapshotV2 } from "./projectStructureModel";

export type FindInFilesScopeKind = "project" | "module" | "directory" | "recent" | "custom";

export interface FindInFilesScopeRequest {
  kind: FindInFilesScopeKind;
  workspaceRoot: string;
  targetDirectory?: string;
  moduleId?: string;
  recentFiles?: readonly string[];
  customPaths?: readonly string[];
  fileMask?: string;
  expectedGeneration?: number;
}

export type FindInFilesScopePlan =
  | {
      status: "ready";
      kind: FindInFilesScopeKind;
      roots: readonly string[];
      explicitFiles?: readonly string[];
      fileMask: string | null;
      generation?: number;
    }
  | {
      status: "unresolved";
      kind: FindInFilesScopeKind;
      reason: string;
      roots: readonly string[];
      fileMask: string | null;
      generation?: number;
      isStale?: boolean;
    };

/**
 * Parses comma or semicolon separated file mask patterns into individual globs.
 */
export function parseFileMask(mask?: string | null): string[] {
  if (!mask || !mask.trim()) {
    return [];
  }
  return mask
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tests whether a filename or path matches the given file mask pattern list.
 * Supports positive globs (e.g. `*.java`, `*.ts`) and negative exclusion globs (`!*.test.ts`).
 */
export function matchesFileMask(filePath: string, fileMask?: string | null): boolean {
  const masks = parseFileMask(fileMask);
  if (masks.length === 0) {
    return true;
  }

  const fileName = filePath.replace(/\\/g, "/").split("/").pop() || "";

  let positiveMatches = 0;
  let hasPositiveMasks = false;

  for (const mask of masks) {
    if (mask.startsWith("!")) {
      const negativeGlob = mask.slice(1).trim();
      if (testSimpleGlob(fileName, negativeGlob) || testSimpleGlob(filePath, negativeGlob)) {
        return false; // excluded
      }
    } else {
      hasPositiveMasks = true;
      if (testSimpleGlob(fileName, mask) || testSimpleGlob(filePath, mask)) {
        positiveMatches++;
      }
    }
  }

  if (hasPositiveMasks && positiveMatches === 0) {
    return false;
  }

  return true;
}

function testSimpleGlob(text: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*.*") return true;
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${escaped}$`, "i");
  return re.test(text);
}

/**
 * Computes Find in Files scope plan from request and project facts (ED-FIND-003).
 */
export function planFindInFilesScope(
  request: FindInFilesScopeRequest,
  factsEntry?: WorkspaceProjectFactsEntry | null,
): FindInFilesScopePlan {
  const fileMask = request.fileMask?.trim() || null;

  switch (request.kind) {
    case "project": {
      return {
        status: "ready",
        kind: "project",
        roots: [request.workspaceRoot],
        fileMask,
        generation: factsEntry?.generation,
      };
    }

    case "directory": {
      const dir = request.targetDirectory?.trim() || request.workspaceRoot;
      return {
        status: "ready",
        kind: "directory",
        roots: [dir],
        fileMask,
        generation: factsEntry?.generation,
      };
    }

    case "recent": {
      const recent = request.recentFiles ?? [];
      return {
        status: "ready",
        kind: "recent",
        roots: [],
        explicitFiles: recent,
        fileMask,
        generation: factsEntry?.generation,
      };
    }

    case "custom": {
      const custom = request.customPaths ?? [];
      return {
        status: "ready",
        kind: "custom",
        roots: custom.filter((p) => !p.includes(".")),
        explicitFiles: custom.filter((p) => p.includes(".")),
        fileMask,
        generation: factsEntry?.generation,
      };
    }

    case "module": {
      if (!factsEntry) {
        return {
          status: "unresolved",
          kind: "module",
          reason: "Project facts store not loaded for workspace",
          roots: [],
          fileMask,
        };
      }

      if (factsEntry.status === "untrusted") {
        return {
          status: "unresolved",
          kind: "module",
          reason: "Workspace is untrusted; module scope search refused",
          roots: [],
          fileMask,
          generation: factsEntry.generation,
        };
      }

      if (factsEntry.status === "loading") {
        return {
          status: "unresolved",
          kind: "module",
          reason: "Loading project facts; module scope temporarily unavailable",
          roots: [],
          fileMask,
          generation: factsEntry.generation,
        };
      }

      if (factsEntry.isStale) {
        return {
          status: "unresolved",
          kind: "module",
          reason: "Project structure is stale; re-evaluation required",
          roots: [],
          fileMask,
          generation: factsEntry.generation,
          isStale: true,
        };
      }

      if (
        request.expectedGeneration !== undefined &&
        factsEntry.generation !== request.expectedGeneration
      ) {
        return {
          status: "unresolved",
          kind: "module",
          reason: `Generation mismatch: expected G${request.expectedGeneration} but got G${factsEntry.generation}`,
          roots: [],
          fileMask,
          generation: factsEntry.generation,
          isStale: true,
        };
      }

      if (factsEntry.status !== "ready" || !factsEntry.structure) {
        return {
          status: "unresolved",
          kind: "module",
          reason: factsEntry.reason || "Project structure is not ready",
          roots: [],
          fileMask,
          generation: factsEntry.generation,
        };
      }

      const mod = factsEntry.structure.modules.find((m) => m.id === request.moduleId);
      if (!mod) {
        return {
          status: "unresolved",
          kind: "module",
          reason: `Module '${request.moduleId}' not found in project structure`,
          roots: [],
          fileMask,
          generation: factsEntry.generation,
        };
      }

      const moduleRoots = [mod.root, ...mod.sourceSets.flatMap((ss) => ss.roots)];
      return {
        status: "ready",
        kind: "module",
        roots: Array.from(new Set(moduleRoots)),
        fileMask,
        generation: factsEntry.generation,
      };
    }
  }
}

/**
 * Checks whether a file candidate matches the planned scope and file mask.
 */
export function isFileInScopePlan(
  filePath: string,
  plan: FindInFilesScopePlan,
  structure?: ProjectStructureSnapshotV2 | null,
): boolean {
  if (plan.status !== "ready") {
    return false;
  }

  // 1. Check excluded roots
  if (structure && isPathExcluded(structure, filePath)) {
    return false;
  }

  // 2. Check file mask
  if (!matchesFileMask(filePath, plan.fileMask)) {
    return false;
  }

  // 3. Check explicit files list
  if (plan.explicitFiles && plan.explicitFiles.length > 0) {
    const norm = filePath.replace(/\\/g, "/");
    return plan.explicitFiles.some((ef) => ef.replace(/\\/g, "/") === norm);
  }

  // 4. Check directory/module roots
  if (plan.roots.length > 0) {
    const norm = filePath.replace(/\\/g, "/");
    return plan.roots.some((r) => {
      const normRoot = r.replace(/\\/g, "/");
      return norm === normRoot || norm.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`);
    });
  }

  return true;
}
