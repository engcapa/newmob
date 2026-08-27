import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsagesScopeDialog } from "./UsagesScopeDialog";

describe("UsagesScopeDialog", () => {
  afterEach(cleanup);

  it("does not render when open is false", () => {
    render(
      <UsagesScopeDialog
        open={false}
        symbolHint={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("usages-scope-dialog")).not.toBeInTheDocument();
  });

  it("renders with symbol hint and default toggles", () => {
    render(
      <UsagesScopeDialog
        open={true}
        symbolHint="MyClass.myMethod"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("usages-scope-dialog")).toBeInTheDocument();
    expect(screen.getByText("Symbol: MyClass.myMethod")).toBeInTheDocument();

    const decl = screen.getByTestId("usages-scope-declaration") as HTMLInputElement;
    const libs = screen.getByTestId("usages-scope-libraries") as HTMLInputElement;
    const tests = screen.getByTestId("usages-scope-tests") as HTMLInputElement;

    expect(decl.checked).toBe(true);
    expect(libs.checked).toBe(false);
    expect(tests.checked).toBe(true);
  });

  it("toggles options and confirms selection", () => {
    const onConfirm = vi.fn();
    render(
      <UsagesScopeDialog
        open={true}
        symbolHint={null}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const libs = screen.getByTestId("usages-scope-libraries");
    fireEvent.click(libs);

    const decl = screen.getByTestId("usages-scope-declaration");
    fireEvent.click(decl);

    fireEvent.click(screen.getByTestId("usages-scope-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({
      scope: "project",
      includeDeclaration: false,
      includeLibraries: true,
      includeTests: true,
    });
  });

  it("invokes onCancel on cancel button and backdrop click", () => {
    const onCancel = vi.fn();
    render(
      <UsagesScopeDialog
        open={true}
        symbolHint={null}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId("usages-scope-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("usages-scope-dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
