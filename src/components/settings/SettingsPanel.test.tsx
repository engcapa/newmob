import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppThemeMode } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { SettingsPanel } from "./SettingsPanel";
import { resetSystemFontCacheForTests } from "../../lib/systemFonts";
import { openSettingsSection } from "../../lib/settingsNavigation";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  getAppProxyConfig: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

const CODE_VIEW_STORAGE_KEY = "taomni.codeViewProfile.v1";
const APP_THEME_STORAGE_KEY = "taomni.appTheme.v1";
const TERMINAL_DEFAULT_STORAGE_KEY = "taomni.terminalDefaultProfile.v1";

describe("SettingsPanel", () => {
  beforeEach(() => {
    resetSystemFontCacheForTests();
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Consolas", "JetBrains Mono", "Source Code Pro"]);
    ipcMocks.getAppProxyConfig.mockReset();
    ipcMocks.getAppProxyConfig.mockResolvedValue({
      enabled: false,
      mode: "manual",
      session_id: "",
      kind: "http",
      host: "",
      port: 3128,
      username: "",
      password_ref: "",
    });
    ipcMocks.listSessions.mockReset();
    ipcMocks.listSessions.mockResolvedValue([]);
    window.localStorage.clear();
    useAppStore.setState({ vaultUnlockMode: "startup", welcomeRecentSessionLimit: 20 });
    setAppThemeMode("system");
    // jsdom has no layout engine; search scroll-to-match calls this.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("defers the system font request until a font picker opens", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-general"));
    expect(ipcMocks.listSystemFonts).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("UI Font Family"));
    await waitFor(() => expect(ipcMocks.listSystemFonts).toHaveBeenCalledTimes(1));
  });

  afterEach(() => {
    cleanup();
  });

  it("exposes terminal defaults instead of legacy terminal appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-terminal"));
    expect(screen.queryByText("Terminal Appearance")).not.toBeInTheDocument();
    expect(screen.getByText("Terminal Defaults")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-appearance-settings")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-theme-select")).toBeInTheDocument();
  });

  it("persists the global application theme mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-general"));
    await user.click(screen.getByTestId("app-theme-select"));
    await user.click(screen.getByTestId("app-theme-dark"));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByTestId("app-theme-select"));
    await user.click(screen.getByTestId("app-theme-system"));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("system");
  });

  it("persists global UI typography settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-general"));
    // Select alternative UI font
    const fontSelect = screen.getByLabelText("UI Font Family");
    await user.click(fontSelect);
    await user.click(screen.getByRole("option", { name: "Outfit (Geometric Elegant)" }));
    expect(window.localStorage.getItem("taomni.uiFontFamily")).toContain("Outfit");

    // Slider for base size
    const sizeSlider = screen.getByLabelText("UI Base Font Size");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(sizeSlider, { target: { value: "16" } });
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("16");

    // Test Reset UI Font button
    const resetButton = screen.getByRole("button", { name: "Reset UI Font" });
    await user.click(resetButton);
    expect(window.localStorage.getItem("taomni.uiFontFamily")).toContain("Inter");
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("12");
  });

  it("persists code view appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-code"));
    const codeFontSelect = screen.getByLabelText("Code font");
    await user.click(codeFontSelect);
    await user.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
    const fontSize = screen.getByLabelText("Code font size");
    await user.clear(fontSize);
    await user.type(fontSize, "15");
    await user.click(screen.getByLabelText("Enable code font ligatures"));
    await user.click(screen.getByLabelText("Enable soft wrapping in the code editor"));
    await user.click(screen.getByTestId("code-theme-select"));
    await user.click(screen.getByTestId("code-theme-option-terminal-kanagawa-wave"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(CODE_VIEW_STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.fontSize).toBe(15);
      expect(saved.fontLigatures).toBe(false);
      expect(saved.softWrap).toBe(true);
      expect(saved.theme).toBe("terminal:kanagawa-wave");
    });
  }, 10_000);

  it("persists global terminal default behavior settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-terminal"));
    const terminalFontSelect = screen.getByLabelText("Terminal font");
    await user.click(terminalFontSelect);
    await user.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
    fireEvent.change(screen.getByLabelText("Scrollback lines"), { target: { value: "4321" } });
    await user.click(screen.getByLabelText("Read-only terminal"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(TERMINAL_DEFAULT_STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.scrollback).toBe(4321);
      expect(saved.readOnly).toBe(true);
    });
  });

  it("persists the welcome recent session history limit", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-general"));
    const input = screen.getByLabelText("Recent session history limit");
    fireEvent.change(input, { target: { value: "35" } });

    expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(35);
    expect(window.localStorage.getItem("taomni.welcomeRecentSessionLimit")).toBe("35");
  });

  it("persists the credential vault unlock prompt mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("settings-group-toggle-security"));
    expect(screen.getByTestId("vault-unlock-mode-startup")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByTestId("vault-unlock-mode-on-demand"));
    expect(useAppStore.getState().vaultUnlockMode).toBe("on-demand");
    expect(window.localStorage.getItem("taomni.vaultUnlockMode")).toBe("on-demand");
    expect(screen.getByTestId("vault-unlock-mode-on-demand")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByTestId("vault-unlock-mode-startup"));
    expect(useAppStore.getState().vaultUnlockMode).toBe("startup");
    expect(window.localStorage.getItem("taomni.vaultUnlockMode")).toBe("startup");
  });

  it("opens with all groups collapsed and titles visible", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    for (const id of ["general", "code", "database", "terminal", "security", "network", "ai"]) {
      expect(screen.getByTestId(`settings-group-${id}`)).toHaveAttribute("data-expanded", "false");
      expect(screen.getByTestId(`settings-group-body-${id}`)).not.toBeVisible();
    }
    expect(screen.queryByTestId("code-view-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-appearance-settings")).not.toBeInTheDocument();

    // Expanding a group reveals its body; title stays on the header either way.
    expect(screen.getByTestId("settings-group-toggle-terminal")).toHaveTextContent("Terminal");
    await user.click(screen.getByTestId("settings-group-toggle-terminal"));
    expect(screen.getByTestId("settings-group-terminal")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("settings-group-body-terminal")).toBeVisible();
    expect(screen.getByTestId("settings-group-toggle-terminal")).toHaveAttribute("aria-expanded", "true");
  });

  it("highlights settings matching the search query", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    const search = screen.getByTestId("settings-search-input");
    await user.type(search, "proxy");

    const proxy = container.querySelector('[data-search-id="app-proxy"]');
    const acp = container.querySelector('[data-search-id="ai-acp"]');
    const language = container.querySelector('[data-search-id="language"]');
    expect(proxy).toHaveAttribute("data-search-match", "true");
    expect(acp).toHaveAttribute("data-search-match", "true");
    expect(language).toHaveAttribute("data-search-match", "false");

    // Application Proxy and ACP proxy policy are separate searchable units.
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 2");
    // Matches span Network + AI groups.
    expect(screen.getByTestId("settings-search-group-count")).toHaveTextContent("2 groups");
    expect(screen.getByTestId("settings-group-network")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("settings-group-ai")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("settings-group-network")).toHaveAttribute("data-group-match", "true");
    expect(screen.getByTestId("settings-group-ai")).toHaveAttribute("data-group-match", "true");
    expect(screen.getByTestId("settings-group-general")).toHaveAttribute("data-group-match", "false");

    // Clearing the search (native type=search / Escape) drops the active state.
    await user.clear(search);
    expect(search).toHaveValue("");
    expect(
      container.querySelector('[data-search-id="app-proxy"]'),
    ).not.toHaveAttribute("data-search-match");
  });

  it("opens collapsed groups that contain search matches and supports prev/next", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    // Default is collapsed; search should still open the hit groups.
    expect(screen.getByTestId("settings-group-network")).toHaveAttribute("data-expanded", "false");
    expect(screen.getByTestId("settings-group-ai")).toHaveAttribute("data-expanded", "false");

    await user.type(screen.getByTestId("settings-search-input"), "proxy");

    expect(screen.getByTestId("settings-group-network")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("settings-group-ai")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 2");

    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("2 / 2");

    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 2");
  });

  it("highlights Codex settings from a codex search query", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "codex");

    const codex = container.querySelector('[data-search-id="ai-codex"]');
    const claude = container.querySelector('[data-search-id="ai-claude"]');
    expect(codex).toHaveAttribute("data-search-match", "true");
    expect(claude).toHaveAttribute("data-search-match", "false");
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 1");
  });

  it("finds SQL completion and shortcut settings", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "autocomplete");

    expect(container.querySelector('[data-search-id="sql-completion"]'))
      .toHaveAttribute("data-search-match", "true");
    expect(screen.getByTestId("sql-completion-settings")).toBeInTheDocument();
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 1");
  });

  it("finds SQL execution shortcut settings", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "run current");

    expect(container.querySelector('[data-search-id="sql-execution"]'))
      .toHaveAttribute("data-search-match", "true");
    expect(screen.getByTestId("sql-execution-settings")).toBeInTheDocument();
  });


  it("scrolls to the language servers section when deep-linked", async () => {
    openSettingsSection("language-servers");
    render(<SettingsPanel />);

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });

  it("shows an empty state when no setting matches", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "zzzznomatch");
    expect(screen.getByTestId("settings-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-search-count")).not.toBeInTheDocument();
  });
});
