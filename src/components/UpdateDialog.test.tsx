import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";
import { UpdateDialog } from "./UpdateDialog";

afterEach(cleanup);

describe("UpdateDialog SocksCap recovery authorization", () => {
  const authorizeInstall = vi.fn(async (_password: string) => undefined);
  const cancelAuthorization = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    useUpdateStore.setState({
      status: "authorizing",
      dialogOpen: true,
      os: "linux",
      authorizationBusy: false,
      authorizationError: null,
      authorizeInstall,
      cancelAuthorization,
    });
  });

  it("requests sudo in the updater and continues the pending installation", async () => {
    render(<UpdateDialog />);

    expect(screen.getByTestId("sockscap-root-prompt-dialog")).toHaveTextContent(
      "remove residual SocksCap nftables and cgroup state",
    );

    fireEvent.change(screen.getByTestId("sockscap-root-password-input"), {
      target: { value: "root-secret" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    await waitFor(() => {
      expect(authorizeInstall).toHaveBeenCalledWith("root-secret");
    });
  });

  it("returns to the update without navigating to SocksCap when authorization is cancelled", () => {
    render(<UpdateDialog />);

    fireEvent.click(screen.getByTestId("sockscap-root-prompt-cancel"));

    expect(cancelAuthorization).toHaveBeenCalledTimes(1);
  });
});
