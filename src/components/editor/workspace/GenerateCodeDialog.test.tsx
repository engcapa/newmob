import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GenerateCodeDialog } from "./GenerateCodeDialog";

const CANDIDATES = [
  { id: "0", title: "Generate Constructor", kind: "source.generate.constructor" },
  { id: "1", title: "Generate Getters and Setters", kind: "source.generate.getters.setters" },
];

afterEach(cleanup);

describe("§8.19.8 Generate Code dialog", () => {
  it("shows provider candidates with real titles and kinds; first is pre-checked", () => {
    render(<GenerateCodeDialog open phase="ready" candidates={CANDIDATES} onApply={() => {}} onRetry={() => {}} onCancel={() => {}} />);
    const first = screen.getByRole("checkbox", { name: "Generate Constructor" }) as HTMLInputElement;
    const second = screen.getByRole("checkbox", { name: "Generate Getters and Setters" }) as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    // Real member ids come from the provider, shown verbatim.
    expect(screen.getByText("source.generate.getters.setters")).toBeTruthy();
  });

  it("toggles checkboxes and applies the selected ids", () => {
    const onApply = vi.fn();
    render(<GenerateCodeDialog open phase="ready" candidates={CANDIDATES} onApply={onApply} onRetry={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Generate Getters and Setters" }));
    fireEvent.click(screen.getByTestId("generate-code-apply"));
    expect(onApply).toHaveBeenCalledWith(["0", "1"]);
  });

  it("renders the honest empty state when no provider actions exist", () => {
    render(<GenerateCodeDialog open phase="empty" candidates={[]} onApply={() => {}} onRetry={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("generate-code-empty").textContent).toContain("did not offer any generation actions");
    // Nothing can be generated without provider candidates.
    expect((screen.getByTestId("generate-code-apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open on failure with Retry and Cancel — no silent fallback", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(
      <GenerateCodeDialog
        open
        phase="error"
        candidates={CANDIDATES}
        error="resolve exploded"
        onApply={() => {}}
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByTestId("generate-code-error").textContent).toContain("resolve exploded");
    fireEvent.click(screen.getByTestId("generate-code-retry"));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("generate-code-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    // No candidate list is rendered in error phase (nothing was applied).
    expect(screen.queryByTestId("generate-code-candidates")).toBeNull();
  });

  it("disables interaction while running", () => {
    const onApply = vi.fn();
    render(<GenerateCodeDialog open phase="running" candidates={CANDIDATES} onApply={onApply} onRetry={() => {}} onCancel={() => {}} />);
    const apply = screen.getByTestId("generate-code-apply") as HTMLButtonElement;
    const cancelFooter = screen.getByTestId("generate-code-cancel-footer") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(cancelFooter.disabled).toBe(true);
    expect((screen.getByTestId("generate-code-candidates").firstChild as HTMLElement).className).toContain("opacity-60");
  });

  it("renders nothing when closed", () => {
    const { container } = render(<GenerateCodeDialog open={false} phase="ready" candidates={CANDIDATES} onApply={() => {}} onRetry={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
