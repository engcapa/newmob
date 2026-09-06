import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { GitBlobPair } from "../../lib/git";
import { DiffViewer } from "./DiffViewer";

function pair(oldText: string, newText: string, path = "src/a.ts"): GitBlobPair {
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

class TestResizeObserver {
  static observers: TestResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.observers.push(this);
  }

  observe() {}

  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setWidth(element: HTMLElement, width: number) {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  element.getBoundingClientRect = () => ({
    width,
    height: 400,
    top: 0,
    right: width,
    bottom: 400,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

function prepareDimensions(container: HTMLElement, width = 1000) {
  const editorDom = container.querySelector<HTMLElement>(".cm-mergeViewEditors");
  expect(editorDom).toBeTruthy();
  setWidth(editorDom!, width);
  const editors = Array.from(container.querySelectorAll<HTMLElement>(".cm-mergeViewEditor > .cm-editor"));
  editors.forEach((editor) => setWidth(editor, Math.max(1, (width - 36) / 2)));
  fireEvent(window, new Event("resize"));
  return {
    editorDom: editorDom!,
    editors,
    splitter: screen.getByTestId("git-diff-splitter"),
    leftScroll: screen.getByTestId("git-diff-left-scroll"),
    rightScroll: screen.getByTestId("git-diff-right-scroll"),
  };
}

function wrapperWidths(editorDom: HTMLElement): [number, number] {
  const wrappers = Array.from(editorDom.querySelectorAll<HTMLElement>(".cm-mergeViewEditor"));
  return wrappers.map((wrapper) => Number.parseFloat(wrapper.style.width)).slice(0, 2) as [number, number];
}

async function renderReady(value: GitBlobPair, props: Partial<React.ComponentProps<typeof DiffViewer>> = {}) {
  const result = render(<DiffViewer pair={value} {...props} />);
  await waitFor(() => expect(result.container.querySelector(".cm-mergeViewEditors")).toBeTruthy());
  return result;
}

describe("DiffViewer split viewport behavior", () => {
  beforeEach(() => {
    window.localStorage.clear();
    TestResizeObserver.observers = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("resizes panes continuously and resets with double click without rebuilding editors", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container);
    const beforeViews = Array.from(container.querySelectorAll<HTMLElement>(".cm-editor")).map((dom) => EditorView.findFromDOM(dom));
    const initial = wrapperWidths(editorDom);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 1, clientX: 500, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 700, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 700, isPrimary: true });

    const resized = wrapperWidths(editorDom);
    expect(resized[0]).toBeGreaterThan(initial[0]);
    expect(resized[1]).toBeLessThan(initial[1]);
    expect(resized[0] + resized[1]).toBeCloseTo(964, 4);
    expect(Number(splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
    expect(Array.from(container.querySelectorAll<HTMLElement>(".cm-editor")).map((dom) => EditorView.findFromDOM(dom))).toEqual(beforeViews);

    fireEvent.doubleClick(splitter);
    const reset = wrapperWidths(editorDom);
    expect(reset[0]).toBeCloseTo(reset[1], 4);
    expect(splitter).toHaveAttribute("aria-valuenow", "50");
  });

  it("supports keyboard resize steps, bounds, and Enter reset", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container);
    splitter.focus();

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "52");
    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    expect(splitter).toHaveAttribute("aria-valuenow", "62");
    fireEvent.keyDown(splitter, { key: "Home" });
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(160, 4);
    fireEvent.keyDown(splitter, { key: "End" });
    expect(wrapperWidths(editorDom)[1]).toBeCloseTo(160, 4);
    fireEvent.keyDown(splitter, { key: "Enter" });
    expect(splitter).toHaveAttribute("aria-valuenow", "50");
  });

  it("clamps pane widths and disables input below the minimum content width", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);
    splitter.focus();
    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    const preferred = splitter.getAttribute("aria-valuenow");

    setWidth(editorDom, 300);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(132, 4);
    expect(wrapperWidths(editorDom)[1]).toBeCloseTo(132, 4);
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "50");
    expect(splitter).not.toHaveAttribute("aria-valuenow", preferred);

    setWidth(editorDom, 1000);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-disabled", "false");
    expect(splitter.getAttribute("aria-valuenow")).toBe(preferred);
  });

  it.each([
    ["Escape", "keydown"],
    ["pointercancel", "pointercancel"],
    ["window blur", "blur"],
  ])("cancels a drag with %s and restores its previous ratio", async (label, eventType) => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container);
    const before = wrapperWidths(editorDom);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 2, clientX: 500, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 2, clientX: 720, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (eventType === "keydown") fireEvent.keyDown(splitter, { key: label });
    else if (eventType === "pointercancel") fireEvent.pointerCancel(splitter, { pointerId: 2, isPrimary: true });
    else fireEvent(window, new Event("blur"));

    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(before[0], 4);
    expect(wrapperWidths(editorDom)[1]).toBeCloseTo(before[1], 4);
    expect(document.body.style.userSelect).toBe("");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "52");
  });

  it("keeps separate instance ratios and horizontal scroll positions", async () => {
    const first = pair("before one\n", "after one\n", "src/one.ts");
    const second = pair("before two\n", "after two\n", "src/two.ts");
    const { container } = render(
      <>
        <DiffViewer pair={first} />
        <DiffViewer pair={second} />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll("[data-testid='git-diff-splitter']")).toHaveLength(2));
    const editors = Array.from(container.querySelectorAll<HTMLElement>(".cm-mergeViewEditors"));
    editors.forEach((editorDom) => setWidth(editorDom, 1000));
    Array.from(container.querySelectorAll<HTMLElement>(".cm-editor")).forEach((editor) => setWidth(editor, 482));
    fireEvent(window, new Event("resize"));

    const splitters = screen.getAllByTestId("git-diff-splitter");
    fireEvent.keyDown(splitters[0], { key: "ArrowRight" });
    expect(splitters[0]).toHaveAttribute("aria-valuenow", "52");
    expect(splitters[1]).toHaveAttribute("aria-valuenow", "50");

    const scrolls = screen.getAllByTestId("git-diff-right-scroll");
    const leftScrolls = screen.getAllByTestId("git-diff-left-scroll");
    scrolls[0].scrollLeft = 100;
    scrolls[1].scrollLeft = 200;
    fireEvent.scroll(leftScrolls[0]);
    expect(scrolls[0].scrollLeft).toBe(100);
    expect(scrolls[1].scrollLeft).toBe(200);
  });

  it("zeros both scroll origins after creation and cancels a pending correction on wheel", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, leftScroll, rightScroll } = prepareDimensions(container);
    leftScroll.scrollLeft = 80;
    rightScroll.scrollLeft = 120;
    fireEvent(window, new Event("resize"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(leftScroll.scrollLeft).toBe(0);
    expect(rightScroll.scrollLeft).toBe(0);

    setWidth(editorDom, 1001);
    leftScroll.scrollLeft = 80;
    rightScroll.scrollLeft = 120;
    fireEvent(window, new Event("resize"));
    fireEvent.wheel(rightScroll);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(leftScroll.scrollLeft).toBe(80);
    expect(rightScroll.scrollLeft).toBe(120);
  });

  it("navigates to a changed line start and then zeros both split scrollbars", async () => {
    const oldLines = Array.from({ length: 40 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}-${"x".repeat(1800)}`);
    const newLines = oldLines.slice();
    newLines[19] = `${newLines[19].slice(0, 1700)}A${newLines[19].slice(1701)}`;
    newLines[29] = `${newLines[29].slice(0, 1700)}B${newLines[29].slice(1701)}`;
    const { container } = await renderReady(pair(oldLines.join("\n"), newLines.join("\n"), "src/long.ts"));
    const { leftScroll, rightScroll } = prepareDimensions(container);
    await waitFor(() => expect(screen.getByTestId("git-diff-next")).not.toBeDisabled());
    leftScroll.scrollLeft = 150;
    rightScroll.scrollLeft = 170;
    fireEvent.click(screen.getByTestId("git-diff-next"));
    expect(leftScroll.scrollLeft).toBe(0);
    expect(rightScroll.scrollLeft).toBe(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const rightView = EditorView.findFromDOM(container.querySelector<HTMLElement>("[data-testid='git-diff-right-scroll']")!.closest(".cm-editor")!);
    expect(rightView).toBeTruthy();
    const anchor = rightView!.state.selection.main.anchor;
    expect(anchor).toBe(rightView!.state.doc.lineAt(anchor).from);
    expect(rightView!.state.doc.lineAt(anchor).text).toContain("line-20");
    expect(leftScroll.scrollLeft).toBe(0);
    expect(rightScroll.scrollLeft).toBe(0);
  });

  it("preserves an editable right editor and saves after resizing", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderReady(pair("before\n", "after\n"), {
      worktreeEditable: true,
      onSaveWorktree: onSave,
    });
    const { editorDom, splitter } = prepareDimensions(container);
    const editors = Array.from(container.querySelectorAll<HTMLElement>(".cm-editor"));
    const rightView = EditorView.findFromDOM(editors[editors.length - 1]);
    expect(rightView).toBeTruthy();
    rightView!.dispatch({ changes: { from: 0, to: rightView!.state.doc.length, insert: "edited\n" } });
    await waitFor(() => expect(screen.getByTestId("git-diff-save-worktree")).not.toBeDisabled());

    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    fireEvent.doubleClick(splitter);
    expect(EditorView.findFromDOM(editors[editors.length - 1])).toBe(rightView);
    expect(rightView!.state.doc.toString()).toBe("edited\n");
    fireEvent.click(screen.getByTestId("git-diff-save-worktree"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("edited\n"));
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(wrapperWidths(editorDom)[1], 4);
  });

  it("retains the preferred split ratio through Unified and Split", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const first = prepareDimensions(container).splitter;
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(first).toHaveAttribute("aria-valuenow", "52");

    fireEvent.click(screen.getByTestId("git-diff-mode-unified"));
    await waitFor(() => expect(screen.queryByTestId("git-diff-splitter")).not.toBeInTheDocument());
    expect(screen.getByTestId("git-diff-right-scroll")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("git-diff-mode-split"));
    await waitFor(() => expect(screen.getByTestId("git-diff-splitter")).toBeInTheDocument());
    const next = prepareDimensions(container).splitter;
    expect(next).toHaveAttribute("aria-valuenow", "52");
  });

  it("recreates the editor when loading finishes with the same pair reference", async () => {
    const value = pair("before\n", "after\n");
    const { container, rerender } = render(<DiffViewer pair={value} loading />);
    expect(container.querySelector(".taomni-diff-host")).not.toBeInTheDocument();
    rerender(<DiffViewer pair={value} loading={false} />);
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());
    rerender(<DiffViewer pair={value} loading />);
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).not.toBeInTheDocument());
    rerender(<DiffViewer pair={value} loading={false} />);
    await waitFor(() => expect(container.querySelector(".cm-mergeViewEditors")).toBeTruthy());
  });

  it("does not mount a splitter for binary, image, or oversize pairs", () => {
    const binary = { ...pair("", ""), binary: true };
    const { rerender } = render(<DiffViewer pair={binary} />);
    expect(screen.queryByTestId("git-diff-splitter")).not.toBeInTheDocument();
    rerender(<DiffViewer pair={{ ...pair("", ""), image: true }} />);
    expect(screen.queryByTestId("git-diff-splitter")).not.toBeInTheDocument();
    rerender(<DiffViewer pair={{ ...pair("", ""), oversize: true }} />);
    expect(screen.queryByTestId("git-diff-splitter")).not.toBeInTheDocument();
  });

  it("handles window fallback and captures drag when setPointerCapture throws", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);
    const beforeViews = Array.from(container.querySelectorAll<HTMLElement>(".cm-editor")).map((dom) => EditorView.findFromDOM(dom));

    splitter.setPointerCapture = vi.fn().mockImplementation(() => {
      throw new Error("Pointer capture unavailable");
    });

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 10, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(window, { pointerId: 10, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.pointerUp(window, { pointerId: 10, clientX: 620, pointerType: "mouse", buttons: 0, isPrimary: true });

    const widths = wrapperWidths(editorDom);
    expect(widths[0]).toBeCloseTo(602, 1);
    expect(widths[1]).toBeCloseTo(362, 1);
    expect(widths[0] + widths[1]).toBeCloseTo(964, 4);
    expect(document.body.style.cursor).toBe("");
    expect(Array.from(container.querySelectorAll<HTMLElement>(".cm-editor")).map((dom) => EditorView.findFromDOM(dom))).toEqual(beforeViews);
  });

  it("terminates and reverts drag when mouse pointermove has buttons === 0", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);
    const initial = wrapperWidths(editorDom);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 11, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 11, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Lost release: mouse pointermove arrives with buttons === 0
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 650, pointerType: "mouse", buttons: 0, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const reverted = wrapperWidths(editorDom);
    expect(reverted[0]).toBeCloseTo(initial[0], 4);
    expect(reverted[1]).toBeCloseTo(initial[1], 4);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // Further pointermove does not change widths
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 700, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(initial[0], 4);
  });

  it("cancels drag on lostpointercapture and restores initial ratio idempotently", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);
    const initial = wrapperWidths(editorDom);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 12, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 12, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    fireEvent(splitter, new Event("lostpointercapture"));

    const reverted = wrapperWidths(editorDom);
    expect(reverted[0]).toBeCloseTo(initial[0], 4);
    expect(reverted[1]).toBeCloseTo(initial[1], 4);
    expect(document.body.style.cursor).toBe("");

    // Multiple lostpointercapture or up events are no-ops
    fireEvent(splitter, new Event("lostpointercapture"));
    fireEvent.pointerUp(splitter, { pointerId: 12, clientX: 620, pointerType: "mouse", buttons: 0, isPrimary: true });
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(initial[0], 4);
  });

  it("ignores pointer events from non-current pointer IDs during drag", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 20, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });

    // Non-current pointer move should be ignored
    fireEvent.pointerMove(window, { pointerId: 99, clientX: 700, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(482, 1);

    // Non-current pointer up should not cancel or commit the drag
    fireEvent.pointerUp(window, { pointerId: 99, clientX: 700, pointerType: "mouse", buttons: 0, isPrimary: true });
    expect(document.body.style.cursor).toBe("col-resize");

    // Primary pointer finishes
    fireEvent.pointerMove(window, { pointerId: 20, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.pointerUp(window, { pointerId: 20, clientX: 620, pointerType: "mouse", buttons: 0, isPrimary: true });

    expect(wrapperWidths(editorDom)[0]).toBeCloseTo(602, 1);
  });

  it("cancels active drag when container width changes during drag", async () => {
    const { container } = await renderReady(pair("before\n", "after\n"));
    const { editorDom, splitter } = prepareDimensions(container, 1000);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 30, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 30, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Container width shifts during drag
    setWidth(editorDom, 800);
    fireEvent(window, new Event("resize"));

    expect(document.body.style.cursor).toBe("");
    // Widths now conform to 800px with initial 50:50 ratio
    const widths = wrapperWidths(editorDom);
    expect(widths[0]).toBeCloseTo((800 - 36) / 2, 1);
    expect(widths[1]).toBeCloseTo((800 - 36) / 2, 1);
  });

  it("cleans up pending animation frame and document styles when unmounted during drag", async () => {
    const { container, unmount } = await renderReady(pair("before\n", "after\n"));
    const { splitter } = prepareDimensions(container, 1000);

    fireEvent.pointerDown(splitter, { button: 0, pointerId: 40, clientX: 500, pointerType: "mouse", buttons: 1, isPrimary: true });
    fireEvent.pointerMove(splitter, { pointerId: 40, clientX: 620, pointerType: "mouse", buttons: 1, isPrimary: true });
    expect(document.body.style.cursor).toBe("col-resize");

    unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
