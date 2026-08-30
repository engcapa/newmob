import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import {
  Breadcrumbs,
  collapsedBreadcrumbItems,
  symbolChainAtPosition,
  symbolSiblingsAt,
  type BreadcrumbPathChild,
} from "./Breadcrumbs";

afterEach(() => {
  cleanup();
});

function breadcrumbNav() {
  return screen.getByTestId("code-workspace-breadcrumbs");
}

function clickPathSegment(kind: "root" | "directory" | "file", label: RegExp | string) {
  const buttons = within(breadcrumbNav()).getAllByTestId(`code-workspace-breadcrumb-path-${kind}`);
  const match = buttons.find((button) => label instanceof RegExp
    ? label.test(button.textContent ?? "")
    : (button.textContent ?? "").includes(label));
  if (!match) throw new Error(`No ${kind} breadcrumb matching ${label}`);
  fireEvent.click(match);
  return match;
}

const symbols: LspDocumentSymbol[] = [
  {
    name: "App",
    detail: null,
    kind: 5,
    depth: 0,
    range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
  },
  {
    name: "Helper",
    detail: null,
    kind: 5,
    depth: 0,
    range: { start: { line: 21, character: 0 }, end: { line: 30, character: 0 } },
    selectionRange: { start: { line: 21, character: 6 }, end: { line: 21, character: 12 } },
  },
  {
    name: "render",
    detail: null,
    kind: 6,
    depth: 1,
    range: { start: { line: 5, character: 2 }, end: { line: 10, character: 3 } },
    selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
  },
  {
    name: "mount",
    detail: null,
    kind: 6,
    depth: 1,
    range: { start: { line: 11, character: 2 }, end: { line: 15, character: 3 } },
    selectionRange: { start: { line: 11, character: 2 }, end: { line: 11, character: 7 } },
  },
];

describe("Breadcrumbs", () => {
  it("collapses intermediate path and symbol segments for narrow editor panes", () => {
    const segments = [
      { label: "repo", path: "", kind: "root" as const },
      { label: "src", path: "src", kind: "directory" as const },
      { label: "main", path: "src/main", kind: "directory" as const },
      { label: "java", path: "src/main/java", kind: "directory" as const },
      { label: "App.java", path: "src/main/java/App.java", kind: "file" as const },
    ];
    const chain = symbolChainAtPosition(symbols, { line: 7, character: 1 });

    expect(collapsedBreadcrumbItems(segments, chain).map((item) => {
      if (item.type === "collapsed") return "…";
      return item.type === "symbol" ? item.value.name : item.value.label;
    })).toEqual(["repo", "…", "java", "App.java", "…", "render"]);
  });

  it("derives the nested symbol chain at the cursor", () => {
    expect(symbolChainAtPosition(symbols, { line: 7, character: 1 }).map((item) => item.name))
      .toEqual(["App", "render"]);
    expect(symbolChainAtPosition(symbols, { line: 18, character: 1 }).map((item) => item.name))
      .toEqual(["App"]);
  });

  it("lists sibling symbols under the same parent", () => {
    const render = symbols.find((item) => item.name === "render")!;
    expect(symbolSiblingsAt(symbols, render).map((item) => item.name)).toEqual(["render", "mount"]);
    const app = symbols.find((item) => item.name === "App")!;
    expect(symbolSiblingsAt(symbols, app).map((item) => item.name)).toEqual(["App", "Helper"]);
  });

  it("opens an IDEA-style path popup with children and actions on segment click", async () => {
    const loadPathChildren = vi.fn().mockResolvedValue([
      { label: "App.tsx", path: "src/App.tsx", kind: "file", active: true },
      { label: "lib", path: "src/lib", kind: "directory" },
    ]);
    const onPathNavigate = vi.fn();
    const onCopy = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={symbols}
        position={{ line: 7, character: 1 }}
        loadPathChildren={loadPathChildren}
        onPathNavigate={onPathNavigate}
        pathActionsForSegment={(segment) => [
          {
            id: "copy-path",
            label: "Copy Path",
            onSelect: () => onCopy(segment.path),
          },
        ]}
      />,
    );

    clickPathSegment("directory", /src/);
    expect(loadPathChildren).toHaveBeenCalledWith(expect.objectContaining({ path: "src" }));

    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    expect(popup).toBeTruthy();
    expect(await within(popup).findByRole("option", { name: /lib/ })).toBeTruthy();
    expect(within(popup).getByRole("option", { name: /App\.tsx/ })).toBeTruthy();

    fireEvent.click(within(popup).getByRole("option", { name: /lib/ }));
    expect(onPathNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/lib", kind: "directory" }),
      expect.objectContaining({ path: "src" }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull();
    });
  });

  it("runs path actions from the segment popup footer", async () => {
    const onCopy = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
        ]}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        loadPathChildren={vi.fn().mockResolvedValue([])}
        pathActionsForSegment={(segment) => [
          { id: "copy-path", label: "Copy Path", onSelect: () => onCopy(segment.path) },
        ]}
      />,
    );

    clickPathSegment("directory", /src/);
    const action = await screen.findByTestId("code-workspace-breadcrumb-action-copy-path");
    fireEvent.click(action);
    expect(onCopy).toHaveBeenCalledWith("src");
  });

  it("opens a sibling-symbol popup when a symbol segment is clicked", async () => {
    const onSymbolClick = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[{ label: "App.tsx", path: "App.tsx", kind: "file" }]}
        symbols={symbols}
        position={{ line: 7, character: 1 }}
        onSymbolClick={onSymbolClick}
      />,
    );

    const symbolButtons = within(breadcrumbNav()).getAllByTestId("code-workspace-breadcrumb-symbol");
    const renderBtn = symbolButtons.find((button) => /render/.test(button.textContent ?? ""));
    expect(renderBtn).toBeTruthy();
    fireEvent.click(renderBtn!);
    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    fireEvent.click(within(popup).getByRole("option", { name: /mount/ }));
    expect(onSymbolClick).toHaveBeenCalledWith(expect.objectContaining({ name: "mount" }));
  });

  it("falls back to onPathClick when loadPathChildren is not provided", () => {
    const onPathClick = vi.fn();
    const onSymbolClick = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={symbols}
        position={{ line: 7, character: 1 }}
        onPathClick={onPathClick}
        onSymbolClick={onSymbolClick}
      />,
    );

    clickPathSegment("directory", /src/);
    expect(onPathClick).toHaveBeenCalledWith(expect.objectContaining({ path: "src" }));
    const symbolButtons = within(breadcrumbNav()).getAllByTestId("code-workspace-breadcrumb-symbol");
    const appBtn = symbolButtons.find((button) => (button.textContent ?? "").trim() === "App");
    expect(appBtn).toBeTruthy();
    fireEvent.click(appBtn!);
    expect(screen.getByTestId("code-workspace-breadcrumb-popup")).toBeTruthy();
  });

  it("supports keyboard navigation when activeNavigationBar is enabled", () => {
    const onCloseNavigationBar = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={symbols}
        position={{ line: 7, character: 1 }}
        activeNavigationBar={true}
        onCloseNavigationBar={onCloseNavigationBar}
      />,
    );

    const nav = breadcrumbNav();
    // Navigate with Left arrow
    fireEvent.keyDown(nav, { key: "ArrowLeft" });
    const focused = nav.querySelector("[data-focused='true']");
    expect(focused).toBeTruthy();

    // Escape closes navigation bar
    fireEvent.keyDown(nav, { key: "Escape" });
    expect(onCloseNavigationBar).toHaveBeenCalledTimes(1);
  });

  it("traverses all navigation segments with Home, End, and arrow keys", async () => {
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        activeNavigationBar={true}
      />,
    );

    const nav = breadcrumbNav();
    await waitFor(() => expect(document.activeElement).toBe(nav));
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-2");

    fireEvent.keyDown(nav, { key: "Home" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-0");
    expect(nav.querySelector("[data-nav-index='0']")).toHaveAttribute("data-focused", "true");

    fireEvent.keyDown(nav, { key: "ArrowRight" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-1");
    fireEvent.keyDown(nav, { key: "ArrowLeft" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-0");

    fireEvent.keyDown(nav, { key: "End" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-2");
  });

  it("sorts path options before selecting the active entry with the keyboard", async () => {
    const loadPathChildren = vi.fn().mockResolvedValue([
      { label: "zeta.ts", path: "src/zeta.ts", kind: "file", active: true },
      { label: "alpha", path: "src/alpha", kind: "directory" },
    ]);
    const onPathNavigate = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        loadPathChildren={loadPathChildren}
        onPathNavigate={onPathNavigate}
        activeNavigationBar={true}
      />,
    );

    const nav = breadcrumbNav();
    await waitFor(() => expect(document.activeElement).toBe(nav));
    fireEvent.keyDown(nav, { key: "Home" });
    fireEvent.keyDown(nav, { key: "ArrowRight" });
    fireEvent.keyDown(nav, { key: "Enter" });

    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    const options = within(popup).getAllByRole("option");
    expect(options.map((option) => option.textContent?.trim())).toEqual(["alpha", "zeta.ts"]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(popup).toHaveAttribute("aria-activedescendant", options[1].id);
    expect(within(popup).getByRole("combobox")).toHaveAttribute("aria-controls", popup.id);

    fireEvent.keyDown(within(popup).getByRole("combobox"), { key: "ArrowUp" });
    fireEvent.keyDown(within(popup).getByRole("combobox"), { key: "Enter" });
    expect(onPathNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ label: "alpha", kind: "directory" }),
      expect.objectContaining({ path: "src" }),
    );
    await waitFor(() => expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull());
  });

  it("restores navigation-bar focus when Escape cancels a popup", async () => {
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
        ]}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        loadPathChildren={vi.fn().mockResolvedValue([])}
        activeNavigationBar={true}
      />,
    );

    const nav = breadcrumbNav();
    await waitFor(() => expect(document.activeElement).toBe(nav));
    fireEvent.keyDown(nav, { key: "Home" });
    fireEvent.keyDown(nav, { key: "ArrowRight" });
    fireEvent.keyDown(nav, { key: "Enter" });
    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    const filter = within(popup).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(filter));

    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull());
    expect(document.activeElement).toBe(nav);
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-1");
  });

  it("does not reopen a stale path popup after the active trail changes", async () => {
    let resolveListing: (children: BreadcrumbPathChild[]) => void = () => undefined;
    const loadPathChildren = vi.fn(() => new Promise<BreadcrumbPathChild[]>((resolve) => {
      resolveListing = resolve;
    }));
    const onPathNavigate = vi.fn();
    const initialPath = [
      { label: "repo", path: "", kind: "root" as const },
      { label: "src", path: "src", kind: "directory" as const },
      { label: "App.tsx", path: "src/App.tsx", kind: "file" as const },
    ];
    const { rerender } = render(
      <Breadcrumbs
        pathSegments={initialPath}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        loadPathChildren={loadPathChildren}
        onPathNavigate={onPathNavigate}
      />,
    );

    clickPathSegment("directory", /src/);
    await screen.findByTestId("code-workspace-breadcrumb-popup");
    rerender(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "lib", path: "lib", kind: "directory" },
          { label: "App.tsx", path: "lib/App.tsx", kind: "file" },
        ]}
        symbols={[]}
        position={{ line: 0, character: 0 }}
        loadPathChildren={loadPathChildren}
        onPathNavigate={onPathNavigate}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull());

    await act(async () => {
      resolveListing([{ label: "late.ts", path: "src/late.ts", kind: "file" }]);
    });
    expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull();
    expect(onPathNavigate).not.toHaveBeenCalled();
  });
});
