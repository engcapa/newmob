import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewJavaClassDialog } from "./NewJavaClassDialog";

describe("ED-TEMPLATE-001: NewJavaClassDialog", () => {
  afterEach(() => {
    cleanup();
  });

  const defaultProps = {
    open: true,
    targetDirectory: "/workspace/src/main/java/com/example/order",
    sourceRoots: ["/workspace/src/main/java"],
    existingFiles: ["/workspace/src/main/java/com/example/order/Existing.java"],
    projectFactsStatus: "ready",
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onOpenSettings: vi.fn(),
  };

  it("renders with title, kind selector, and derived package", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    expect(screen.getByTestId("new-java-class-dialog")).toBeInTheDocument();
    expect(screen.getByText("New Java Class")).toBeInTheDocument();
    expect(screen.getByTestId("new-java-class-package")).toHaveTextContent("com.example.order");
    expect(screen.getByTestId("new-java-class-submit")).toBeDisabled();
  });

  it("validates valid Java class name and enables submit (ED-TEMPLATE-001-A1)", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "OrderService" } });

    const submitBtn = screen.getByTestId("new-java-class-submit");
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);

    expect(defaultProps.onCreate).toHaveBeenCalledTimes(1);
    const plan = defaultProps.onCreate.mock.calls[0][0];
    expect(plan.valid).toBe(true);
    expect(plan.targetPath).toBe("/workspace/src/main/java/com/example/order/OrderService.java");
    expect(plan.className).toBe("OrderService");
    expect(plan.packageName).toBe("com.example.order");
    expect(plan.content).toContain("public class OrderService {");
  });

  it("creates Record template when selected in kind dropdown (ED-TEMPLATE-001-A1)", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "OrderRecord" } });

    const kindSelect = screen.getByTestId("new-java-class-kind-select");
    fireEvent.change(kindSelect, { target: { value: "record" } });

    const submitBtn = screen.getByTestId("new-java-class-submit");
    fireEvent.click(submitBtn);

    expect(defaultProps.onCreate).toHaveBeenCalled();
    const plan = defaultProps.onCreate.mock.calls[defaultProps.onCreate.mock.calls.length - 1][0];
    expect(plan.content).toContain("public record OrderRecord() {");
  });

  it("shows error and disables submit on invalid identifier (ED-TEMPLATE-001-A2)", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "class" } }); // reserved keyword

    expect(screen.getByTestId("new-java-class-error")).toHaveTextContent(
      "'class' is a reserved Java keyword",
    );
    expect(screen.getByTestId("new-java-class-submit")).toBeDisabled();
  });

  it("shows error and disables submit on file conflict (ED-TEMPLATE-001-A2)", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "Existing" } });

    expect(screen.getByTestId("new-java-class-error")).toHaveTextContent("File already exists");
    expect(screen.getByTestId("new-java-class-submit")).toBeDisabled();
  });

  it("shows facts status badge when project facts are not ready", () => {
    render(<NewJavaClassDialog {...defaultProps} projectFactsStatus="loading" />);

    expect(screen.getByTestId("new-java-class-facts-status")).toHaveTextContent(
      "Project facts not ready (loading)",
    );
    // Unready facts derive empty package
    expect(screen.getByTestId("new-java-class-package")).toHaveTextContent("(default package)");
  });

  it("closes on Escape and cancels without creation", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const dialog = screen.getByTestId("new-java-class-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("submits on Enter key when valid", () => {
    render(<NewJavaClassDialog {...defaultProps} />);

    const input = screen.getByTestId("new-java-class-name-input");
    fireEvent.change(input, { target: { value: "ValidClass" } });

    const dialog = screen.getByTestId("new-java-class-dialog");
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(defaultProps.onCreate).toHaveBeenCalled();
  });
});
