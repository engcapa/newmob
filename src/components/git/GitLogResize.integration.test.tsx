import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitBlobPair, GitChange, GitLogEntry } from "../../lib/git";

// Explicitly unmock react-resizable-panels for this integration test
vi.unmock("react-resizable-panels");

import { CommitLog } from "./CommitLog";

const gitMocks = vi.hoisted(() => ({
  gitBlobPair: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
}));

vi.mock("../../lib/git", () => gitMocks);

class IntegrationResizeObserver {
  static observers: IntegrationResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    IntegrationResizeObserver.observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  disconnect() {
    this.targets.clear();
  }

  trigger() {
    const entries = Array.from(this.targets).map((target) => ({
      target,
      borderBoxSize: [{
        inlineSize: (target as HTMLElement).offsetWidth || 1200,
        blockSize: (target as HTMLElement).offsetHeight || 800,
      }],
      contentRect: target.getBoundingClientRect(),
    })) as unknown as ResizeObserverEntry[];
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

function commit(oid: string, subject = "Commit subject"): GitLogEntry {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: "Author",
    authorEmail: "author@example.com",
    date: "2026-09-06T10:00:00Z",
    subject,
    body: "Commit body details",
    refs: [],
  };
}

function change(path: string): GitChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: false,
    conflict: false,
  };
}

function pair(path: string, oldText = "line 1\nline 2\n", newText = "line 1 modified\nline 2\n"): GitBlobPair {
  return {
    path,
    oldPath: null,
    oldText,
    newText,
    oldExists: true,
    newExists: true,
    binary: false,
    image: false,
    oldImageB64: null,
    newImageB64: null,
    oversize: false,
    oldSize: oldText.length,
    newSize: newText.length,
  };
}

function setupElementGeometry(element: HTMLElement, width: number, height = 600) {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
  element.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

function prepareLogLayout(container: HTMLElement, totalWidth = 1200) {
  setupElementGeometry(container, totalWidth, 800);
  const groups = Array.from(container.querySelectorAll<HTMLElement>("[data-group]"));
  groups.forEach((group) => setupElementGeometry(group, totalWidth, 800));

  const panels = Array.from(container.querySelectorAll<HTMLElement>("[data-panel]"));
  panels.forEach((panel) => setupElementGeometry(panel, totalWidth / 2, 800));

  const editorDom = container.querySelector<HTMLElement>(".cm-mergeViewEditors");
  if (editorDom) {
    setupElementGeometry(editorDom, 700, 500);
    const editors = Array.from(container.querySelectorAll<HTMLElement>(".cm-mergeViewEditor > .cm-editor"));
    editors.forEach((editor) => setupElementGeometry(editor, (700 - 36) / 2, 500));
  }
  IntegrationResizeObserver.observers.forEach((obs) => obs.trigger());
  fireEvent(window, new Event("resize"));
}

function renderCommitLog() {
  return render(
    <CommitLog
      repoRoot="/test/repo"
      headOid="1111111111111111"
      busy={false}
      onContextMenu={vi.fn()}
    />,
  );
}

describe("GitLogResize integration (unmocked react-resizable-panels)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    IntegrationResizeObserver.observers = [];
    vi.stubGlobal("ResizeObserver", IntegrationResizeObserver);

    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitCommitFiles.mockReset();
    gitMocks.gitLog.mockReset();

    gitMocks.gitLog.mockResolvedValue([
      commit("1111111111111111", "First commit"),
      commit("2222222222222222", "Second commit"),
    ]);
    gitMocks.gitCommitFiles.mockResolvedValue([
      change("file-a.txt"),
      change("file-b.txt"),
    ]);
    gitMocks.gitBlobPair.mockImplementation(async (_repoRoot: string, path: string) => pair(path));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders unmocked Group, S3/S4 separators, and real DiffViewer S1 splitter", async () => {
    const { container } = renderCommitLog();

    // Wait for log entries to load
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());

    // Select the first commit
    fireEvent.click(screen.getByText("First commit"));
    await waitFor(() => expect(screen.getByText("file-a.txt")).toBeInTheDocument());

    // Select the first file
    fireEvent.click(screen.getByText("file-a.txt"));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());

    prepareLogLayout(container, 1200);

    // Verify S1, S3, S4 separators exist and are identifiable
    const s1 = screen.getByTestId("git-diff-splitter");
    const s3 = screen.getByTestId("git-log-list-resize-handle");
    const s4 = screen.getByTestId("git-log-files-resize-handle");

    expect(s1).toBeInTheDocument();
    expect(s3).toBeInTheDocument();
    expect(s4).toBeInTheDocument();

    // Verify s1 is inside diff viewer and s3/s4 are react-resizable-panels handles
    expect(s3).toHaveAttribute("data-separator");
    expect(s4).toHaveAttribute("data-separator");
    expect(s1).toHaveAttribute("role", "separator");
  });

  it("resizes S1 via pointer and keyboard without disrupting commit/file selection", async () => {
    const { container } = renderCommitLog();
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());
    fireEvent.click(screen.getByText("First commit"));
    await waitFor(() => expect(screen.getByText("file-a.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("file-a.txt"));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());

    prepareLogLayout(container, 1200);
    const s1 = screen.getByTestId("git-diff-splitter");

    // Test keyboard navigation on S1
    s1.focus();
    fireEvent.keyDown(s1, { key: "ArrowRight" });
    expect(s1).toHaveAttribute("aria-valuenow", "52");

    // S1 drag does not reset selected commit or file
    fireEvent.pointerDown(s1, { button: 0, pointerId: 1, clientX: 350, pointerType: "mouse", buttons: 1, isPrimary: true });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 420, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 420, pointerType: "mouse", buttons: 0, isPrimary: true });

    expect(screen.getByText("file-a.txt")).toBeInTheDocument();
    expect(screen.getByText("First commit")).toBeInTheDocument();

    // Switching file preserves ratio
    fireEvent.click(screen.getByText("file-b.txt"));
    await waitFor(() => expect(gitMocks.gitBlobPair).toHaveBeenCalledWith("/test/repo", "file-b.txt", expect.anything(), expect.anything(), null));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());
    prepareLogLayout(container, 1200);

    const s1Next = screen.getByTestId("git-diff-splitter");
    expect(Number(s1Next.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
  });

  it("closes commit hover popup immediately upon pointerdown on resize handles", async () => {
    const { container } = renderCommitLog();
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());
    fireEvent.click(screen.getByText("First commit"));
    await waitFor(() => expect(screen.getByText("file-a.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("file-a.txt"));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());

    prepareLogLayout(container, 1200);
    const commitRow = screen.getByText("First commit").closest("[data-testid='git-log-commit']")!;
    expect(commitRow).toBeTruthy();

    // Hover over commit to trigger popup
    fireEvent.mouseEnter(commitRow.parentElement!);
    await waitFor(() => expect(screen.getByTestId("commit-message-hover")).toBeInTheDocument());

    // Pointer down on S3 handle closes hover popup immediately
    const s3 = screen.getByTestId("git-log-list-resize-handle");
    fireEvent.pointerDown(s3, { button: 0, clientX: 300, clientY: 200 });

    await waitFor(() => expect(screen.queryByTestId("commit-message-hover")).not.toBeInTheDocument());
  });

  it("handles mode switches between Split and Unified while keeping layout ready", async () => {
    const { container } = renderCommitLog();
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());
    fireEvent.click(screen.getByText("First commit"));
    await waitFor(() => expect(screen.getByText("file-a.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("file-a.txt"));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());

    prepareLogLayout(container, 1200);
    const s1 = screen.getByTestId("git-diff-splitter");

    s1.focus();
    fireEvent.keyDown(s1, { key: "ArrowRight", shiftKey: true });
    expect(s1).toHaveAttribute("aria-valuenow", "60");

    // Switch to unified
    fireEvent.click(screen.getByTestId("git-diff-mode-unified"));
    await waitFor(() => expect(screen.queryByTestId("git-diff-splitter")).not.toBeInTheDocument());

    // Switch back to split
    fireEvent.click(screen.getByTestId("git-diff-mode-split"));
    await waitFor(() => expect(screen.getByTestId("git-diff-splitter")).toBeInTheDocument());

    prepareLogLayout(container, 1200);
    const restoredS1 = screen.getByTestId("git-diff-splitter");
    expect(restoredS1).toHaveAttribute("aria-valuenow", "60");
  });

  it("allows S3 and S4 handles to receive keyboard and focus independently of S1", async () => {
    const { container } = renderCommitLog();
    await waitFor(() => expect(screen.getByText("First commit")).toBeInTheDocument());
    fireEvent.click(screen.getByText("First commit"));
    await waitFor(() => expect(screen.getByText("file-a.txt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("file-a.txt"));
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());

    prepareLogLayout(container, 1200);

    const s1 = screen.getByTestId("git-diff-splitter");
    const s3 = screen.getByTestId("git-log-list-resize-handle");
    const s4 = screen.getByTestId("git-log-files-resize-handle");

    // S3 receives focus and handles keyboard
    s3.focus();
    expect(document.activeElement).toBe(s3);
    fireEvent.keyDown(s3, { key: "ArrowRight" });

    // S4 receives focus and handles keyboard
    s4.focus();
    expect(document.activeElement).toBe(s4);
    fireEvent.keyDown(s4, { key: "ArrowDown" });

    // S1 ratio unchanged by S3/S4 keyboard actions
    expect(s1).toHaveAttribute("aria-valuenow", "50");
  });
});
