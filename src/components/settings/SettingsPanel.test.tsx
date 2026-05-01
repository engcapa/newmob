import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

const STORAGE_KEY = "newmob.terminalProfile.v1";

describe("SettingsPanel", () => {
  beforeEach(() => {
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Consolas", "JetBrains Mono", "Source Code Pro"]);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("persists global terminal appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByLabelText("Enable font ligatures"));
    await user.click(screen.getByRole("button", { name: "Use theme Kanagawa Wave" }));
    await user.selectOptions(screen.getByLabelText("Terminal cursor"), "Underline (steady)");
    await user.click(screen.getByLabelText("Enable keyword highlighting"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.fontSize).toBe(18);
      expect(saved.fontLigatures).toBe(true);
      expect(saved.theme).toBe("kanagawa-wave");
      expect(saved.cursorStyle).toBe("underline");
      expect(saved.cursorBlink).toBe(false);
      expect(saved.syntaxMode).toBe("keywords");
    });
  });
});
