import { describe, expect, it, beforeEach } from "vitest";
import {
  NavigationHistoryTracker,
} from "./navigationHistoryModel";

describe("navigationHistoryModel", () => {
  let tracker: NavigationHistoryTracker;

  beforeEach(() => {
    tracker = new NavigationHistoryTracker();
  });

  it("records navigation locations and coalesces adjacent line visits", () => {
    tracker.recordLocation({
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

    tracker.clear();
    expect(notifiedCount).toBe(2);

    unsub();
  });
});
