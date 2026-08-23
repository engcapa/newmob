import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentLocationsDialog } from "./RecentLocationsDialog";
import { navigationHistoryTracker } from "./navigationHistoryModel";

afterEach(cleanup);

describe("RecentLocationsDialog", () => {
  beforeEach(() => {
    navigationHistoryTracker.clear();
    navigationHistoryTracker.recordLocation({
      workspaceId: "default",
      fileIdentity: "f1",
      filePath: "/src/App.tsx",
      title: "App.tsx",
      line: 20,
      character: 4,
      lineText: "export function App() {",
      contextSnippet: "export function App() {\n  return <div />;\n}",
      isEditLocation: false,
      sourceOwnership: "workspace",
    });
    navigationHistoryTracker.recordLocation({
      workspaceId: "default",
      fileIdentity: "f2",
      filePath: "/src/Server.java",
      title: "Server.java",
      line: 50,
      character: 8,
      lineText: "public void start() {",
      contextSnippet: "public void start() {\n  listen();\n}",
      isEditLocation: true,
      sourceOwnership: "workspace",
    });
  });

  it("renders recent locations with snippet preview", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <RecentLocationsDialog
        open={true}
        onClose={onClose}
        onSelectLocation={onSelect}
      />
    );

    expect(screen.getByText("Recent Locations")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Server.java")).toBeInTheDocument();
  });

  it("filters locations when typing search query", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <RecentLocationsDialog
        open={true}
        onClose={onClose}
        onSelectLocation={onSelect}
      />
    );

    const searchInput = screen.getByTestId("recent-locations-search-input");
    fireEvent.change(searchInput, { target: { value: "Server" } });

    expect(screen.getByText("Server.java")).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).toBeNull();
  });

  it("toggles show edited only filter", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <RecentLocationsDialog
        open={true}
        onClose={onClose}
        onSelectLocation={onSelect}
      />
    );

    const toggleBtn = screen.getByTestId("recent-locations-toggle-changed");
    fireEvent.click(toggleBtn);

    // Only Server.java is an edit location
    expect(screen.getByText("Server.java")).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).toBeNull();
  });

  it("selects location when clicking an item", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <RecentLocationsDialog
        open={true}
        onClose={onClose}
        onSelectLocation={onSelect}
      />
    );

    const item = screen.getByText("Server.java");
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
