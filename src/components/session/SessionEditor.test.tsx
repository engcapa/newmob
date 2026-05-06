import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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

function renderEditor(session?: ComponentProps<typeof SessionEditor>["session"]) {
  const onClose = vi.fn();
  render(<SessionEditor session={session} onClose={onClose} />);
  return { onClose };
}

function checkboxInLabel(text: string): HTMLInputElement {
  const input = screen.getByText(text).closest("label")?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Checkbox not found: ${text}`);
  return input;
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

  it("loads and preserves saved Advanced SSH options", async () => {
    const user = userEvent.setup();
    const session = {
      id: "ssh-1",
      name: "saved-prod",
      session_type: "SSH",
      group_path: null,
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      auth_method: "Agent" as const,
      options_json: JSON.stringify({
        x11: false,
        compression: true,
        startupCmd: "tmux new -A -s main",
        doNotExit: true,
        remoteEnv: "Interactive shell",
        sshBrowser: "Disabled",
        followPath: false,
        useJump: true,
        jumpHost: "bastion.example.com",
        jumpUser: "jump",
        jumpPort: "2222",
      }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(session);

    expect(checkboxInLabel("Use SSH compression (slow links)")).toBeChecked();
    expect(checkboxInLabel("Enable")).not.toBeChecked();
    expect(screen.getByLabelText("Execute command")).toHaveValue("tmux new -A -s main");
    expect(screen.getByLabelText("Do not exit after command ends")).toBeChecked();
    expect(screen.getByDisplayValue("Disabled")).toBeInTheDocument();
    expect(checkboxInLabel("Follow SSH path (experimental)")).not.toBeChecked();
    expect(checkboxInLabel("Enable jump host")).toBeChecked();
    expect(screen.getByDisplayValue("bastion.example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("jump")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2222")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OK" }));

    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      x11: false,
      compression: true,
      startupCmd: "tmux new -A -s main",
      doNotExit: true,
      sshBrowser: "Disabled",
      followPath: false,
      useJump: true,
      jumpHost: "bastion.example.com",
      jumpUser: "jump",
      jumpPort: "2222",
    });
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

  it("round-trips Network settings on save and load", async () => {
    const user = userEvent.setup();

    // First, save a session with custom network settings.
    const { onClose } = renderEditor();
    await user.type(screen.getByLabelText("Remote host"), "net.example.com");
    await user.click(screen.getByRole("button", { name: /network settings/i }));

    const proxySelect = screen.getByDisplayValue("None — direct connection");
    await user.selectOptions(proxySelect, "HTTP CONNECT");
    await user.type(screen.getByLabelText("Proxy host"), "proxy.corp");
    await user.type(screen.getByLabelText("Proxy port"), "3128");
    await user.type(screen.getByLabelText("Proxy username"), "alice");
    await user.type(screen.getByLabelText("Proxy password"), "s3cret");

    // Add a local forwarding row
    await user.type(screen.getByLabelText("New forward local address"), "127.0.0.1:5432");
    await user.type(screen.getByLabelText("New forward remote address"), "db.lan:5432");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const saved = ipcMocks.saveSession.mock.calls[0][0];
    const opts = JSON.parse(saved.options_json);
    expect(opts.networkSettings).toMatchObject({
      proxyKind: "http",
      proxyHost: "proxy.corp",
      proxyPort: "3128",
      proxyUser: "alice",
    });
    expect(opts.networkSettings.localForwards).toHaveLength(1);
    expect(opts.networkSettings.localForwards[0]).toMatchObject({
      local: "127.0.0.1:5432",
      remote: "db.lan:5432",
    });
    // Proxy password must NOT be persisted unless "Save in vault" was ticked.
    expect(opts.networkSettings.proxyPass).toBe("");

    // Now reopen the editor with the saved options and verify hydration.
    cleanup();
    ipcMocks.saveSession.mockClear();
    const reopened = {
      id: saved.id,
      name: saved.name,
      session_type: "SSH",
      group_path: null,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      auth_method: "Password" as const,
      options_json: saved.options_json,
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(reopened);
    await user.click(screen.getByRole("button", { name: /network settings/i }));
    expect(screen.getByDisplayValue("HTTP CONNECT")).toBeInTheDocument();
    expect(screen.getByDisplayValue("proxy.corp")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3128")).toBeInTheDocument();
    expect(screen.getByDisplayValue("127.0.0.1:5432")).toBeInTheDocument();
    expect(screen.getByDisplayValue("db.lan:5432")).toBeInTheDocument();
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

  it("persists edited Terminal settings for an existing session", async () => {
    const user = userEvent.setup();
    const session = {
      id: "existing-terminal-profile",
      name: "prod-shell",
      session_type: "SSH",
      group_path: null,
      host: "prod.example.com",
      port: 22,
      username: "root",
      auth_method: "Password" as const,
      options_json: JSON.stringify({
        compression: true,
        terminalProfile: {
          fontFamily: "Consolas, monospace",
          fontSize: 14,
          fontLigatures: false,
          theme: "classic",
          scrollback: 10000,
          cursorStyle: "block",
          cursorBlink: true,
          showScrollbar: true,
          copyOnSelect: false,
          rightClickBehavior: "menu",
          readOnly: false,
          bracketedPaste: true,
          multilinePasteConfirm: true,
          syntaxMode: "default",
          loggingEnabled: false,
        },
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: 20,
      sort_order: 0,
    };
    const { onClose } = renderEditor(session);

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByRole("button", { name: /use theme termius dark/i }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      id: "existing-terminal-profile",
      name: "prod-shell",
      host: "prod.example.com",
      username: "root",
      created_at: 10,
      last_connected_at: 20,
    });
    expect(savedOptions.compression).toBe(true);
    expect(savedOptions.terminalProfile).toMatchObject({
      fontSize: 18,
      theme: "termius-dark",
    });
    expect(savedOptions.terminalProfile.fontFamily).toContain("JetBrains Mono");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
