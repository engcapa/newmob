export type WorkspaceTodoKind = "TODO" | "FIXME" | "XXX" | "HACK";

export interface WorkspaceTodoItem {
  key: string;
  fileKey: string;
  pathLabel: string;
  kind: WorkspaceTodoKind;
  line: number;
  character: number;
  text: string;
}

export interface WorkspaceTodoFile {
  key: string;
  pathLabel: string;
  text: string;
}

const BOOKMARKS_PREFIX = "taomni.codeWorkspace.bookmarks.v1.";
const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b(?:[:\s-]+(.*))?$/i;

export function scanTodosInText(
  fileKey: string,
  pathLabel: string,
  text: string,
): WorkspaceTodoItem[] {
  const lines = text.split("\n");
  const items: WorkspaceTodoItem[] = [];
  lines.forEach((lineText, index) => {
    const match = lineText.match(TODO_PATTERN);
    if (!match) return;
    const kind = match[1].toUpperCase() as WorkspaceTodoKind;
    const detail = (match[2] ?? "").trim();
    const character = Math.max(0, lineText.toUpperCase().indexOf(kind));
    items.push({
      key: `${fileKey}:${index}:${kind}`,
      fileKey,
      pathLabel,
      kind,
      line: index,
      character,
      text: detail || lineText.trim(),
    });
  });
  return items;
}

export function scanTodosInOpenFiles(
  files: WorkspaceTodoFile[],
): WorkspaceTodoItem[] {
  return files
    .flatMap((file) => scanTodosInText(file.key, file.pathLabel, file.text))
    .sort((left, right) => left.pathLabel.localeCompare(right.pathLabel)
      || left.line - right.line
      || left.character - right.character);
}

/**
 * Incremental cache for open-file TODOs.  Open editor state preserves the
 * object/text of untouched files, so one edit only needs to rescan its own
 * buffer rather than all open tabs.
 */
export interface OpenFileTodoScanner {
  scan: (files: WorkspaceTodoFile[]) => WorkspaceTodoItem[];
}

export function createOpenFileTodoScanner(): OpenFileTodoScanner {
  let cachedByFile = new Map<string, {
    pathLabel: string;
    text: string;
    items: WorkspaceTodoItem[];
  }>();

  return {
    scan(files) {
      const nextCache = new Map<string, {
        pathLabel: string;
        text: string;
        items: WorkspaceTodoItem[];
      }>();
      const items: WorkspaceTodoItem[] = [];
      for (const file of files) {
        const cached = cachedByFile.get(file.key);
        const fileItems = cached && cached.pathLabel === file.pathLabel && cached.text === file.text
          ? cached.items
          : scanTodosInText(file.key, file.pathLabel, file.text);
        nextCache.set(file.key, {
          pathLabel: file.pathLabel,
          text: file.text,
          items: fileItems,
        });
        items.push(...fileItems);
      }
      cachedByFile = nextCache;
      return items.sort((left, right) => left.pathLabel.localeCompare(right.pathLabel)
        || left.line - right.line
        || left.character - right.character);
    },
  };
}

export function sameWorkspaceTodoItems(
  left: WorkspaceTodoItem[],
  right: WorkspaceTodoItem[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.key === other?.key
      && item.pathLabel === other.pathLabel
      && item.kind === other.kind
      && item.line === other.line
      && item.character === other.character
      && item.text === other.text;
  });
}

export interface WorkspaceBookmark {
  id: string;
  fileKey: string;
  pathLabel: string;
  line: number;
  character: number;
  label: string;
  mnemonic?: string | null;
  group?: string | null;
  /** A deleted resource keeps its identity so the panel can explain the gap. */
  state?: "current" | "missing";
  createdAt: number;
}

export function isValidMnemonic(char: string): boolean {
  return /^[0-9a-zA-Z]$/.test(char);
}

export function normalizeMnemonic(char: string): string {
  return char.toUpperCase();
}

export function workspaceBookmarkGroupName(bookmark: WorkspaceBookmark): string {
  const group = bookmark.group?.trim();
  return group || (bookmark.mnemonic ? "Mnemonic Bookmarks" : "General Bookmarks");
}

function bookmarksKey(workspaceInstanceId: string): string {
  return `${BOOKMARKS_PREFIX}${workspaceInstanceId}`;
}

export function readWorkspaceBookmarks(workspaceInstanceId: string): WorkspaceBookmark[] {
  if (!workspaceInstanceId || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(bookmarksKey(workspaceInstanceId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is WorkspaceBookmark => (
        !!item
        && typeof item === "object"
        && typeof item.id === "string"
        && typeof item.fileKey === "string"
        && typeof item.pathLabel === "string"
        && Number.isInteger(item.line)
        && item.line >= 0
        && Number.isInteger(item.character)
        && item.character >= 0
        && typeof item.label === "string"
        && typeof item.createdAt === "number"
      ))
      .map((item) => ({
        ...item,
        mnemonic: typeof item.mnemonic === "string" ? item.mnemonic : null,
        group: typeof item.group === "string" ? item.group : null,
        state: item.state === "missing" ? "missing" as const : "current" as const,
      }))
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function writeWorkspaceBookmarks(
  workspaceInstanceId: string,
  bookmarks: WorkspaceBookmark[],
): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(bookmarksKey(workspaceInstanceId), JSON.stringify(bookmarks.slice(0, 200)));
  } catch {
    // ignore storage failures
  }
}

export function toggleWorkspaceBookmark(
  workspaceInstanceId: string,
  candidate: Omit<WorkspaceBookmark, "id" | "createdAt">,
  current: WorkspaceBookmark[] = readWorkspaceBookmarks(workspaceInstanceId),
): WorkspaceBookmark[] {
  const existing = current.find((item) => (
    item.fileKey === candidate.fileKey && item.line === candidate.line
  ));
  const next = existing
    ? current.filter((item) => item.id !== existing.id)
    : [
        {
          id: `${candidate.fileKey}:${candidate.line}:${Date.now()}`,
          createdAt: Date.now(),
          mnemonic: candidate.mnemonic ?? null,
          group: candidate.group ?? (candidate.mnemonic ? "Mnemonic" : "General"),
          ...candidate,
          state: candidate.state ?? "current",
        },
        ...current,
      ].slice(0, 200);
  writeWorkspaceBookmarks(workspaceInstanceId, next);
  return next;
}

export function setMnemonicBookmark(
  workspaceInstanceId: string,
  candidate: Omit<WorkspaceBookmark, "id" | "createdAt"> & { mnemonic: string },
  current: WorkspaceBookmark[] = readWorkspaceBookmarks(workspaceInstanceId),
): WorkspaceBookmark[] {
  const mnemonic = normalizeMnemonic(candidate.mnemonic);
  if (!isValidMnemonic(mnemonic)) return current;

  // 1. If exact line already has this mnemonic, toggle it off
  const sameLineExisting = current.find(
    (item) => item.fileKey === candidate.fileKey && item.line === candidate.line,
  );
  if (sameLineExisting && sameLineExisting.mnemonic === mnemonic) {
    const next = current.filter((item) => item.id !== sameLineExisting.id);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    return next;
  }

  // 2. Remove mnemonic collision from any other bookmark (conflict replacement)
  const deduped = current
    .filter((item) => item.id !== sameLineExisting?.id)
    .map((item) => (item.mnemonic === mnemonic ? { ...item, mnemonic: null } : item));

  const next: WorkspaceBookmark[] = [
    {
      id: `${candidate.fileKey}:${candidate.line}:${Date.now()}`,
      createdAt: Date.now(),
      ...candidate,
      mnemonic,
      group: candidate.group ?? "Mnemonic",
      state: candidate.state ?? "current",
    },
    ...deduped,
  ].slice(0, 200);

  writeWorkspaceBookmarks(workspaceInstanceId, next);
  return next;
}

export function findBookmarkByMnemonic(
  bookmarks: readonly WorkspaceBookmark[],
  mnemonic: string,
): WorkspaceBookmark | null {
  const target = normalizeMnemonic(mnemonic);
  return bookmarks.find((item) => item.mnemonic === target) ?? null;
}

export function updateBookmarksOnPathRename(
  bookmarks: readonly WorkspaceBookmark[],
  oldFileKey: string,
  newFileKey: string,
  newPathLabel: string,
): WorkspaceBookmark[] {
  return bookmarks.map((item) => {
    if (item.fileKey === oldFileKey) {
      return {
        ...item,
        fileKey: newFileKey,
        pathLabel: newPathLabel,
        state: "current",
      };
    }
    return item;
  });
}

export function removeBookmarksForFile(
  bookmarks: readonly WorkspaceBookmark[],
  fileKey: string,
): WorkspaceBookmark[] {
  return bookmarks.filter((item) => item.fileKey !== fileKey);
}

export function renameWorkspaceBookmarkGroup(
  workspaceInstanceId: string,
  oldGroupName: string,
  newGroupName: string,
  current: WorkspaceBookmark[] = readWorkspaceBookmarks(workspaceInstanceId),
): WorkspaceBookmark[] {
  const oldName = oldGroupName.trim();
  const nextName = newGroupName.trim();
  if (!oldName || !nextName || oldName === nextName) return current;
  let changed = false;
  const next = current.map((bookmark) => {
    if (workspaceBookmarkGroupName(bookmark) !== oldName) return bookmark;
    changed = true;
    return { ...bookmark, group: nextName };
  });
  if (changed) writeWorkspaceBookmarks(workspaceInstanceId, next);
  return changed ? next : current;
}

export function markWorkspaceBookmarksMissingForFile(
  bookmarks: readonly WorkspaceBookmark[],
  fileKey: string,
): WorkspaceBookmark[] {
  let changed = false;
  const next = bookmarks.map((bookmark) => {
    if (bookmark.fileKey !== fileKey || bookmark.state === "missing") return bookmark;
    changed = true;
    return { ...bookmark, state: "missing" as const };
  });
  return changed ? next : bookmarks.slice();
}

export function restoreWorkspaceBookmarksForFile(
  bookmarks: readonly WorkspaceBookmark[],
  fileKey: string,
  pathLabel?: string,
): WorkspaceBookmark[] {
  let changed = false;
  const next = bookmarks.map((bookmark) => {
    if (bookmark.fileKey !== fileKey || bookmark.state !== "missing") return bookmark;
    changed = true;
    return {
      ...bookmark,
      state: "current" as const,
      ...(pathLabel ? { pathLabel } : {}),
    };
  });
  return changed ? next : bookmarks.slice();
}

/** Merge only the bookmark identities touched by a workspace transaction. */
export function mergeWorkspaceBookmarkSnapshot(
  current: readonly WorkspaceBookmark[],
  snapshot: readonly WorkspaceBookmark[],
  affectedIds: readonly string[],
): WorkspaceBookmark[] {
  const affected = new Set(affectedIds);
  if (affected.size === 0) return current.slice();
  const snapshotById = new Map(snapshot
    .filter((bookmark) => affected.has(bookmark.id))
    .map((bookmark) => [bookmark.id, bookmark]));
  const restored = new Set<string>();
  const next = current.flatMap((bookmark) => {
    if (!affected.has(bookmark.id)) return [bookmark];
    const replacement = snapshotById.get(bookmark.id);
    if (!replacement) return [];
    restored.add(bookmark.id);
    return [replacement];
  });
  for (const bookmark of snapshot) {
    if (affected.has(bookmark.id) && !restored.has(bookmark.id)) next.push(bookmark);
  }
  return next;
}
