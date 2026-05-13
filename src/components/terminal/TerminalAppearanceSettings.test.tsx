import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAppearanceSettings } from "./TerminalAppearanceSettings";
import { DEFAULT_TERMINAL_PROFILE, type TerminalProfile } from "../../lib/terminalProfile";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  historyClear: vi.fn(async () => undefined),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

function renderAppearance(profile: TerminalProfile = DEFAULT_TERMINAL_PROFILE) {
  const onProfileChange = vi.fn();
  render(<TerminalAppearanceSettings profile={profile} onProfileChange={onProfileChange} showCustomColors />);
  return { onProfileChange };
}

describe("TerminalAppearanceSettings", () => {
  beforeEach(() => {
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Arial", "Source Code Pro", "JetBrains Mono"]);
  });

  afterEach(() => {
    cleanup();
  });

  it("lists OS fonts and selects Source Code Pro by default when available", async () => {
    renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "Source Code Pro" })).toBeInTheDocument());

    expect(screen.getByLabelText("Terminal font")).toHaveValue("Source Code Pro");
    expect(screen.getByRole("option", { name: "Arial" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Fira Code" })).not.toBeInTheDocument();
  });

  it("uses a safe fallback font list when OS font loading fails", async () => {
    ipcMocks.listSystemFonts.mockRejectedValueOnce(new Error("font access failed"));

    renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "Source Code Pro" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "Fira Code" })).toBeInTheDocument();
  });

  it("updates the preview when a theme is selected", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await user.click(screen.getByRole("button", { name: "Use theme Kanagawa Wave" }));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "kanagawa-wave" }));
  });

  it("merges successive edits before the parent rerenders", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByRole("button", { name: "Use theme Kanagawa Wave" }));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining("JetBrains Mono"),
      fontSize: 18,
      theme: "kanagawa-wave",
    }));
  });

  it("renders terminal profile controls before the bottom preview", async () => {
    renderAppearance();

    await waitFor(() => expect(screen.getByLabelText("Terminal cursor")).toBeInTheDocument());

    const cursor = screen.getByLabelText("Terminal cursor");
    const preview = screen.getByTestId("terminal-preview");
    expect(cursor.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reflects cursor style and blink setting in the preview", async () => {
    renderAppearance({
      ...DEFAULT_TERMINAL_PROFILE,
      cursorStyle: "underline",
      cursorBlink: false,
    });

    const cursor = await screen.findByTestId("terminal-preview-cursor");
    expect(cursor).toHaveStyle({ borderBottom: expect.stringContaining("solid") });
    expect(cursor).not.toHaveClass("moba-blink");
  });
});
