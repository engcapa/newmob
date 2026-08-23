import { describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  setActionDisabled,
  type KeymapSchemeV3,
} from "./workspaceKeymapScheme";
import type { WorkspaceActionDefinition } from "./workspaceActionRegistry";

function keyEvent(code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return {
    key: code.replace("Key", "").toLowerCase(),
    code,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function makeHost(actions: WorkspaceActionDefinition[]): WorkspaceActionHost {
  const host = new WorkspaceActionHost({ workspaceId: "ws-km" });
  host.registerActions(actions);
  return host;
}

function userScheme(mutate: (scheme: KeymapSchemeV3) => KeymapSchemeV3): KeymapSchemeV3 {
  return mutate(createKeymapScheme({ id: "u1", name: "User", base: "idea-windows-linux" }));
}

describe("§8.18.2 scheme-aware binding resolution", () => {
  const saveAction: WorkspaceActionDefinition = {
    id: "editor.save",
    title: "Save File",
    category: "File",
    keybinding: "Ctrl+s",
    provenance: "local",
    run: async () => ({ kind: "applied" }),
  };
  const findAction: WorkspaceActionDefinition = {
    id: "workspace.find",
    title: "Find",
    category: "Search",
    keybinding: "Ctrl+f",
    provenance: "local",
    run: async () => ({ kind: "applied" }),
  };

  it("resolves built-in defaults without a scheme and executes through the frozen evaluation", async () => {
    const host = makeHost([saveAction]);
    const resolved = host.prepareBinding(keyEvent("KeyS", { ctrl: true }));
    expect(resolved.resolution).toBe("single");
    expect(resolved.candidates[0].source).toBe("base");
    expect(resolved.candidates[0].evaluation.actionId).toBe("editor.save");

    const dispatched = await host.dispatchKeydown(keyEvent("KeyS", { ctrl: true }));
    expect(dispatched?.id).toBe("editor.save");
    expect(dispatched?.result.kind).toBe("applied");
  });

  it("lets a user scheme override defaults and reports source=user", async () => {
    const host = makeHost([saveAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionBindings(scheme, "editor.save", [
      { kind: "keyboard", strokes: [{ code: "KeyD", key: "d", ctrl: true, alt: true, shift: false, meta: false }] },
    ])));

    // Old default no longer matches.
    expect(host.prepareBinding(keyEvent("KeyS", { ctrl: true })).resolution).toBe("none");
    // New binding resolves with user provenance.
    const resolved = host.prepareBinding(keyEvent("KeyD", { ctrl: true, alt: true }));
    expect(resolved.resolution).toBe("single");
    expect(resolved.candidates[0].source).toBe("user");

    // Snapshot shows the effective binding so all surfaces share one truth.
    const snapshotItem = host.getSnapshot().find((item) => item.id === "editor.save");
    expect(snapshotItem?.keybinding).toBe("Ctrl+Alt+d");
  });

  it("keeps user-disabled actions visible in search but unavailable to dispatch", async () => {
    const host = makeHost([findAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionDisabled(scheme, "workspace.find", true)));

    const state = host.getState("workspace.find");
    expect(state.availability).toBe("disabled");
    expect(state.disabledReason).toBe("userDisabled");

    // Search keeps the action listed (with its disabled state).
    const found = host.search("find");
    expect(found).toHaveLength(1);

    // Dispatch refuses instead of executing.
    const result = await host.dispatchKeydown(keyEvent("KeyF", { ctrl: true }));
    expect(result).toBeNull();
  });

  it("never executes when two available actions share one stroke — conflict surfaces", async () => {
    const duplicate: WorkspaceActionDefinition = {
      ...findAction,
      id: "workspace.find2",
      title: "Find Too",
      keybinding: "Ctrl+f",
    };
    const host = makeHost([findAction, duplicate]);
    const resolved = host.prepareBinding(keyEvent("KeyF", { ctrl: true }));
    expect(resolved.resolution).toBe("conflict");

    const dispatched = await host.dispatchKeydown(keyEvent("KeyF", { ctrl: true }));
    expect(dispatched).toBeNull();
  });

  it("recognizes two-stroke chords: first stroke waits, second executes, Esc cancels", async () => {
    const chordAction: WorkspaceActionDefinition = {
      id: "editor.reformat",
      title: "Reformat",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+k",
      secondaryKeybindings: ["Ctrl+Alt+Shift+j"],
      provenance: "local",
      run: async () => ({ kind: "applied" }),
    };
    // Register as a real two-stroke shortcut via user scheme.
    const host = makeHost([chordAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionBindings(scheme, "editor.reformat", [
      {
        kind: "keyboard",
        strokes: [
          { code: "KeyK", key: "k", ctrl: true, alt: true, shift: true, meta: false },
          { code: "KeyJ", key: "j", ctrl: false, alt: false, shift: false, meta: false },
        ],
      },
    ])));

    const first = host.prepareBinding(keyEvent("KeyK", { ctrl: true, alt: true, shift: true }));
    expect(first.resolution).toBe("shadowed");
    expect(first.reason).toBe("chord-pending");
    expect(host.hasPendingChord()).toBe(true);

    // Second stroke completes the chord.
    const done = await host.dispatchKeydown(keyEvent("KeyJ"));
    expect(done?.id).toBe("editor.reformat");
    expect(host.hasPendingChord()).toBe(false);

    // Chord wait cancels on Escape-with-no-binding.
    host.prepareBinding(keyEvent("KeyK", { ctrl: true, alt: true, shift: true }));
    expect(host.hasPendingChord()).toBe(true);
    await host.dispatchKeydown(keyEvent("Escape"));
    expect(host.hasPendingChord()).toBe(false);
  });
});
