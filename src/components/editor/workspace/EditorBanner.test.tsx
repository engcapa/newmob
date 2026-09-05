import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorBanner } from "./EditorBanner";
import { editorBannerDismissalKey, type EditorBannerItem } from "./editorBannerModel";

afterEach(() => {
  cleanup();
});

describe("EditorBanner", () => {
  it("renders nothing when banner list is empty", () => {
    const { container } = render(<EditorBanner banners={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banners, triggers actions and dismiss callback", () => {
    const handleRun = vi.fn();
    const handleDismiss = vi.fn();

    const banners: EditorBannerItem[] = [
      {
        id: "b-ro",
        category: "read-only",
        severity: "info",
        title: "File is read-only",
        description: "Modifications cannot be saved directly.",
        priority: 100,
        conditionGeneration: "g1",
        actions: [
          {
            id: "unlock",
            label: "Unlock",
            primary: true,
            run: handleRun,
          },
        ],
        createdAt: 100,
      },
    ];

    render(<EditorBanner banners={banners} onDismiss={handleDismiss} />);

    expect(screen.getByTestId("code-workspace-banner-b-ro")).toBeTruthy();
    expect(screen.getByText("File is read-only")).toBeTruthy();
    expect(screen.getByText("Modifications cannot be saved directly.")).toBeTruthy();

    const actionBtn = screen.getByTestId("banner-action-unlock");
    fireEvent.click(actionBtn);
    expect(handleRun).toHaveBeenCalledTimes(1);

    const dismissBtn = screen.getByTestId("banner-dismiss-b-ro");
    fireEvent.click(dismissBtn);
    expect(handleDismiss).toHaveBeenCalledWith(editorBannerDismissalKey(banners[0]!));
  });

  it("keeps an asynchronous action failure visible and retryable", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce(undefined);
    const banner: EditorBannerItem = {
      id: "b-lsp",
      category: "indexing-degraded",
      severity: "warning",
      title: "Language Server Degraded",
      priority: 60,
      conditionGeneration: "provider-1",
      actions: [{ id: "configure", label: "Configure", run, primary: true }],
      createdAt: 1,
    };

    render(<EditorBanner banners={[banner]} onDismiss={vi.fn()} />);

    const action = screen.getByTestId("banner-action-configure");
    fireEvent.click(action);
    await waitFor(() => expect(screen.getByTestId("banner-action-error-configure")).toHaveTextContent(
      "Configure failed: settings unavailable",
    ));
    expect(screen.getByTestId("code-workspace-banner-b-lsp")).toBeInTheDocument();
    expect(action).not.toBeDisabled();

    fireEvent.click(action);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("banner-action-error-configure")).toBeNull();
  });
});
