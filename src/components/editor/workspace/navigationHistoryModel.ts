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

export class NavigationHistoryTracker {
  private locations: NavigationLocation[] = [];
  private editLocations: NavigationLocation[] = [];
  private maxEntries: number = 100;

  recordLocation(location: Omit<NavigationLocation, "id" | "timestamp">): NavigationLocation {
    const now = Date.now();
    const id = `loc-${location.fileIdentity}-${location.line}-${now}`;
    const newEntry: NavigationLocation = {
      ...location,
      id,
      timestamp: now,
    };

    // Coalesce if close to previous location in same file within 3 lines
    const prev = this.locations[0];
    if (
      prev &&
      prev.fileIdentity === newEntry.fileIdentity &&
      Math.abs(prev.line - newEntry.line) <= 2 &&
      !newEntry.isEditLocation
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
        Math.abs(prevEdit.line - newEntry.line) <= 2
      ) {
        this.editLocations[0] = newEntry;
      } else {
        this.editLocations.unshift(newEntry);
        if (this.editLocations.length > this.maxEntries) {
          this.editLocations.pop();
        }
      }
    }

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
  }
}

export const navigationHistoryTracker = new NavigationHistoryTracker();
