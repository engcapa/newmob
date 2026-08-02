import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpConnectionRequest } from "../../lib/servers";
import { RdpServerApprovalBridge } from "./RdpServerApprovalBridge";

const mocks = vi.hoisted(() => ({
  listener: null as ((request: RdpConnectionRequest) => void) | null,
  resolve: vi.fn(async () => true),
  unlisten: vi.fn(),
}));

vi.mock("../../lib/runtime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("../../lib/servers", () => ({
  listenRdpConnectionRequests: vi.fn(
    async (listener: (request: RdpConnectionRequest) => void) => {
      mocks.listener = listener;
      return mocks.unlisten;
    },
  ),
  resolveRdpConnectionRequest: mocks.resolve,
}));

describe("RdpServerApprovalBridge", () => {
  beforeEach(() => {
    mocks.listener = null;
    mocks.resolve.mockClear();
    mocks.unlisten.mockClear();
  });

  afterEach(() => cleanup());

  it("shows the peer and sends an explicit approval", async () => {
    render(<RdpServerApprovalBridge />);
    await waitFor(() => expect(mocks.listener).not.toBeNull());

    act(() => {
      mocks.listener?.({
        requestId: "approval-1",
        peer: "192.0.2.4:55000",
        timeoutSeconds: 30,
        expiresAt: Date.now() + 30_000,
      });
    });

    expect(screen.getByText(/192\.0\.2\.4:55000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow control" }));
    await waitFor(() =>
      expect(mocks.resolve).toHaveBeenCalledWith("approval-1", true),
    );
  });

  it("denies requests when the local deadline expires", async () => {
    vi.useFakeTimers();
    try {
      render(<RdpServerApprovalBridge />);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        mocks.listener?.({
          requestId: "approval-expired",
          peer: "192.0.2.5:55001",
          timeoutSeconds: 30,
          expiresAt: Date.now() + 100,
        });
      });
      act(() => vi.advanceTimersByTime(100));
      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.resolve).toHaveBeenCalledWith("approval-expired", false);
    } finally {
      vi.useRealTimers();
    }
  });
});
