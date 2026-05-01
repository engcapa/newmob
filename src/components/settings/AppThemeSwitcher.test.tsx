import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppThemeMode } from "../../lib/appTheme";
import { AppThemeIconButton, AppThemeSwitcher } from "./AppThemeSwitcher";

const APP_THEME_STORAGE_KEY = "newmob.appTheme.v1";

describe("AppThemeSwitcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setAppThemeMode("system");
  });

  afterEach(() => {
    cleanup();
  });

  it("persists compact dropdown changes", async () => {
    const user = userEvent.setup();
    render(<AppThemeSwitcher compact />);

    await user.selectOptions(screen.getByLabelText("Application theme"), "dark");

    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");
  });

  it("cycles theme modes from the icon button", async () => {
    const user = userEvent.setup();
    setAppThemeMode("light");
    render(<AppThemeIconButton />);

    await user.click(screen.getByRole("button", { name: "Cycle application theme" }));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Cycle application theme" }));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("system");
  });
});
