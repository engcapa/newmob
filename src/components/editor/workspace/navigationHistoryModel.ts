/**
 * Navigation History & Recent Locations Model (E4.3).
 *
 * Implements IntelliJ IDEA's Recent Locations (Ctrl+Shift+E) with code context preview,
 * multi-point edit location history, and library / external file ownership.
 */

export interface NavigationLocation {
  id: string;
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
}

let locationSequenceCounter = 0;

export function isPathContainedInRoot(filePath: string, rootPath: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
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
      id,
      timestamp: now,
    };

    // Coalesce navigation entries if close to previous location in same file within 2 lines and within 2000ms
    const prev = this.locations[0];
    if (
      prev &&
      prev.fileIdentity === newEntry.fileIdentity &&
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

  getRecentLocations(changedOnly: boolean = false): NavigationLocation[] {
    return changedOnly ? this.editLocations : this.locations;
  }

  searchLocations(query: string, changedOnly: boolean = false): NavigationLocation[] {
    const list = this.getRecentLocations(changedOnly);
    const q = query.trim().toLowerCase();
    if (!q) return list;

    return list.filter((loc) => {
      if (loc.title.toLowerCase().includes(q)) return true;
      if (loc.filePath.toLowerCase().includes(q)) return true;
      if (loc.lineText.toLowerCase().includes(q)) return true;
      if (loc.symbolName?.toLowerCase().includes(q)) return true;
      if (loc.contextSnippet.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  clear(): void {
    this.locations = [];
    this.editLocations = [];
    this.notify();
  }
}

export const navigationHistoryTracker = new NavigationHistoryTracker();
