/**
 * Navigation History & Recent Locations Model (E4.3 / N2.1).
 *
 * Implements IntelliJ IDEA's Recent Locations (Ctrl+Shift+E) with code context preview,
 * multi-point edit location history, strict workspace identity, and canonical path policies.
 */

export type NavigationReason =
  | "navigate"
  | "edit"
  | "search"
  | "usage"
  | "refactor"
  | "tab-activate"
  | "tab-switch";

export type NavigationLocationState = "current" | "relocated" | "stale" | "missing";

export interface NavigationLocation {
  id: string;
  workspaceId: string;
  fileIdentity: string;
  filePath: string;
  title: string;
  line: number;
  character: number;
  lineText: string;
  contextSnippet: string; // 2-3 lines of surrounding code
  timestamp: number;
  isEditLocation: boolean;
  sourceOwnership: "workspace" | "library" | "external";
  symbolName?: string;
  reason?: NavigationReason;
  state?: NavigationLocationState;
  staleReason?: string;
}

let locationSequenceCounter = 0;

/**
 * Canonicalize file paths across platforms (forward slashes, drive letter normalization).
 */
export function canonicalizePath(filePath: string): string {
  if (!filePath) return "";
  let normalized = filePath.replace(/\\/g, "/");
  // Normalize Windows drive letter: C:/ -> c:/
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

export function isPathContainedInRoot(filePath: string, rootPath: string): boolean {
  const normalizedFile = canonicalizePath(filePath);
  const normalizedRoot = canonicalizePath(rootPath).replace(/\/+$/, "");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

export class NavigationHistoryTracker {
  private locations: NavigationLocation[] = [];
  private editLocations: NavigationLocation[] = [];
  private maxEntries: number = 100;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("NavigationHistoryTracker listener error:", err);
      }
    }
  }

  recordLocation(location: Omit<NavigationLocation, "id" | "timestamp">): NavigationLocation {
    const now = Date.now();
    const seq = ++locationSequenceCounter;
    const id = `loc-${location.fileIdentity}-${location.line}-${now}-${seq}`;
    const newEntry: NavigationLocation = {
      ...location,
      filePath: canonicalizePath(location.filePath),
      id,
      timestamp: now,
      state: location.state ?? "current",
      reason: location.reason ?? (location.isEditLocation ? "edit" : "navigate"),
    };

    // Coalesce navigation entries if close to previous location in same file within 2 lines and within 2000ms
    const prev = this.locations[0];
    if (
      prev &&
      prev.fileIdentity === newEntry.fileIdentity &&
      prev.workspaceId === newEntry.workspaceId &&
      Math.abs(prev.line - newEntry.line) <= 2 &&
      now - prev.timestamp < 2000
    ) {
      this.locations[0] = newEntry;
    } else {
      this.locations.unshift(newEntry);
      if (this.locations.length > this.maxEntries) {
        this.locations.pop();
      }
    }

    if (newEntry.isEditLocation) {
      const prevEdit = this.editLocations[0];
      if (
        prevEdit &&
        prevEdit.fileIdentity === newEntry.fileIdentity &&
        prevEdit.workspaceId === newEntry.workspaceId &&
        Math.abs(prevEdit.line - newEntry.line) <= 2 &&
        now - prevEdit.timestamp < 2000
      ) {
        this.editLocations[0] = newEntry;
      } else {
        this.editLocations.unshift(newEntry);
        if (this.editLocations.length > this.maxEntries) {
          this.editLocations.pop();
        }
      }
    }

    this.notify();
    return newEntry;
  }

  getRecentLocations(changedOnly: boolean = false, workspaceId?: string): NavigationLocation[] {
    const list = changedOnly ? this.editLocations : this.locations;
    if (!workspaceId) return list;
    return list.filter((loc) => loc.workspaceId === workspaceId);
  }

  searchLocations(query: string, changedOnly: boolean = false, workspaceId?: string): NavigationLocation[] {
    const list = this.getRecentLocations(changedOnly, workspaceId);
    const q = query.trim().toLowerCase();
    if (!q) return list;

    const segments = q.split(/[\/\\]+/).filter(Boolean);

    return list.filter((loc) => {
      const lowerPath = loc.filePath.toLowerCase();
      const lowerTitle = loc.title.toLowerCase();
      const lowerLine = loc.lineText.toLowerCase();
      const lowerSnippet = loc.contextSnippet.toLowerCase();
      const lowerSymbol = loc.symbolName?.toLowerCase() ?? "";

      if (lowerTitle.includes(q)) return true;
      if (lowerPath.includes(q)) return true;
      if (lowerLine.includes(q)) return true;
      if (lowerSymbol.includes(q)) return true;
      if (lowerSnippet.includes(q)) return true;

      if (segments.length > 1 && segments.every((seg) => lowerPath.includes(seg))) {
        return true;
      }

      return false;
    });
  }

  relocateFile(oldPath: string, newPath: string, workspaceId?: string): void {
    let changed = false;
    const normalizedOld = canonicalizePath(oldPath);
    const normalizedNew = canonicalizePath(newPath);
    const newTitle = normalizedNew.split("/").pop() ?? normalizedNew;

    for (const loc of [...this.locations, ...this.editLocations]) {
      if ((!workspaceId || loc.workspaceId === workspaceId) && loc.filePath === normalizedOld) {
        loc.filePath = normalizedNew;
        loc.fileIdentity = loc.fileIdentity.replace(normalizedOld, normalizedNew);
        loc.title = newTitle;
        loc.state = "relocated";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  relocateDirectory(oldDirPath: string, newDirPath: string, workspaceId?: string): void {
    let changed = false;
    const normOld = canonicalizePath(oldDirPath).replace(/\/+$/, "") + "/";
    const normNew = canonicalizePath(newDirPath).replace(/\/+$/, "") + "/";

    for (const loc of [...this.locations, ...this.editLocations]) {
      if ((!workspaceId || loc.workspaceId === workspaceId) && (loc.filePath + "/").startsWith(normOld)) {
        const sub = loc.filePath.slice(normOld.length - 1);
        const nextPath = normNew.slice(0, -1) + sub;
        loc.filePath = nextPath;
        loc.fileIdentity = loc.fileIdentity.replace(normOld.slice(0, -1), normNew.slice(0, -1));
        loc.title = nextPath.split("/").pop() ?? loc.title;
        loc.state = "relocated";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  markFileStale(filePath: string, workspaceId?: string, staleReason?: string): void {
    let changed = false;
    const normalized = canonicalizePath(filePath);
    for (const loc of [...this.locations, ...this.editLocations]) {
      if ((!workspaceId || loc.workspaceId === workspaceId) && loc.filePath === normalized) {
        loc.state = "stale";
        loc.staleReason = staleReason ?? "File content modified externally";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  markFileMissing(filePath: string, workspaceId?: string): void {
    let changed = false;
    const normalized = canonicalizePath(filePath);
    for (const loc of [...this.locations, ...this.editLocations]) {
      if ((!workspaceId || loc.workspaceId === workspaceId) && loc.filePath === normalized) {
        loc.state = "missing";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  removeFileLocations(filePath: string, workspaceId?: string): void {
    const normalized = canonicalizePath(filePath);
    const beforeCount = this.locations.length + this.editLocations.length;
    this.locations = this.locations.filter(
      (loc) => (workspaceId && loc.workspaceId !== workspaceId) || loc.filePath !== normalized,
    );
    this.editLocations = this.editLocations.filter(
      (loc) => (workspaceId && loc.workspaceId !== workspaceId) || loc.filePath !== normalized,
    );
    if (this.locations.length + this.editLocations.length !== beforeCount) {
      this.notify();
    }
  }

  removeDirectorySubtree(dirPath: string, workspaceId?: string): void {
    const normDir = canonicalizePath(dirPath).replace(/\/+$/, "") + "/";
    const beforeCount = this.locations.length + this.editLocations.length;
    this.locations = this.locations.filter(
      (loc) => (workspaceId && loc.workspaceId !== workspaceId) || !(loc.filePath + "/").startsWith(normDir),
    );
    this.editLocations = this.editLocations.filter(
      (loc) => (workspaceId && loc.workspaceId !== workspaceId) || !(loc.filePath + "/").startsWith(normDir),
    );
    if (this.locations.length + this.editLocations.length !== beforeCount) {
      this.notify();
    }
  }

  removeLocation(locationId: string): void {
    const beforeCount = this.locations.length + this.editLocations.length;
    this.locations = this.locations.filter((loc) => loc.id !== locationId);
    this.editLocations = this.editLocations.filter((loc) => loc.id !== locationId);
    if (this.locations.length + this.editLocations.length !== beforeCount) {
      this.notify();
    }
  }

  clearWorkspace(workspaceId: string): void {
    this.locations = this.locations.filter((loc) => loc.workspaceId !== workspaceId);
    this.editLocations = this.editLocations.filter((loc) => loc.workspaceId !== workspaceId);
    this.notify();
  }

  clearAll(): void {
    this.locations = [];
    this.editLocations = [];
    this.notify();
  }

  clear(): void {
    this.clearAll();
  }
}

export class WorkspaceLocationController {
  private readonly workspaceId: string;
  private readonly tracker: NavigationHistoryTracker;

  constructor(workspaceId: string, tracker?: NavigationHistoryTracker) {
    this.workspaceId = workspaceId;
    this.tracker = tracker ?? new NavigationHistoryTracker();
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  recordUserEdit(options: {
    fileKey: string;
    filePath: string;
    title: string;
    line: number;
    character: number;
    lineText: string;
    contextSnippet: string;
    sourceOwnership: "workspace" | "library" | "external";
    symbolName?: string;
  }): NavigationLocation {
    return this.tracker.recordLocation({
      workspaceId: this.workspaceId,
      fileIdentity: options.fileKey,
      filePath: options.filePath,
      title: options.title,
      line: options.line,
      character: options.character,
      lineText: options.lineText,
      contextSnippet: options.contextSnippet,
      isEditLocation: true,
      reason: "edit",
      sourceOwnership: options.sourceOwnership,
      symbolName: options.symbolName,
    });
  }

  recordNavigation(options: {
    fileKey: string;
    filePath: string;
    title: string;
    line: number;
    character: number;
    lineText: string;
    contextSnippet: string;
    sourceOwnership: "workspace" | "library" | "external";
    reason: NavigationReason;
    symbolName?: string;
  }): NavigationLocation {
    return this.tracker.recordLocation({
      workspaceId: this.workspaceId,
      fileIdentity: options.fileKey,
      filePath: options.filePath,
      title: options.title,
      line: options.line,
      character: options.character,
      lineText: options.lineText,
      contextSnippet: options.contextSnippet,
      isEditLocation: false,
      reason: options.reason,
      sourceOwnership: options.sourceOwnership,
      symbolName: options.symbolName,
    });
  }

  removeLocation(locationId: string): void {
    this.tracker.removeLocation(locationId);
  }

  relocateFile(oldPath: string, newPath: string): void {
    this.tracker.relocateFile(oldPath, newPath, this.workspaceId);
  }

  relocateDirectory(oldDirPath: string, newDirPath: string): void {
    this.tracker.relocateDirectory(oldDirPath, newDirPath, this.workspaceId);
  }

  removeFileLocations(filePath: string): void {
    this.tracker.removeFileLocations(filePath, this.workspaceId);
  }

  removeDirectorySubtree(dirPath: string): void {
    this.tracker.removeDirectorySubtree(dirPath, this.workspaceId);
  }

  getLocations(changedOnly: boolean = false): NavigationLocation[] {
    return this.tracker.getRecentLocations(changedOnly, this.workspaceId);
  }

  searchLocations(query: string, changedOnly: boolean = false): NavigationLocation[] {
    return this.tracker.searchLocations(query, changedOnly, this.workspaceId);
  }

  subscribe(listener: () => void): () => void {
    return this.tracker.subscribe(listener);
  }

  dispose(): void {
    this.tracker.clearWorkspace(this.workspaceId);
  }
}

export interface LocationIdentity {
  fileKey: string | null;
  canonicalPath: string;
  line: number;
  character: number;
}

export type WorkspacePathPlatform = "win32" | "darwin" | "linux";

/**
 * Platform-aware workspace path canonicalization (§8.16.5).
 * - win32: backslash → forward slash, `\??\`/`\?\` prefixes stripped,
 *   drive letter folded to uppercase, UNC share roots preserved, and the
 *   whole path is case-insensitive (comparison key lowercased).
 * - darwin/macOS: case-insensitive filesystem (default APFS), separator kept.
 * - linux: case-sensitive, separator kept.
 * The returned string is a canonical *display* form; use
 * `workspacePathComparisonKey` for equality checks.
 */
export function canonicalizeWorkspacePath(
  filePath: string,
  platform: WorkspacePathPlatform | string = "linux",
): string {
  let path = filePath;
  if (platform === "win32") {
    // Strip the Windows extended-length / NT prefixes.
    path = path.replace(/^\\\\\?\\UNC\\/, "\\\\");
    path = path.replace(/^\\\\\?\\/, "");
  }
  path = path.replace(/\\/g, "/");
  if (platform === "win32") {
    const driveSlash = path.match(/^\/([a-z])\/(.*)$/i);
    if (driveSlash) {
      path = `${driveSlash[1].toUpperCase()}:/${driveSlash[2]}`;
    }
    const drive = path.match(/^([a-z]):\/(.*)$/i);
    if (drive) {
      path = `${drive[1].toUpperCase()}:/${drive[2]}`;
    }
  }
  return path;
}

/** Case-folding comparison key for path equality on the given platform. */
export function workspacePathComparisonKey(
  filePath: string,
  platform: WorkspacePathPlatform | string = "linux",
): string {
  const canonical = canonicalizeWorkspacePath(filePath, platform);
  return platform === "win32" || platform === "darwin" ? canonical.toLowerCase() : canonical;
}

/**
 * Optional bridge into a Back/Forward navigation stack (§8.16.5): the facade
 * is the single entry that removes/relocates locations across Recent
 * Locations AND the Back/Forward history so Delete cannot split the two.
 */
export interface BackForwardHistoryBridge {
  /** Remove Back/Forward entries matching a file identity/path at a line. */
  removeLocation(identity: LocationIdentity): void;
  /** Remap Back/Forward entries after a file rename. */
  relocateFile(fromPath: string, toPath: string): void;
  /** Remove Back/Forward entries under a removed directory. */
  removeDirectorySubtree(dirPath: string): void;
}

export class NavigationHistoryFacade {
  constructor(
    private readonly locationController: WorkspaceLocationController,
    private readonly tracker?: NavigationHistoryTracker,
    private readonly backForward?: BackForwardHistoryBridge,
  ) {}

  remove(identity: LocationIdentity): void {
    const canonical = canonicalizeWorkspacePath(identity.canonicalPath);
    const locs = this.locationController.getLocations();
    for (const loc of locs) {
      if (
        (loc.fileIdentity === identity.fileKey || canonicalizeWorkspacePath(loc.filePath) === canonical) &&
        loc.line === identity.line
      ) {
        this.locationController.removeLocation(loc.id);
      }
    }
    if (this.tracker) {
      const all = this.tracker.getRecentLocations();
      for (const loc of all) {
        if (
          (loc.fileIdentity === identity.fileKey || canonicalizeWorkspacePath(loc.filePath) === canonical) &&
          loc.line === identity.line
        ) {
          this.tracker.removeLocation(loc.id);
        }
      }
    }
    this.backForward?.removeLocation(identity);
  }

  relocate(fromPath: string, toPath: string): void {
    this.locationController.relocateFile(fromPath, toPath);
    this.tracker?.relocateFile(fromPath, toPath);
    this.backForward?.relocateFile(fromPath, toPath);
  }

  removeSubtree(dirPath: string): void {
    this.locationController.removeDirectorySubtree(dirPath);
    this.tracker?.removeDirectorySubtree(dirPath);
    this.backForward?.removeDirectorySubtree(dirPath);
  }
}

export function createWorkspaceLocationController(
  workspaceId: string,
  tracker?: NavigationHistoryTracker,
): WorkspaceLocationController {
  return new WorkspaceLocationController(workspaceId, tracker);
}

/** @deprecated Use WorkspaceLocationController with workspaceId scope instead */
export const navigationHistoryTracker = new NavigationHistoryTracker();

