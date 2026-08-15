import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DapAdapterGuideDialog } from "./DapAdapterGuideDialog";

afterEach(cleanup);

describe("DapAdapterGuideDialog", () => {
  it("renders nothing when open is false", () => {
    render(<DapAdapterGuideDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("dap-adapter-guide-dialog")).not.toBeInTheDocument();
  });

  it("renders adapter guide and switches language tabs", () => {
    const onClose = vi.fn();
    render(<DapAdapterGuideDialog open={true} onClose={onClose} initialLanguage="python" />);

    expect(screen.getByTestId("dap-adapter-guide-dialog")).toBeInTheDocument();
    expect(screen.getByText("Python / debugpy")).toBeInTheDocument();
    expect(screen.getByText(/pip install debugpy/)).toBeInTheDocument();

    // Switch to Go tab
    const goTab = screen.getByTestId("dap-tab-go");
    fireEvent.click(goTab);

    expect(screen.getByText("Go / Delve")).toBeInTheDocument();
    expect(screen.getByText(/go install github.com\/go-delve\/delve/)).toBeInTheDocument();
  });

  it("copies install command and config JSON", () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(<DapAdapterGuideDialog open={true} onClose={vi.fn()} initialLanguage="rust" />);

    const copyInstallBtn = screen.getByTestId("dap-copy-install-btn");
    fireEvent.click(copyInstallBtn);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining("sudo apt install lldb"));

    const copyConfigBtn = screen.getByTestId("dap-copy-config-btn");
    fireEvent.click(copyConfigBtn);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining("rust-debug"));
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<DapAdapterGuideDialog open={true} onClose={onClose} />);

    const closeBtn = screen.getByTestId("dap-guide-close-btn");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
