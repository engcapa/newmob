import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpCaptureProbe, ServerConfig } from "../../../lib/servers";
import { RdpSettings } from "./RdpSettings";

const mocks = vi.hoisted(() => ({
  platform: "macos" as "macos" | "windows",
  probe: vi.fn<
    (requestCapture?: boolean, requestControl?: boolean) => Promise<RdpCaptureProbe>
  >(),
}));

vi.mock("../../../lib/runtime", () => ({
  getAppPlatform: () => mocks.platform,
}));

vi.mock("../../../lib/servers", () => ({
  probeRdpCapture: mocks.probe,
}));

const config: ServerConfig = {
  port: 3389,
  bindAddress: "127.0.0.1",
  autoStop: true,
  autoStopSeconds: 3600,
  startOnLaunch: false,
  viewOnly: false,
  requireControlApproval: true,
};

describe("RdpSettings macOS permissions", () => {
  beforeEach(() => {
    mocks.platform = "macos";
    mocks.probe.mockReset();
    mocks.probe.mockResolvedValue({
      permission: "granted",
      controlPermission: "denied",
      displays: [],
      summary: "ready",
    });
  });

  afterEach(() => cleanup());

  it("probes silently on mount and requests Accessibility independently", async () => {
    render(<RdpSettings config={config} onChange={vi.fn()} />);

    await waitFor(() => expect(mocks.probe).toHaveBeenCalledWith(false, false));
    fireEvent.click(screen.getByRole("button", { name: "Grant permission…" }));

    await waitFor(() => expect(mocks.probe).toHaveBeenCalledWith(false, true));
  });

  it("reports the Windows capture backend and exposes display selection", async () => {
    mocks.platform = "windows";
    mocks.probe.mockResolvedValue({
      permission: "notRequired",
      controlPermission: "notRequired",
      displays: [
        {
          id: "1",
          name: "Primary display",
          width: 1920,
          height: 1080,
          primary: true,
        },
      ],
      summary: "Windows: Windows Graphics Capture with GDI compatibility fallback",
    });

    render(<RdpSettings config={config} onChange={vi.fn()} />);

    await waitFor(() => expect(mocks.probe).toHaveBeenCalledWith(false, false));
    expect(screen.getByText(/Windows Graphics Capture \(WGC\)/)).toBeInTheDocument();
    expect(screen.queryByText(/not implemented/i)).not.toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: /Primary display.*1920×1080/ }),
    ).toBeInTheDocument();
  });
});
