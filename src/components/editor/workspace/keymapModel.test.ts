import { describe, expect, it } from "vitest";
import {
  createDefaultIdeaScheme,
  createUserKeymapScheme,
  detectKeybindingConflicts,
  formatKeyboardEventToKeybinding,
  exportKeymapSchemeToJson,
  importKeymapSchemeFromJson,
} from "./keymapModel";

describe("keymapModel", () => {
  it("creates default platform schemes", () => {
    const winScheme = createDefaultIdeaScheme("windows");
    expect(winScheme.isBuiltin).toBe(true);
    expect(winScheme.platform).toBe("windows");
    expect(winScheme.bindings["workspace.format"]).toBeDefined();

    const macScheme = createDefaultIdeaScheme("macos");
    expect(macScheme.platform).toBe("macos");
  });

  it("creates copy-on-write user schemes from parent scheme", () => {
    const parent = createDefaultIdeaScheme("windows");
    const userScheme = createUserKeymapScheme(parent, "My Custom Keymap");

    expect(userScheme.isBuiltin).toBe(false);
    expect(userScheme.parentSchemeId).toBe(parent.id);
    expect(userScheme.name).toBe("My Custom Keymap");

    // Modify user scheme without mutating parent
    userScheme.bindings["custom.action"] = ["Ctrl+Alt+K"];
    expect(parent.bindings["custom.action"]).toBeUndefined();
  });

  it("formats keyboard events to standard keybinding strings", () => {
    const event = {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    };

    expect(formatKeyboardEventToKeybinding(event)).toBe("Ctrl+Shift+K");
  });

  it("detects keybinding conflicts", () => {
    const scheme = createDefaultIdeaScheme("windows");
    scheme.bindings["workspace.action1"] = ["Ctrl+Alt+T"];
    scheme.bindings["workspace.action2"] = ["Ctrl+Alt+T"];

    const conflicts = detectKeybindingConflicts(scheme);
    const tConflict = conflicts.find((c) => c.keybinding === "ctrl+alt+t");
    expect(tConflict).toBeDefined();
    expect(tConflict?.actionIds).toContain("workspace.action1");
    expect(tConflict?.actionIds).toContain("workspace.action2");
  });

  it("exports and imports keymap schemes via JSON roundtrip", () => {
    const scheme = createDefaultIdeaScheme("linux");
    scheme.bindings["test.action"] = ["Ctrl+Shift+X"];

    const json = exportKeymapSchemeToJson(scheme);
    const imported = importKeymapSchemeFromJson(json);

    expect(imported.bindings["test.action"]).toEqual(["Ctrl+Shift+X"]);
    expect(imported.isBuiltin).toBe(false);
  });
});
