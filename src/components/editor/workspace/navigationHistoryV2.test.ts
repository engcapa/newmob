import { describe, expect, it, vi } from "vitest";
import {
  BackForwardHistoryBridge,
  LocationIdentity,
  NavigationHistoryFacade,
  canonicalizeWorkspacePath,
  createWorkspaceLocationController,
  workspacePathComparisonKey,
} from "./navigationHistoryModel";

describe("N2.6 platform-aware canonical paths", () => {
  it("win32: folds separators, drive case, extended prefixes and case", () => {
    expect(canonicalizeWorkspacePath("C:\\repo\\src\\Main.TS", "win32")).toBe("C:/repo/src/Main.TS");
    expect(canonicalizeWorkspacePath("c:/repo/src/a.ts", "win32")).toBe("C:/repo/src/a.ts");
    expect(canonicalizeWorkspacePath("\\\\?\\C:\\repo\\a.ts", "win32")).toBe("C:/repo/a.ts");
    // UNC share roots survive.
    expect(canonicalizeWorkspacePath("\\\\server\\share\\a.ts", "win32")).toBe("//server/share/a.ts");
    expect(workspacePathComparisonKey("C:\\Repo\\A.TS", "win32"))
      .toBe(workspacePathComparisonKey("c:/REPO/a.ts", "win32"));
  });

  it("darwin: case-insensitive comparison, separator preserved", () => {
    expect(workspacePathComparisonKey("/Users/x/A.ts", "darwin"))
      .toBe(workspacePathComparisonKey("/users/X/a.ts", "darwin"));
  });

  it("linux: case-sensitive", () => {
    expect(workspacePathComparisonKey("/home/A.ts", "linux"))
      .not.toBe(workspacePathComparisonKey("/home/a.ts", "linux"));
  });
});

describe("N2.6 facade dual-history delete", () => {
  it("remove() deletes from the controller AND the Back/Forward bridge", () => {
    const controller = createWorkspaceLocationController("ws-n26");
    controller.recordNavigation({
      fileKey: "root:app:a.ts",
      filePath: "/repo/app/a.ts",
      title: "a.ts",
      line: 3,
      character: 0,
      lineText: "const a = 1;",
      contextSnippet: "const a = 1;",
      sourceOwnership: "workspace",
      reason: "tab-activate",
    });
    const bridge: BackForwardHistoryBridge = {
      removeLocation: vi.fn(),
      relocateFile: vi.fn(),
      removeDirectorySubtree: vi.fn(),
    };
    const facade = new NavigationHistoryFacade(controller, undefined, bridge);
    const identity: LocationIdentity = {
      fileKey: "root:app:a.ts",
      canonicalPath: "/repo/app/a.ts",
      line: 3,
      character: 0,
    };
    facade.remove(identity);
    expect(controller.getLocations().some((loc) => loc.line === 3 && loc.fileIdentity === "root:app:a.ts"))
      .toBe(false);
    expect(bridge.removeLocation).toHaveBeenCalledWith(identity);
  });

  it("removeSubtree removes descendant locations but preserves sibling locations", () => {
    const controller = createWorkspaceLocationController("ws-n26-subtree");
    controller.recordNavigation({
      fileKey: "root:app:src/a.ts",
      filePath: "/repo/app/src/a.ts",
      title: "a.ts",
      line: 1,
      character: 0,
      lineText: "a",
      contextSnippet: "a",
      sourceOwnership: "workspace",
      reason: "navigate",
    });
    controller.recordNavigation({
      fileKey: "root:app:other.ts",
      filePath: "/repo/app/other.ts",
      title: "other.ts",
      line: 1,
      character: 0,
      lineText: "other",
      contextSnippet: "other",
      sourceOwnership: "workspace",
      reason: "navigate",
    });
    const bridge: BackForwardHistoryBridge = {
      removeLocation: vi.fn(),
      relocateFile: vi.fn(),
      removeDirectorySubtree: vi.fn(),
    };
    const facade = new NavigationHistoryFacade(controller, undefined, bridge);
    facade.removeSubtree("/repo/app/src");
    expect(controller.getLocations().map((location) => location.filePath)).toEqual(["/repo/app/other.ts"]);
    expect(bridge.removeDirectorySubtree).toHaveBeenCalledWith("/repo/app/src");
  });

  it("relocates files and removes subtrees through the Back/Forward bridge", () => {
    const controller = createWorkspaceLocationController("ws-n26-b");
    const bridge: BackForwardHistoryBridge = {
      removeLocation: vi.fn(),
      relocateFile: vi.fn(),
      removeDirectorySubtree: vi.fn(),
    };
    const facade = new NavigationHistoryFacade(controller, undefined, bridge);
    facade.relocate("/repo/a.ts", "/repo/b.ts");
    facade.removeSubtree("/repo/gone");
    expect(bridge.relocateFile).toHaveBeenCalledWith("/repo/a.ts", "/repo/b.ts");
    expect(bridge.removeDirectorySubtree).toHaveBeenCalledWith("/repo/gone");
  });
});
