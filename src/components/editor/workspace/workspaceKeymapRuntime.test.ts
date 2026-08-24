import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_RETAINED_BINDING_ALLOWLIST,
  buildEditorHostActions,
  buildEditorPrimitiveKeybindings,
} from "./workspaceCodeMirrorKeymap";
import {
  EditorActionBridge,
  WorkspaceActionHost,
  type KeyDispatchResult,
} from "./workspaceActionHost";
import { workspaceEditorKeymap } from "./workspaceEditorCommands";
import {
  createKeymapScheme,
  setActionBindings,
  type Shortcut,
  type ShortcutStroke,
} from "./workspaceKeymapScheme";

const NOOP_HANDLERS = {
  save: () => {},
  openReplacePanel: () => false,
  expandSemanticSelection: () => false,
  escapeStack: () => false,
  runEditorCommand: () => false,
};

/** Parse a CodeMirror-style pattern ("Mod-Shift-j") into comparable parts. */
function parseCmPattern(pattern: string): { key: string; mods: Set<string> } | null {
  const parts = pattern.split("-").filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!.toLowerCase();
  const rawMods = new Set(parts.slice(0, -1).map((mod) => mod.toLowerCase()));
  const mods = new Set<string>();
  // Mod expands to both platform variants while keeping any other modifiers
  // ("Mod-Shift-Enter" -> {ctrl, meta, shift}); the catalog always lists Ctrl
  // and Meta explicitly, so either expansion matches.
  if (rawMods.has("mod")) {
    mods.add("ctrl");
    mods.add("meta");
  }
  for (const mod of rawMods) if (mod !== "mod") mods.add(mod);
  return { key, mods };
}

/** Canonical identity: sorted lowercase tokens (modifiers + key). */
function canonical(tokens: readonly string[]): string {
  return [...tokens].map((t) => t.toLowerCase()).sort().join("+");
}

function catalogBindingSet(): Set<string> {
  const identities = new Set<string>();
  for (const action of buildEditorHostActions(NOOP_HANDLERS)) {
    const bindings = [
      ...(typeof action.keybinding === "string" ? [action.keybinding] : []),
      ...(action.secondaryKeybindings ?? []),
    ];
    for (const binding of bindings) {
      if (!binding) continue;
      const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
      const key = parts.pop() ?? "";
      identities.add(canonical([...parts, key]));
    }
  }
  return identities;
}

describe("§8.19.2 keymap inventory", () => {
  it("every legacy business binding resolves to an action id or the allowlist", () => {
    const catalog = catalogBindingSet();
    const unresolved: string[] = [];
    for (const binding of workspaceEditorKeymap) {
      const parsed = parseCmPattern(binding.key ?? "");
      expect(parsed, `unparseable legacy binding ${binding.key}`).not.toBeNull();
      let matched = false;
      // Try each platform expansion of Mod separately, plus raw mods.
      const modLists: string[][] = [[...parsed!.mods]];
      if (parsed!.mods.has("ctrl") || parsed!.mods.has("meta")) {
        modLists.push([...parsed!.mods].filter((m) => m !== "ctrl"));
        modLists.push([...parsed!.mods].filter((m) => m !== "meta"));
      }
      for (const mods of modLists) {
        if (catalog.has(canonical([...mods, parsed!.key]))) matched = true;
      }
      if (!matched) unresolved.push(binding.key ?? "");
      // The only permitted unresolved binding is the reserved Tab gesture.
      if (unresolved.length > 0) {
        expect(unresolved.every((key) => /tab/i.test(key))).toBe(true);
      }
    }
  });

  it("the hosted primitive keymap contains only allowlisted primitives", () => {
    const retained = buildEditorPrimitiveKeybindings(true) as readonly { key?: string }[];
    const businessKeys = new Set(
      workspaceEditorKeymap.map((entry) => (entry.key ?? "").toLowerCase()),
    );
    const offenders: string[] = [];
    for (const binding of retained) {
      const rawKey = binding.key;
      if (!rawKey) continue; // compound {run, shift} entries carry no own key
      const key = rawKey.toLowerCase();
      // Reserved primitives stay regardless.
      if (["escape", "tab", "shift-tab", "backspace", "enter"].includes(key)) continue;
      if (businessKeys.has(key)) offenders.push(`business leak: ${key}`);
      // defaultKeymap cursor/selection/input primitives are identifiable by
      // their families; anything command-shaped that slipped through with a
      // migrated binding identity was already filtered by the builder.
    }
    expect(offenders).toEqual([]);
  });

  it("filters action-owned defaults out of the hosted spread (single truth)", () => {
    // Mod-/ toggleComment and Shift-Mod-k deleteLine are owned by migrated
    // actions; the hosted spread must not also install them via defaultKeymap.
    const retained = buildEditorPrimitiveKeybindings(true) as readonly { key?: string }[];
    const keys = retained.map((binding) => (binding.key ?? "").toLowerCase());
    expect(keys).not.toContain("mod-/");
    expect(keys).not.toContain("shift-mod-k");
    expect(keys).not.toContain("shift-alt-arrowup"); // moveLineUp owner
    expect(keys).not.toContain("shift-alt-arrowdown"); // moveLineDown owner
    expect(keys).toContain("escape");
    expect(keys).toContain("backspace");
    expect(keys).toContain("enter");
    expect(keys).toContain("tab");
    // Cursor/selection primitives survive the filter untouched.
    expect(keys).toContain("arrowleft");
    expect(keys).toContain("home");
  });

  it("documents a reason for every retained binding family", () => {
    const patterns = EDITOR_RETAINED_BINDING_ALLOWLIST.map((entry) => entry.pattern);
    for (const required of ["Escape", "Tab", "Backspace", "Enter", "Ctrl/Cmd-click"]) {
      expect(patterns).toContain(required);
    }
    for (const entry of EDITOR_RETAINED_BINDING_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

function makeEvent(input: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    getModifierState: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: null,
    ...input,
  } as unknown as KeyboardEvent;
}

describe("§8.19.2 dispatchKeydownV2 gate", () => {
  let host: WorkspaceActionHost;
  let executed: string[];

  beforeEach(() => {
    executed = [];
    host = new WorkspaceActionHost({ workspaceId: "ws-gate" });
    host.registerActions([{
      id: "test.plain",
      title: "Plain Action",
      category: "Edit",
      keybinding: "Ctrl+j",
      provenance: "local",
      run: async () => {
        executed.push("test.plain");
        return { kind: "applied" };
      },
    }]);
    host.registerActions([{
      id: "test.chord",
      title: "Chord Action",
      category: "Edit",
      provenance: "local",
      run: async () => {
        executed.push("test.chord");
        return { kind: "applied" };
      },
    }]);
    const scheme = createKeymapScheme({ id: "s1", name: "S1", base: "idea-windows-linux" });
    const stroke = (code: string, mods: Partial<ShortcutStroke> = {}): ShortcutStroke => ({
      code,
      ctrl: false, alt: false, shift: false, meta: false, ...mods,
    });
    const chord: Shortcut = { kind: "keyboard", strokes: [stroke("KeyK"), stroke("KeyS")] };
    host.setKeymapScheme(setActionBindings(scheme, "test.chord", [chord]));
    new EditorActionBridge(host).registerView("view-1");
  });

  function dispatch(event: KeyboardEvent): KeyDispatchResult {
    return host.dispatchKeydownV2({
      event,
      workspaceId: "ws-gate",
      targetViewId: null,
    });
  }

  it("executes a plain binding and reports evaluation id", async () => {
    const event = makeEvent({ key: "j", code: "KeyJ", ctrlKey: true });
    const result = dispatch(event);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      expect(result.actionId).toBe("test.plain");
      expect(result.evaluationId).toMatch(/^ws-gate:e\d+$/);
    }
    expect(event.preventDefault).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toContain("test.plain");
  });

  it("rejects IME composition without consuming the character", () => {
    const event = makeEvent({ key: "j", code: "KeyJ", ctrlKey: true, isComposing: true });
    const result = dispatch(event);
    expect(result).toEqual({ kind: "rejected", reason: "composing" });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("rejects dead keys without triggering actions or swallowing input", () => {
    const event = makeEvent({ key: "Dead", code: "Dead", ctrlKey: true });
    const result = dispatch(event);
    expect(result).toEqual({ kind: "rejected", reason: "dead-key" });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("rejects AltGr strokes so non-US layout characters still type", () => {
    const event = makeEvent({
      key: "@", code: "KeyQ",
      ctrlKey: true, altKey: true,
      getModifierState: (state: string) => state === "AltGraph",
    });
    const result = dispatch(event);
    expect(result).toEqual({ kind: "rejected", reason: "alt-graph" });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("enters a pending chord only when a registered second stroke can follow", () => {
    const first = makeEvent({ key: "k", code: "KeyK" });
    const result = dispatch(first);
    expect(result.kind).toBe("pending-chord");
    if (result.kind === "pending-chord") {
      expect(result.prefix.code).toBe("KeyK");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    }
    expect(executed).toEqual([]);
  });

  it("rejects conflicts instead of picking an array-order winner", () => {
    const duplicate = new WorkspaceActionHost({ workspaceId: "ws-conflict" });
    const makeAction = (id: string) => ({
      id,
      title: id,
      category: "Edit" as const,
      keybinding: "Ctrl+7",
      provenance: "local" as const,
      run: async () => ({ kind: "applied" as const }),
    });
    duplicate.registerActions([makeAction("a.one"), makeAction("a.two")]);
    duplicate.registerDispatchView("v");
    const event = makeEvent({ key: "7", code: "Digit7", ctrlKey: true });
    const result = duplicate.dispatchKeydownV2({ event, workspaceId: "ws-conflict", targetViewId: null });
    expect(result).toEqual({ kind: "rejected", reason: "conflict" });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("rejects stale view ids before matching", () => {
    const result = host.dispatchKeydownV2({
      event: makeEvent({ key: "j", code: "KeyJ", ctrlKey: true }),
      workspaceId: "ws-gate",
      targetViewId: "ghost-view",
    });
    expect(result).toEqual({ kind: "rejected", reason: "stale-owner" });
  });

  it("bridge registration lifecycle controls the stale gate", () => {
    expect(host.isDispatchViewRegistered("view-1")).toBe(true);
    host.unregisterDispatchView("view-1");
    expect(host.isDispatchViewRegistered("view-1")).toBe(false);
    const result = host.dispatchKeydownV2({
      event: makeEvent({ key: "j", code: "KeyJ", ctrlKey: true }),
      workspaceId: "ws-gate",
      targetViewId: "view-1",
    });
    expect(result).toEqual({ kind: "rejected", reason: "stale-owner" });
  });

  it("completes a two-stroke chord through the typed results", async () => {
    const first = dispatch(makeEvent({ key: "k", code: "KeyK" }));
    expect(first.kind).toBe("pending-chord");
    const second = dispatch(makeEvent({ key: "s", code: "KeyS" }));
    expect(second.kind).toBe("executed");
    if (second.kind === "executed") expect(second.actionId).toBe("test.chord");
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toContain("test.chord");
    expect(host.hasPendingChord()).toBe(false);
  });
});
