import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClipboardHistoryPopup } from "./ClipboardHistoryPopup";
import type { EditorClipboardSession } from "./workspaceClipboardSession";

function session(plainText: string, minutesAgo = 0): EditorClipboardSession {
  return {
    sessionId: `clip-${plainText}`,
    sourceViewId: "v1",
    segments: null,
    rectangular: false,
    plainText,
    sourceEol: "lf",
    createdAt: Date.now() - minutesAgo * 60_000,
  };
}

const multiSegment = (): EditorClipboardSession => ({
  ...session("second copy\nwith lines", 5),
  segments: ["a", "b"],
});

afterEach(cleanup);

describe("§8.19.5 ClipboardHistoryPopup", () => {
  const entries = [session("first copy"), multiSegment()];

  it("lists first line, segment count and age", () => {
    render(<ClipboardHistoryPopup open entries={entries} onPaste={() => {}} onDelete={() => {}} onClear={() => {}} onClose={() => {}} />);
    const first = screen.getByTestId("clipboard-history-entry-0");
    const second = screen.getByTestId("clipboard-history-entry-1");
    // First line only (never the whole multi-line payload).
    expect(first.textContent).toContain("first copy");
    expect(second.textContent).toContain("second copy");
    expect(second.textContent).not.toContain("with lines\n");
    expect(second.textContent).toContain("2 seg");
    expect(second.textContent).toContain("5m ago");
    expect(first.textContent).toContain("1 seg");
  });

  it("filters by query and shows the honest empty state", () => {
    render(<ClipboardHistoryPopup open entries={entries} onPaste={() => {}} onDelete={() => {}} onClear={() => {}} onClose={() => {}} />);
    fireEvent.input(screen.getByTestId("clipboard-history-search"), { target: { value: "first" } });
    expect(screen.getByTestId("clipboard-history-entry-0")).toBeTruthy();
    expect(screen.queryByTestId("clipboard-history-entry-1")).toBeNull();
    fireEvent.input(screen.getByTestId("clipboard-history-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("clipboard-history-empty").textContent).toContain("No entries match");
  });

  it("pastes via Enter at the selected entry and closes", () => {
    const onPaste = vi.fn();
    const onClose = vi.fn();
    render(<ClipboardHistoryPopup open entries={entries} onPaste={onPaste} onDelete={() => {}} onClear={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("clipboard-history-popup"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("clipboard-history-popup"), { key: "Enter" });
    expect(onPaste).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Delete removes a single entry; Clear needs confirmation", () => {
    const onDelete = vi.fn();
    const onClear = vi.fn();
    render(<ClipboardHistoryPopup open entries={entries} onPaste={() => {}} onDelete={onDelete} onClear={onClear} onClose={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("clipboard-history-popup"), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByTestId("clipboard-history-clear"));
    // Confirmation gate before anything is wiped.
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("clipboard-history-clear-abort"));
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("clipboard-history-clear"));
    fireEvent.click(screen.getByTestId("clipboard-history-clear-confirm"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("renders nothing when closed or empty", () => {
    const { container } = render(<ClipboardHistoryPopup open={false} entries={entries} onPaste={() => {}} onDelete={() => {}} onClear={() => {}} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
