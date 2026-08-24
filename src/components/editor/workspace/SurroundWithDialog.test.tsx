import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SurroundWithDialog } from "./SurroundWithDialog";

afterEach(cleanup);

describe("§8.19.8 Surround With dialog", () => {
  it("lists only adapter kinds for the active language", () => {
    render(
      <SurroundWithDialog open languageId="java" onClose={() => {}} onPick={() => {}} />,
    );
    // Java batch: if/while/try-catch/synchronized/Runnable.
    expect(screen.getByTestId("surround-with-kind-if")).toBeTruthy();
    expect(screen.getByTestId("surround-with-kind-while")).toBeTruthy();
    expect(screen.getByTestId("surround-with-kind-try-catch")).toBeTruthy();
    expect(screen.getByTestId("surround-with-kind-synchronized")).toBeTruthy();
    expect(screen.getByTestId("surround-with-kind-runnable")).toBeTruthy();
    // Honest provenance: kinds are labelled templates up front.
    expect(screen.getAllByText("template").length).toBe(5);
  });

  it("hides every kind for languages outside the adapter", () => {
    render(
      <SurroundWithDialog open languageId="python" onClose={() => {}} onPick={() => {}} />,
    );
    expect(screen.getByTestId("surround-with-empty")).toBeTruthy();
    expect(screen.queryByTestId("surround-with-kind-if")).toBeNull();
  });

  it("applies through onPick with Enter and closes", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SurroundWithDialog open languageId="java" onClose={onClose} onPick={onPick} />);
    const listbox = screen.getByTestId("surround-with-kinds");
    fireEvent.keyDown(listbox.closest('[data-testid="surround-with-dialog"]')!, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("if");
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(listbox.closest('[data-testid="surround-with-dialog"]')!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("picks a specific kind by click", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SurroundWithDialog open languageId="java" onClose={onClose} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("surround-with-kind-runnable"));
    expect(onPick).toHaveBeenCalledWith("runnable");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SurroundWithDialog open={false} languageId="java" onClose={() => {}} onPick={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
