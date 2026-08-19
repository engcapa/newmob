import { describe, expect, it, beforeEach } from "vitest";
import {
  NavigationHistoryTracker,
  WorkspaceLocationController,
  createWorkspaceLocationController,
  canonicalizePath,
  isPathContainedInRoot,
} from "./navigationHistoryModel";

describe("navigationHistoryModel", () => {
  let tracker: NavigationHistoryTracker;

  beforeEach(() => {
    tracker = new NavigationHistoryTracker();
  });

  it("records navigation locations and coalesces adjacent line visits", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/Main.java",
      title: "Main.java",
      line: 10,
      character: 5,
      lineText: "public void main()",
      contextSnippet: "public void main() {\n  System.out.println();\n}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    expect(tracker.getRecentLocations()).toHaveLength(1);

    // Moving within 2 lines in same file coalesces
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/Main.java",
      title: "Main.java",
      line: 11,
      character: 2,
      lineText: "  System.out.println();",
      contextSnippet: "public void main() {\n  System.out.println();\n}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    expect(tracker.getRecentLocations()).toHaveLength(1);
    expect(tracker.getRecentLocations()[0].line).toBe(11);
  });

  it("tracks edit locations separately", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/Main.java",
      title: "Main.java",
      line: 10,
      character: 5,
      lineText: "public void main()",
      contextSnippet: "public void main()",
      isEditLocation: true,
      sourceOwnership: "workspace",
    });

    expect(tracker.getRecentLocations(false)).toHaveLength(1);
    expect(tracker.getRecentLocations(true)).toHaveLength(1);
  });

  it("searches locations by title, line text, and snippet", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/OrderService.java",
      title: "OrderService.java",
      line: 45,
      character: 10,
      lineText: "public Order processOrder(String orderId)",
      contextSnippet: "public Order processOrder(String orderId) {\n  validateOrder(orderId);\n}",
      symbolName: "processOrder",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    const matches = tracker.searchLocations("processOrder");
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe("OrderService.java");
  });

  it("generates unique monotonic IDs for multiple entries recorded in quick succession", () => {
    const loc1 = tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/A.java",
      title: "A.java",
      line: 1,
      character: 0,
      lineText: "class A {}",
      contextSnippet: "class A {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    const loc2 = tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f2",
      filePath: "/src/B.java",
      title: "B.java",
      line: 1,
      character: 0,
      lineText: "class B {}",
      contextSnippet: "class B {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    expect(loc1.id).not.toBe(loc2.id);
  });

  it("notifies subscribers when locations are recorded or cleared", () => {
    let notifiedCount = 0;
    const unsub = tracker.subscribe(() => {
      notifiedCount += 1;
    });

    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/A.java",
      title: "A.java",
      line: 1,
      character: 0,
      lineText: "class A {}",
      contextSnippet: "class A {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    expect(notifiedCount).toBe(1);

    tracker.clearAll();
    expect(notifiedCount).toBe(2);

    unsub();
  });

  it("identifies paths contained inside root directory accurately", () => {
    expect(isPathContainedInRoot("/project/src/Main.java", "/project")).toBe(true);
    expect(isPathContainedInRoot("/project/src/Main.java", "/project/")).toBe(true);
    expect(isPathContainedInRoot("/project-other/src/Main.java", "/project")).toBe(false);
    expect(isPathContainedInRoot("/var/log/app.log", "/project")).toBe(false);
  });

  it("canonicalizes paths on Windows and Unix uniformly", () => {
    expect(canonicalizePath("C:\\Users\\dev\\Project\\App.java")).toBe("c:/Users/dev/Project/App.java");
    expect(canonicalizePath("/home/dev/project/src/app.rs")).toBe("/home/dev/project/src/app.rs");
  });

  it("relocates and marks file locations on rename and delete", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/OldName.java",
      title: "OldName.java",
      line: 10,
      character: 0,
      lineText: "class OldName {}",
      contextSnippet: "class OldName {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    tracker.relocateFile("/src/OldName.java", "/src/NewName.java", "ws-1");
    expect(tracker.getRecentLocations()[0].filePath).toBe("/src/NewName.java");
    expect(tracker.getRecentLocations()[0].title).toBe("NewName.java");

    tracker.markFileMissing("/src/NewName.java", "ws-1");
    expect(tracker.getRecentLocations()[0].state).toBe("missing");
  });

  it("filters locations by workspaceId and supports WorkspaceLocationController", () => {
    const ctrl1 = createWorkspaceLocationController("ws-1", tracker);
    const ctrl2 = createWorkspaceLocationController("ws-2", tracker);

    ctrl1.recordUserEdit({
      fileKey: "f1",
      filePath: "/src/A.java",
      title: "A.java",
      line: 1,
      character: 0,
      lineText: "class A {}",
      contextSnippet: "class A {}",
      sourceOwnership: "workspace",
    });

    ctrl2.recordNavigation({
      fileKey: "f2",
      filePath: "/src/B.java",
      title: "B.java",
      line: 1,
      character: 0,
      lineText: "class B {}",
      contextSnippet: "class B {}",
      sourceOwnership: "workspace",
      reason: "navigate",
    });

    expect(ctrl1.getLocations(true)).toHaveLength(1);
    expect(ctrl1.getLocations(true)[0].title).toBe("A.java");
    expect(ctrl2.getLocations(true)).toHaveLength(0); // B.java was not an edit
    expect(ctrl2.getLocations(false)).toHaveLength(1);
    expect(ctrl2.getLocations(false)[0].title).toBe("B.java");
  });

  it("marks file locations as stale and missing with reason", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/A.java",
      title: "A.java",
      line: 1,
      character: 0,
      lineText: "class A {}",
      contextSnippet: "class A {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    tracker.markFileStale("/src/A.java", "ws-1", "External conflict");
    expect(tracker.getRecentLocations(false, "ws-1")[0].state).toBe("stale");
    expect(tracker.getRecentLocations(false, "ws-1")[0].staleReason).toBe("External conflict");

    tracker.markFileMissing("/src/A.java", "ws-1");
    expect(tracker.getRecentLocations(false, "ws-1")[0].state).toBe("missing");
  });

  it("clears only locations belonging to a specific workspaceId with clearWorkspace", () => {
    tracker.recordLocation({
      workspaceId: "ws-1",
      fileIdentity: "f1",
      filePath: "/src/A.java",
      title: "A.java",
      line: 1,
      character: 0,
      lineText: "class A {}",
      contextSnippet: "class A {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });
    tracker.recordLocation({
      workspaceId: "ws-2",
      fileIdentity: "f2",
      filePath: "/src/B.java",
      title: "B.java",
      line: 1,
      character: 0,
      lineText: "class B {}",
      contextSnippet: "class B {}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });

    tracker.clearWorkspace("ws-1");
    expect(tracker.getRecentLocations(false, "ws-1")).toHaveLength(0);
    expect(tracker.getRecentLocations(false, "ws-2")).toHaveLength(1);
  });

  it("WorkspaceLocationController records locations scoped to its workspaceId", () => {
    const ctrl = new WorkspaceLocationController("ws-custom", tracker);
    ctrl.recordNavigation({
      fileKey: "f-ctrl",
      filePath: "/src/Ctrl.java",
      title: "Ctrl.java",
      line: 1,
      character: 0,
      lineText: "class Ctrl {}",
      contextSnippet: "class Ctrl {}",
      sourceOwnership: "workspace",
      reason: "navigate",
    });

    const locs = ctrl.getLocations();
    expect(locs).toHaveLength(1);
    expect(locs[0].workspaceId).toBe("ws-custom");
  });
});
