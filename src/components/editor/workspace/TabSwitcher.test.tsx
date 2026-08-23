import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabSwitcher, type TabSwitcherEntry } from "./TabSwitcher";

afterEach(cleanup);

function editorEntry(overrides: Partial<TabSwitcherEntry> = {}): TabSwitcherEntry {
  return {
    key: "k1",
    title: "Main.ts",
    subtitle: "src/main.ts",
    dirty: false,
    active: false,
    leafId: "primary",
    ...overrides,
  };
}

describe("§8.18.5 TabSwitcher rendering", () => {
  const handlers = {
    onHover: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders with tool windows alone when the editor MRU list is empty", () => {
    render(
      <TabSwitcher
        open
        entries={[]}
        toolWindows={[{ id: "terminal", label: "Terminal", open: true }]}
        selectedIndex={0}
        {...handlers}
      />,
    );
    expect(screen.getByTestId("workspace-tab-switcher")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tab-switcher-tool-terminal")).toBeInTheDocument();
  });

  it("stays closed when there is nothing to list at all", () => {
    render(
      <TabSwitcher open entries={[]} toolWindows={[]} selectedIndex={0} {...handlers} />,
    );
    expect(screen.queryByTestId("workspace-tab-switcher")).toBeNull();
  });

  it("marks pinned files and open tool windows", () => {
    render(
      <TabSwitcher
        open
        entries={[editorEntry({ pinned: true })]}
        toolWindows={[{ id: "problems", label: "Problems", open: true }]}
        selectedIndex={0}
        {...handlers}
      />,
    );
    expect(screen.getByText("📌")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("commits on click and cancels on backdrop press", () => {
    render(
      <TabSwitcher
        open
        entries={[editorEntry()]}
        toolWindows={[]}
        selectedIndex={0}
        {...handlers}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId(`workspace-tab-switcher-item-k1`));
    expect(handlers.onCommit).toHaveBeenCalledWith(0);
    fireEvent.mouseDown(screen.getByTestId("workspace-tab-switcher"));
    expect(handlers.onCancel).toHaveBeenCalled();
  });
});
