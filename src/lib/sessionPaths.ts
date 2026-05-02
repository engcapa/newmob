export const SESSION_ROOT_LABEL = "User sessions";

export interface PathGroup {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface PathSession {
  group_path: string | null;
}

export function splitGroupPath(path: string | null | undefined): string[] {
  if (!path) return [];
  if (typeof path !== "string") return [];

  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts[0]?.toLowerCase() === SESSION_ROOT_LABEL.toLowerCase()) {
    parts.shift();
  }

  return parts;
}

export function normalizeGroupPath(path: string | null | undefined): string | null {
  const parts = splitGroupPath(path);
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function toStoredGroupPath(path: string | null | undefined): string | null {
  const normalized = normalizeGroupPath(path);
  return normalized ? `${SESSION_ROOT_LABEL} / ${normalized}` : null;
}

export function parentGroupPath(path: string | null | undefined): string | null {
  const parts = splitGroupPath(path);
  parts.pop();
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function leafGroupName(path: string | null | undefined): string {
  const parts = splitGroupPath(path);
  return parts[parts.length - 1] ?? SESSION_ROOT_LABEL;
}

export function groupPathContains(parent: string | null | undefined, child: string | null | undefined): boolean {
  const parentPath = normalizeGroupPath(parent);
  const childPath = normalizeGroupPath(child);

  if (!parentPath) return true;
  return childPath === parentPath || !!childPath?.startsWith(`${parentPath} / `);
}

export function replaceGroupPathPrefix(
  path: string | null | undefined,
  oldPrefix: string,
  newPrefix: string | null | undefined,
): string | null {
  const normalizedPath = normalizeGroupPath(path);
  const normalizedOld = normalizeGroupPath(oldPrefix);
  const normalizedNew = normalizeGroupPath(newPrefix);

  if (!normalizedPath || !normalizedOld || !groupPathContains(normalizedOld, normalizedPath)) {
    return normalizedPath;
  }

  const suffix = normalizedPath === normalizedOld
    ? ""
    : normalizedPath.slice(normalizedOld.length + 3);

  if (!normalizedNew) return suffix || null;
  return suffix ? `${normalizedNew} / ${suffix}` : normalizedNew;
}

export function ancestorGroupPaths(path: string | null | undefined): string[] {
  const parts = splitGroupPath(path);
  return parts.map((_, index) => parts.slice(0, index + 1).join(" / "));
}

export function groupPathDepth(path: string | null | undefined): number {
  return splitGroupPath(path).length;
}

export function resolveGroupPaths(groups: PathGroup[]): Array<{ group: PathGroup; path: string }> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const cache = new Map<string, string | null>();

  const resolve = (group: PathGroup, seen = new Set<string>()): string | null => {
    if (cache.has(group.id)) return cache.get(group.id) ?? null;
    if (seen.has(group.id)) return normalizeGroupPath(group.name);
    seen.add(group.id);

    let path: string | null = null;
    const idPath = normalizeGroupPath(group.id);

    if (idPath && (group.id.includes("/") || group.id.includes("\\") || group.id.startsWith(SESSION_ROOT_LABEL))) {
      path = idPath;
    } else if (group.parent_id && byId.has(group.parent_id)) {
      const parentPath = resolve(byId.get(group.parent_id)!, seen);
      const namePath = normalizeGroupPath(group.name);
      path = parentPath && namePath ? `${parentPath} / ${namePath}` : namePath;
    } else {
      path = normalizeGroupPath(group.name);
    }

    cache.set(group.id, path);
    return path;
  };

  return groups
    .map((group) => {
      const path = resolve(group);
      return path ? { group, path } : null;
    })
    .filter((item): item is { group: PathGroup; path: string } => item !== null);
}

export function collectFolderPaths(
  sessions: PathSession[],
  groups: PathGroup[] = [],
): string[] {
  const paths = new Set<string>();

  for (const session of sessions) {
    for (const path of ancestorGroupPaths(session.group_path)) {
      paths.add(path);
    }
  }

  for (const { path } of resolveGroupPaths(groups)) {
    for (const ancestor of ancestorGroupPaths(path)) {
      paths.add(ancestor);
    }
  }

  return [...paths].sort((a, b) => {
    const depth = groupPathDepth(a) - groupPathDepth(b);
    return depth || a.localeCompare(b);
  });
}

export function folderOptionLabel(path: string | null | undefined): string {
  const normalized = normalizeGroupPath(path);
  return normalized ? `${SESSION_ROOT_LABEL} / ${normalized}` : SESSION_ROOT_LABEL;
}
