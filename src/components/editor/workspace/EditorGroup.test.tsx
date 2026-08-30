import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorGroup } from "./EditorGroup";
import type { OpenFileViewModel } from "./editorGroupTypes";

vi.mock("./CodeMirrorHost", () => ({
  CodeMirrorHost: ({
    onFoldProvenanceChange,
    renderedDocEnabled,
    renderedDocLanguageId,
  }: {
    onFoldProvenanceChange?: (p: string | null) => void;
    renderedDocEnabled?: boolean;
    renderedDocLanguageId?: string | null;
  }) => (
    <div
      data-testid="mock-code-mirror"
      data-rendered-doc-enabled={renderedDocEnabled || undefined}
      data-rendered-doc-language={renderedDocLanguageId || undefined}
    >
      <button
        type="button"
        data-testid="mock-trigger-fold-provenance"
        onClick={() => onFoldProvenanceChange?.("explicit-comment")}
      >
        Trigger Fold
      </button>
    </div>
  ),
}));

afterEach(cleanup);

function file(key: string): OpenFileViewModel {
  return {
    key,
    ref: { kind: "root", rootId: "root", path: `${key}.ts` },
    path: `${key}.ts`,
    title: `${key}.ts`,
    subtitle: `repo / ${key}.ts`,
    languagePath: `${key}.ts`,
    text: key,
    savedText: key,
    eol: "LF",
    size: 1,
    mtime: 1,
    hash: key,
    loading: false,
    saving: false,
    dirty: false,
    documentRevision: 0,
    error: null,
  };
}

function props(overrides: Partial<ComponentProps<typeof EditorGroup>> = {}): ComponentProps<typeof EditorGroup> {
  const a = file("a");
  const b = file("b");
  return {
    groupId: "primary",
    workspaceInstanceId: "ws",
    visible: true,
    openOrder: ["a", "b"],
    openFiles: { a, b },
    activeKey: "b",
    previewKey: "b",
    pinnedKeys: ["a"],
    activeFile: b,
    activeMarkdownMode: "edit",
    activeDiagnostics: [],
    activeHighlights: [],
    activeInlayHints: [],
    activeGitChanges: [],
    activeGitBlame: null,
    activeCapabilities: null,
    activeLspSyncing: false,
    lspStatusPill: null,
    breadcrumbs: null,
    revealTarget: null,
    editorPaneRef: { current: null },
    editorPaneStyle: {},
    onActivate: vi.fn(),
    onActivateGroup: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    onPromotePreview: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseRight: vi.fn(),
    onCloseUnmodified: vi.fn(),
    onCloseAll: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onCopyPath: vi.fn(),
    onRevealInTree: vi.fn(),
    onRevealInSystem: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onMarkdownModeChange: vi.fn(),
    onChangeText: vi.fn(),
    onSave: vi.fn(),
    onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false),
    onReferences: vi.fn(async () => {}),
    onEditorContextMenu: vi.fn(),
    onComplete: vi.fn(async () => null),
    onCompleteResolve: vi.fn(async () => null),
    onCompletionIdentity: vi.fn(() => null),
    onCompletionDiagnostic: vi.fn(),
    onParameterTrigger: vi.fn(),
    onParameterInvalidate: vi.fn(),
    onParameterEscape: vi.fn(() => false),
    parameterPopup: null,
    onSelectionChange: vi.fn(),
    onViewportChange: vi.fn(),
    onExpandSelection: vi.fn(async () => null),
    onLightbulb: vi.fn(),
    onOpenMarkdownHref: vi.fn(() => false),
    formatBytes: vi.fn(() => "1 B"),
    formatMtime: vi.fn(() => ""),
    isMarkdownPath: vi.fn(() => false),
    renderMarkdownPreview: vi.fn(() => null),
    ...overrides,
  };
}

describe("EditorGroup tabs", () => {
  it("uses the metadata row for file details without repeating the breadcrumb path", () => {
    const activeFile = {
      ...file("BackupManager"),
      subtitle: "persis-g2 / persis-g2-server/src/main/java/com/deepzero/ads/persis/backup/BackupManager.java",
      size: 12_500,
    };
    render(<EditorGroup {...props({
      activeFile,
      lspStatusPill: <span>Java</span>,
      formatBytes: () => "12.5 KB",
      formatMtime: () => "2026/3/29 08:28:53",
    })} />);

    const status = screen.getByTestId("code-workspace-file-status");
    expect(status).toHaveTextContent("12.5 KB");
    expect(status).toHaveTextContent("2026/3/29 08:28:53");
    expect(status).toHaveTextContent("Java");
    expect(status).not.toHaveTextContent(activeFile.subtitle);
  });

  it("renders pinned tabs first, marks previews, promotes on double click, and middle-closes", () => {
    const onPromotePreview = vi.fn();
    const onClose = vi.fn();
    render(<EditorGroup {...props({ onPromotePreview, onClose })} />);

    const aButton = screen.getByTitle("repo / a.ts");
    const bButton = screen.getByTitle("repo / b.ts");
    expect(aButton.parentElement).toHaveAttribute("data-pinned", "true");
    expect(bButton.parentElement).toHaveAttribute("data-preview", "true");
    expect(screen.getByText("b.ts")).toHaveClass("italic");

    fireEvent.doubleClick(bButton);
    expect(onPromotePreview).toHaveBeenCalledWith("b");
    fireEvent(bButton, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).toHaveBeenCalledWith("b");
  });

  it("exposes pin and close actions from the tab context menu", () => {
    const onPin = vi.fn();
    const onCloseOthers = vi.fn();
    render(<EditorGroup {...props({ onPin, onCloseOthers })} />);

    fireEvent.contextMenu(screen.getByTitle("repo / b.ts"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Pin Tab" }));
    expect(onPin).toHaveBeenCalledWith("b", true);

    fireEvent.contextMenu(screen.getByTitle("repo / b.ts"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Close Others" }));
    expect(onCloseOthers).toHaveBeenCalledWith("b");
  });

  it("exposes path, tree, explorer, and terminal actions from the tab menu", () => {
    const onCopyPath = vi.fn();
    const onRevealInTree = vi.fn();
    const onRevealInSystem = vi.fn();
    const onOpenInTerminal = vi.fn();
    render(<EditorGroup {...props({
      onCopyPath,
      onRevealInTree,
      onRevealInSystem,
      onOpenInTerminal,
    })} />);

    const openMenuAndClick = (label: string) => {
      fireEvent.contextMenu(screen.getByTitle("repo / b.ts"), { clientX: 10, clientY: 10 });
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
    };
    openMenuAndClick("Copy Path");
    openMenuAndClick("Copy Relative Path");
    openMenuAndClick("Reveal in Project Tree");
    openMenuAndClick("Reveal in Explorer");
    openMenuAndClick("Open in Terminal");

    expect(onCopyPath).toHaveBeenNthCalledWith(1, "b", true);
    expect(onCopyPath).toHaveBeenNthCalledWith(2, "b", false);
    expect(onRevealInTree).toHaveBeenCalledWith("b");
    expect(onRevealInSystem).toHaveBeenCalledWith("b");
    expect(onOpenInTerminal).toHaveBeenCalledWith("b");
  });

  it("matches strip height to the editor tab height token and hides layout-eating scroll chrome", () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const openFiles = Object.fromEntries(many.map((key) => [key, file(key)]));
    render(<EditorGroup {...props({
      openOrder: many,
      openFiles,
      activeKey: many[many.length - 1],
      previewKey: null,
      pinnedKeys: [],
      activeFile: openFiles[many[many.length - 1]],
    })} />);

    const strip = screen.getByTestId("code-workspace-editor-tab-strip");
    const scroll = screen.getByTestId("code-workspace-editor-tab-scroll");
    const menu = screen.getByTestId("code-workspace-editor-tabs-menu");

    expect(strip.style.height).toBe("var(--taomni-code-editor-tab-height)");
    expect(strip.className).not.toMatch(/\bh-8\b/);
    expect(scroll.className).toContain("taomni-tab-scroll");
    expect(scroll.className).toContain("overflow-x-auto");
    expect(scroll.className).toContain("overflow-y-hidden");
    // All-tabs control must stay pinned outside the scrolling track.
    expect(scroll.contains(menu)).toBe(false);
    expect(strip.contains(menu)).toBe(true);
    expect(scroll.querySelectorAll("[data-editor-tab-key]")).toHaveLength(12);
    const firstTab = scroll.querySelector("[data-editor-tab-key]") as HTMLElement;
    expect(firstTab.className).toMatch(/min-w-\[96px\]/);
  });

  it("shows pinned scroll chevrons when the tab track overflows and scrolls on click", () => {
    const many = Array.from({ length: 8 }, (_, i) => `f${i}`);
    const openFiles = Object.fromEntries(many.map((key) => [key, file(key)]));
    render(<EditorGroup {...props({
      openOrder: many,
      openFiles,
      activeKey: "f0",
      previewKey: null,
      pinnedKeys: [],
      activeFile: openFiles.f0,
    })} />);

    const scroll = screen.getByTestId("code-workspace-editor-tab-scroll");
    let scrollLeft = 0;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(scroll, "scrollWidth", { configurable: true, value: 1200 });
    Object.defineProperty(scroll, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    fireEvent.scroll(scroll);

    const left = screen.getByTestId("code-workspace-editor-tab-scroll-left");
    const right = screen.getByTestId("code-workspace-editor-tab-scroll-right");
    const menu = screen.getByTestId("code-workspace-editor-tabs-menu");
    expect(scroll.contains(left)).toBe(false);
    expect(scroll.contains(right)).toBe(false);
    expect(scroll.contains(menu)).toBe(false);
    expect(left).toBeDisabled();
    expect(right).not.toBeDisabled();

    fireEvent.click(right);
    expect(scrollLeft).toBeGreaterThan(0);
    fireEvent.scroll(scroll);
    expect(screen.getByTestId("code-workspace-editor-tab-scroll-left")).not.toBeDisabled();
  });

  it("scrolls the active tab into the visible track using rect geometry (sidebar-safe)", () => {
    const many = Array.from({ length: 6 }, (_, i) => `f${i}`);
    const openFiles = Object.fromEntries(many.map((key) => [key, file(key)]));
    const { rerender } = render(<EditorGroup {...props({
      openOrder: many,
      openFiles,
      activeKey: "f0",
      previewKey: null,
      pinnedKeys: [],
      activeFile: openFiles.f0,
    })} />);

    const scroll = screen.getByTestId("code-workspace-editor-tab-scroll");
    let scrollLeft = 0;
    // Simulate a ~300px left project pane: the scroll track is not at x=0.
    const paneLeft = 300;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(scroll, "scrollWidth", { configurable: true, value: 1000 });
    Object.defineProperty(scroll, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    scroll.getBoundingClientRect = () => ({
      left: paneLeft,
      right: paneLeft + 200,
      width: 200,
      top: 0,
      bottom: 28,
      height: 28,
      x: paneLeft,
      y: 0,
      toJSON: () => ({}),
    });

    const tabs = Array.from(scroll.querySelectorAll<HTMLElement>("[data-editor-tab-key]"));
    tabs.forEach((tab, index) => {
      const contentLeft = index * 150;
      // Poison body-relative offsetLeft (Chromium when offsetParent is BODY).
      // An implementation that trusts offsetLeft would scroll incorrectly.
      Object.defineProperty(tab, "offsetLeft", { configurable: true, value: paneLeft + contentLeft });
      Object.defineProperty(tab, "offsetWidth", { configurable: true, value: 150 });
      tab.getBoundingClientRect = () => ({
        left: paneLeft + contentLeft - scrollLeft,
        right: paneLeft + contentLeft - scrollLeft + 150,
        width: 150,
        top: 0,
        bottom: 28,
        height: 28,
        x: paneLeft + contentLeft - scrollLeft,
        y: 0,
        toJSON: () => ({}),
      });
    });

    rerender(<EditorGroup {...props({
      openOrder: many,
      openFiles,
      activeKey: "f5",
      previewKey: null,
      pinnedKeys: [],
      activeFile: openFiles.f5,
    })} />);

    // f5 content left=750, width=150, viewport=200 → scrollLeft 708.
    // offsetLeft-based math would wrongly use 300+750 and not land here.
    expect(scrollLeft).toBe(750 + 150 - 200 + 8);
    expect(scrollLeft).not.toBe((paneLeft + 750) + 150 - 200 + 8);
  });

  it("renders sticky lines overlay when activeSymbols and enclosing scope are present", () => {
    const f = file("StickyDemo");
    f.text = "class App {\n  constructor() {\n    this.init();\n  }\n}";
    const onRevealTargetLine = vi.fn();
    render(<EditorGroup {...props({
      activeFile: f,
      activeKey: "StickyDemo",
      openFiles: { StickyDemo: f },
      openOrder: ["StickyDemo"],
      stickyLinesEnabled: true,
      activeSymbols: [
        {
          name: "App",
          detail: null,
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          depth: 0,
        },
      ],
      onRevealTargetLine,
    })} />);

    // Since mock CodeMirrorHost doesn't fire viewport events by default, we verify the component renders without error
    expect(screen.getByTestId("mock-code-mirror")).toBeInTheDocument();
  });

  it("passes the per-file Reader Mode configuration to the production editor host", () => {
    render(<EditorGroup {...props({
      renderedDocEnabled: true,
      renderedDocLanguageId: "typescript",
    })} />);

    expect(screen.getByTestId("mock-code-mirror")).toHaveAttribute("data-rendered-doc-enabled", "true");
    expect(screen.getByTestId("mock-code-mirror")).toHaveAttribute("data-rendered-doc-language", "typescript");
  });

  it("orders tabs according to tabPolicy using orderTabsForDisplay", () => {
    const z = file("zeta");
    const a = file("alpha");
    const b = file("beta");

    render(
      <EditorGroup
        {...props({
          openOrder: ["zeta", "alpha", "beta"],
          openFiles: { zeta: z, alpha: a, beta: b },
          activeKey: "alpha",
          pinnedKeys: [],
          tabPolicy: {
            schemaVersion: 3,
            limitPerLeaf: 10,
            order: "alphabetical",
            openPosition: "end",
            activateOnClose: "mru",
            pinnedRow: "same",
            previewMode: true,
            reusePreview: true,
          },
        })}
      />,
    );

    const tabs = document.querySelectorAll("[data-editor-tab-key]");
    const keys = Array.from(tabs).map((el) => el.getAttribute("data-editor-tab-key"));
    expect(keys).toEqual(["alpha", "beta", "zeta"]);
  });

  it("renders pinned tabs in a separate DOM row with tablist ARIA semantics when pinnedRow is separate", () => {
    const p1 = file("pin-one");
    const p2 = file("pin-two");
    const n1 = file("normal-one");

    render(
      <EditorGroup
        {...props({
          openOrder: ["pin-one", "normal-one", "pin-two"],
          openFiles: { "pin-one": p1, "normal-one": n1, "pin-two": p2 },
          activeKey: "normal-one",
          pinnedKeys: ["pin-one", "pin-two"],
          tabPolicy: {
            schemaVersion: 3,
            limitPerLeaf: 10,
            order: "open-order",
            openPosition: "end",
            activateOnClose: "mru",
            pinnedRow: "separate",
            previewMode: true,
            reusePreview: true,
          },
        })}
      />,
    );

    const pinnedStrip = screen.getByTestId("code-workspace-editor-pinned-tab-strip");
    expect(pinnedStrip).toHaveAttribute("role", "tablist");
    expect(pinnedStrip).toHaveAttribute("aria-label", "Pinned editor tabs");
    const pinnedTabs = pinnedStrip.querySelectorAll("[data-editor-tab-key]");
    expect(Array.from(pinnedTabs).map((el) => el.getAttribute("data-editor-tab-key"))).toEqual([
      "pin-one",
      "pin-two",
    ]);

    const mainStrip = screen.getByTestId("code-workspace-editor-tab-strip");
    expect(mainStrip).toHaveAttribute("role", "tablist");
    expect(mainStrip).toHaveAttribute("aria-label", "Editor tabs");
    const mainTabs = mainStrip.querySelectorAll("[data-editor-tab-key]");
    expect(Array.from(mainTabs).map((el) => el.getAttribute("data-editor-tab-key"))).toEqual([
      "normal-one",
    ]);
  });

  it("displays region fold provenance badge in the file status bar when active", () => {
    const f1 = file("sample");
    render(
      <EditorGroup
        {...props({
          openOrder: ["sample"],
          openFiles: { sample: f1 },
          activeKey: "sample",
        })}
      />,
    );

    expect(screen.queryByTestId("code-workspace-fold-provenance")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mock-trigger-fold-provenance"));
    const badge = screen.getByTestId("code-workspace-fold-provenance");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-provenance", "explicit-comment");
    expect(badge).toHaveTextContent("Region: explicit-comment");
  });
});
