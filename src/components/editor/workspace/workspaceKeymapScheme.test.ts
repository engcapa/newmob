import { describe, expect, it } from "vitest";
import {
  createKeymapScheme,
  formatShortcut,
  isReservedStroke,
  readKeymapSchemes,
  setActionBindings,
  setActionDisabled,
  shortcutsEqual,
  strokeFromKeyboardEvent,
  strokesEqual,
  writeKeymapSchemes,
  type KeymapSchemeV3,
} from "./workspaceKeymapScheme";

function key(code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return strokeFromKeyboardEvent({ code, key: code.toLowerCase(), ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta });
}

function schemeWithBindings(): KeymapSchemeV3 {
  let scheme = createKeymapScheme({ id: "s1", name: "Mine", base: "idea-windows-linux" });
  scheme = setActionBindings(scheme, "editor.save", [
    { kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] },
  ]);
  scheme = setActionDisabled(scheme, "editor.replace", true);
  return scheme;
}

describe("§8.18.2 KeymapSchemeV3 model", () => {
  it("records a user delta over a platform base and clears empty binding sets", () => {
    const base = createKeymapScheme({ id: "s2", name: "Base copy", base: "idea-macos" });
    expect(base.schemaVersion).toBe(3);
    expect(base.readOnly).toBe(false);

    const withBinding = setActionBindings(base, "a.b", [{ kind: "keyboard", strokes: [key("KeyK", { ctrl: true, alt: true })] }]);
    expect(withBinding.bindings["a.b"]).toHaveLength(1);
    // Removing the last binding deletes the entry entirely.
    const emptied = setActionBindings(withBinding, "a.b", []);
    expect(emptied.bindings["a.b"]).toBeUndefined();
  });

  it("matches strokes physically (code + modifiers), ignoring display key", () => {
    expect(strokesEqual(key("KeyS", { ctrl: true }), { code: "KeyS", ctrl: true, alt: false, shift: false, meta: false })).toBe(true);
    expect(strokesEqual(key("KeyS", { ctrl: true }), key("KeyS"))).toBe(false);
    expect(shortcutsEqual(
      { kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] },
      { kind: "keyboard", strokes: [{ ...key("KeyS", { ctrl: true }), key: "Σ" }] },
    )).toBe(true);
    expect(shortcutsEqual(
      { kind: "mouse", button: 2, clickCount: 1, modifiers: { ctrl: false, alt: false, shift: false, meta: false } },
      { kind: "keyboard", strokes: [key("KeyS")] },
    )).toBe(false);
  });

  it("flags OS/browser-reserved bare strokes as warnings", () => {
    expect(isReservedStroke(key("F5"))).toBe(true);
    expect(isReservedStroke(key("Tab"))).toBe(true);
    expect(isReservedStroke(key("F5", { ctrl: true }))).toBe(false);
  });

  it("formats shortcuts for display", () => {
    const stroke = { ...key("KeyJ", { ctrl: true, shift: true }), key: "j" };
    expect(formatShortcut({ kind: "keyboard", strokes: [stroke] })).toBe("Ctrl+Shift+J");
  });

  it("persists schemes and round-trips through storage (per app profile)", () => {
    window.localStorage.clear();
    const scheme = schemeWithBindings();
    writeKeymapSchemes([scheme], "s1");
    const read = readKeymapSchemes();
    expect(read.recoveredFromCorrupt).toBe(false);
    expect(read.activeId).toBe("s1");
    expect(read.schemes[0].bindings["editor.save"]).toEqual([{ kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] }]);
    expect(read.schemes[0].disabledActionIds).toEqual(["editor.replace"]);
    window.localStorage.clear();
  });

  it("quarantines corrupted payloads and reports the diagnostic instead of throwing", () => {
    window.localStorage.clear();
    window.localStorage.setItem("taomni.codeWorkspace.keymap.v3:index", "{not json");
    const read = readKeymapSchemes();
    expect(read.recoveredFromCorrupt).toBe(true);
    expect(window.localStorage.getItem("taomni.codeWorkspace.keymap.v3:corrupt-backup")).toBe("{not json");
    // Non-v3 schema rows are dropped individually.
    window.localStorage.setItem("taomni.codeWorkspace.keymap.v3:index", JSON.stringify([
      { schemaVersion: 3, id: "ok", name: "ok" },
      { schemaVersion: 2, id: "legacy" },
    ]));
    const partial = readKeymapSchemes();
    expect(partial.recoveredFromCorrupt).toBe(true);
    expect(partial.schemes.map((entry) => entry.id)).toEqual(["ok"]);
    window.localStorage.clear();
  });
});
