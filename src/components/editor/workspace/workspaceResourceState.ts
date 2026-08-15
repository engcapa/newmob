import type { CodeWorkspaceFileRef } from "../../../types";
import type { TreeSelection } from "./codeWorkspaceModel";

export interface WorkspaceResourceUiTarget {
  rootId: string;
  path: string;
}

export type WorkspaceResourceUiChange =
  | { kind: "remove"; target: WorkspaceResourceUiTarget }
  | {
    kind: "move";
    source: WorkspaceResourceUiTarget;
    destination: WorkspaceResourceUiTarget;
  };

function pathUnder(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function movedPath(path: string, source: string, destination: string): string {
  if (path === source) return destination;
  return `${destination}/${path.slice(source.length + 1)}`;
}

function rootPathFromKey(key: string, rootId: string, prefix: "root:" | ""): string | null {
  const rootPrefix = `${prefix}${rootId}:`;
  return key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : null;
}

export function transformWorkspaceResourceFileRef(
  ref: CodeWorkspaceFileRef,
  change: WorkspaceResourceUiChange,
): CodeWorkspaceFileRef | null {
  if (ref.kind !== "root") return ref;
  if (change.kind === "remove") {
    return ref.rootId === change.target.rootId && pathUnder(ref.path, change.target.path)
      ? null
      : ref;
  }
  if (ref.rootId === change.source.rootId && pathUnder(ref.path, change.source.path)) {
    return {
      kind: "root",
      rootId: change.destination.rootId,
      path: movedPath(ref.path, change.source.path, change.destination.path),
    };
  }
  if (ref.rootId === change.destination.rootId && pathUnder(ref.path, change.destination.path)) {
    return null;
  }
  return ref;
}

export function transformWorkspaceResourceFileKey(
  key: string,
  change: WorkspaceResourceUiChange,
): string | null {
  if (change.kind === "remove") {
    const path = rootPathFromKey(key, change.target.rootId, "root:");
    return path !== null && pathUnder(path, change.target.path) ? null : key;
  }
  const sourcePath = rootPathFromKey(key, change.source.rootId, "root:");
  if (sourcePath !== null && pathUnder(sourcePath, change.source.path)) {
    const path = movedPath(sourcePath, change.source.path, change.destination.path);
    return `root:${change.destination.rootId}:${path}`;
  }
  const destinationPath = rootPathFromKey(key, change.destination.rootId, "root:");
  if (destinationPath !== null && pathUnder(destinationPath, change.destination.path)) return null;
  return key;
}

export function transformWorkspaceResourceExpandedDirKeys(
  keys: ReadonlySet<string>,
  change: WorkspaceResourceUiChange,
): Set<string> {
  const next = new Set<string>();
  for (const key of keys) {
    if (change.kind === "remove") {
      const path = rootPathFromKey(key, change.target.rootId, "");
      if (path !== null && pathUnder(path, change.target.path)) continue;
      next.add(key);
      continue;
    }
    const sourcePath = rootPathFromKey(key, change.source.rootId, "");
    if (sourcePath !== null && pathUnder(sourcePath, change.source.path)) {
      const path = movedPath(sourcePath, change.source.path, change.destination.path);
      next.add(`${change.destination.rootId}:${path}`);
      continue;
    }
    const destinationPath = rootPathFromKey(key, change.destination.rootId, "");
    if (destinationPath !== null && pathUnder(destinationPath, change.destination.path)) continue;
    next.add(key);
  }
  return next;
}

export function transformWorkspaceResourceTreeSelection(
  selection: TreeSelection | null,
  change: WorkspaceResourceUiChange,
): TreeSelection | null {
  if (!selection || selection.kind === "root") return selection;
  if (selection.kind === "file") {
    const ref = transformWorkspaceResourceFileRef(selection.ref, change);
    return ref ? { kind: "file", ref } : null;
  }
  const ref = transformWorkspaceResourceFileRef({
    kind: "root",
    rootId: selection.rootId,
    path: selection.path,
  }, change);
  return ref?.kind === "root"
    ? { kind: "dir", rootId: ref.rootId, path: ref.path }
    : null;
}
