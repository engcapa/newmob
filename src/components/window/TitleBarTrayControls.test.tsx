import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBarTrayControls } from "./TitleBarTrayControls";

const mocks = vi.hoisted(() => ({
  theme: {
    mode: "dark" as const,
    resolvedTheme: "dark" as const,
    setMode: vi.fn(),
  },
  app: {
    terminalSplitActive: false,
    multiExecActive: false,
    toggleTerminalSplit: vi.fn(),
    toggleMultiExec: vi.fn(),
  },
}));

vi.mock("../../lib/appTheme", () => ({
  useAppTheme: () => mocks.theme,
}));

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (state: typeof mocks.app) => unknown) => selector(mocks.app),
}));

vi.mock("../../stores/aiStore", () => ({
  useAiStore: (selector: (state: { config: { fully_disabled: boolean } }) => unknown) =>
    selector({ config: { fully_disabled: true } }),
}));

vi.mock("../../lib/i18n/labels", () => ({
  useAppThemeI18nLabel: () => (mode: string) => mode,
}));

vi.mock("./PttButton", () => ({
  PttButton: () => <button type="button" data-testid="ptt-button" />,
}));

vi.mock("./LanguageSwitcher", () => ({
  LanguageSwitcher: () => <button type="button" data-testid="language-switcher" />,
}));

describe("TitleBarTrayControls responsive layout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    });
    mocks.theme.mode = "dark";
    mocks.theme.resolvedTheme = "dark";
    mocks.app.terminalSplitActive = false;
    mocks.app.multiExecActive = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the full tray at normal widths", () => {
    render(<TitleBarTrayControls />);

    expect(screen.getByTestId("titlebar-tray")).toBeInTheDocument();
    expect(screen.queryByTestId("titlebar-actions-more")).not.toBeInTheDocument();
  });

  it("moves tray actions into one compact menu at narrow widths", () => {
    window.innerWidth = 800;
    render(<TitleBarTrayControls />);

    expect(screen.queryByTestId("titlebar-tray")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("titlebar-actions-more"));

    expect(screen.getByTestId("titlebar-actions-menu")).toBeInTheDocument();
    expect(screen.getByTestId("tab-split-view")).toBeInTheDocument();
    expect(screen.getByTestId("tab-multiexec-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("theme-cycle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tab-split-view"));
    expect(mocks.app.toggleTerminalSplit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("titlebar-actions-menu")).not.toBeInTheDocument();
  });

  it("switches layout when the window crosses the breakpoint", async () => {
    render(<TitleBarTrayControls />);
    expect(screen.getByTestId("titlebar-tray")).toBeInTheDocument();

    window.innerWidth = 800;
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(screen.getByTestId("titlebar-actions-more")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("titlebar-tray")).not.toBeInTheDocument();
  });
});
