import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEditor } from "./SessionEditor";

const ipcMocks = vi.hoisted(() => ({
  testSshConnection: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  markSessionConnected: vi.fn(),
  listSessionGroups: vi.fn(),
  saveSessionGroup: vi.fn(),
  deleteSessionGroup: vi.fn(),
  listSystemFonts: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

function renderEditor() {
  const onClose = vi.fn();
  render(<SessionEditor onClose={onClose} />);
  return { onClose };
}

describe("SessionEditor SSH settings tabs", () => {
  beforeEach(() => {
    Object.values(ipcMocks).forEach((mock) => mock.mockReset());
    window.localStorage.clear();
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.saveSession.mockResolvedValue(undefined);
    ipcMocks.deleteSession.mockResolvedValue(undefined);
    ipcMocks.saveSessionGroup.mockResolvedValue(undefined);
    ipcMocks.testSshConnection.mockResolvedValue("Connection successful");
    ipcMocks.listSystemFonts.mockResolvedValue(["Consolas", "JetBrains Mono", "Source Code Pro"]);
  });

  afterEach(() => {
    cleanup();
  });

  it("switches between all SSH settings sections", async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByTestId("advanced-ssh-settings")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));
    expect(screen.getByTestId("terminal-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("advanced-ssh-settings")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /network settings/i }));
    expect(screen.getByTestId("network-settings")).toBeInTheDocument();
    expect(screen.getByText("Local port forwarding")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /bookmark settings/i }));
    expect(screen.getByTestId("bookmark-settings")).toBeInTheDocument();
    expect(screen.getByLabelText("Session name")).toBeInTheDocument();
  });

  it("keeps Advanced SSH authentication controls interactive from label clicks", async () => {
    const user = userEvent.setup();
    renderEditor();

    const keyPath = screen.getByLabelText("Private key path");
    expect(keyPath).toBeDisabled();

    await user.click(screen.getByText("Use private key"));
    expect(keyPath).toBeEnabled();

    await user.type(keyPath, "~/.ssh/id_ed25519");
    expect(keyPath).toHaveValue("~/.ssh/id_ed25519");

    await user.click(screen.getByText("Password / keyboard-interactive"));
    expect(keyPath).toBeDisabled();

    const doNotExit = screen.getByLabelText("Do not exit after command ends");
    expect(doNotExit).not.toBeChecked();
    await user.click(screen.getByText("Do not exit after command ends"));
    expect(doNotExit).toBeChecked();
  });

  it("updates Terminal settings preview and numeric fields", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    await waitFor(() => expect(screen.getByRole("option", { name: "Source Code Pro" })).toBeInTheDocument());
    expect(screen.getByLabelText("Terminal font")).toHaveValue("Source Code Pro");

    const background = screen.getByLabelText("Terminal background hex");
    await user.clear(background);
    await user.type(background, "#123456");
    expect(screen.getByTestId("terminal-preview")).toHaveStyle({ background: "#123456" });

    const foreground = screen.getByLabelText("Terminal foreground hex");
    await user.clear(foreground);
    await user.type(foreground, "#fedcba");
    expect(screen.getByTestId("terminal-preview")).toHaveStyle({ color: "#fedcba" });

    const scrollback = screen.getByLabelText("Scrollback lines");
    await user.clear(scrollback);
    await user.type(scrollback, "20000");
    expect(scrollback).toHaveValue("20000");
  });

  it("adds and removes Network local port forwarding rows", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /network settings/i }));

    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();

    await user.type(screen.getByLabelText("New forward local address"), "127.0.0.1:9090");
    await user.type(screen.getByLabelText("New forward remote address"), "metrics.lan:9090");
    await user.type(screen.getByLabelText("New forward description"), "Metrics");
    expect(add).toBeEnabled();

    await user.click(add);
    expect(screen.getByDisplayValue("127.0.0.1:9090")).toBeInTheDocument();
    expect(screen.getByDisplayValue("metrics.lan:9090")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Metrics")).toBeInTheDocument();
    expect(screen.getByLabelText("New forward local address")).toHaveValue("");

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await user.click(removeButtons[removeButtons.length - 1]);
    expect(screen.queryByDisplayValue("127.0.0.1:9090")).not.toBeInTheDocument();
  });

  it("persists Bookmark settings through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "prod.example.com");
    await user.click(screen.getByRole("button", { name: /bookmark settings/i }));

    await user.type(screen.getByLabelText("Session name"), "prod-web");
    await user.selectOptions(screen.getByDisplayValue("User sessions"), "User sessions / Production");
    await user.type(screen.getByLabelText("Description notes"), "Primary production host");
    await user.type(screen.getByLabelText("Tags"), "prod,web");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(savedConfig).toMatchObject({
      name: "prod-web",
      session_type: "SSH",
      group_path: "User sessions / Production",
      host: "prod.example.com",
      port: 22,
    });
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      description: "Primary production host",
      tags: "prod,web",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Terminal settings through the session store save path", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "dev.example.com");
    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "12");
    const scrollback = screen.getByLabelText("Scrollback lines");
    await user.clear(scrollback);
    await user.type(scrollback, "20000");
    await user.click(screen.getByLabelText("Save scrollback to log file on disconnect"));
    await user.click(screen.getByLabelText("Enable keyword highlighting"));
    await user.selectOptions(screen.getByLabelText("Terminal cursor"), "Vertical bar (steady)");

    await user.click(screen.getByRole("button", { name: "OK" }));

    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(JSON.parse(savedConfig.options_json).terminalProfile).toMatchObject({
      fontSize: 12,
      scrollback: 20000,
      loggingEnabled: true,
      syntaxMode: "keywords",
      cursorStyle: "bar",
      cursorBlink: false,
    });
    expect(JSON.parse(savedConfig.options_json).terminalProfile.fontFamily).toContain("JetBrains Mono");
  });
});
