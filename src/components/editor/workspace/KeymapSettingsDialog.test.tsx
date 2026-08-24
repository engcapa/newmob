import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeymapSettingsDialog } from "./KeymapSettingsDialog";
import { WorkspaceActionHost } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  type KeymapSchemeV3,
  type Shortcut,
} from "./workspaceKeymapScheme";

function makeSnapshotItem(id: string, scheme?: KeymapSchemeV3) {
  const host = new WorkspaceActionHost({ workspaceId: "ws" });
  host.registerActions([{
    id,
    title: id,
    category: "Edit",
    provenance: "local",
    run: async () => ({ kind: "applied" as const }),
  }]);
  if (scheme) host.setKeymapScheme(scheme);
  return host.getSnapshot()[0]!;
}

function setup() {
  const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
  const schemes = [scheme];
  const onApplyScheme = vi.fn((_updated: KeymapSchemeV3) => undefined);
  const renderResult = render(
    <KeymapSettingsDialog
      open
      snapshot={[makeSnapshotItem("test.action")]}
      schemes={schemes}
      activeSchemeId={scheme.id}
      defaultSchemeName="Default"
      onActiveSchemeChange={vi.fn()}
      onSchemesChange={vi.fn()}
      onApplyScheme={onApplyScheme}
      onClose={vi.fn()}
    />,
  );
  return { onApplyScheme, ...renderResult };
}

function key(key: string, init: KeyboardEventInit & { code?: string } = {}) {
  // jsdom does not synthesize `code`; physical-code identity must be explicit.
  const code = init.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  fireEvent.keyDown(window, { key, bubbles: true, cancelable: true, ...init, code });
}

describe("§8.19.2 two-stroke shortcut recorder", () => {
  afterEach(cleanup);

  it("records a full two-stroke sequence confirmed with Enter", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    expect(screen.getByText(/press keys/)).toBeTruthy();

    key("k", { ctrlKey: true });
    // Live display shows physical code while recording.
    expect(screen.getByText(/\[KeyK\]/)).toBeTruthy();

    key("s");
    expect(screen.getByText(/\[KeyK, KeyS\]/)).toBeTruthy();

    key("Enter");
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    const applied = onApplyScheme.mock.calls[0][0];
    const binding = applied.bindings["test.action"]?.[0];
    expect(binding).toBeDefined();
    if (binding && binding.kind === "keyboard") {
      expect(binding.strokes.map((stroke) => stroke.code)).toEqual(["KeyK", "KeyS"]);
    } else {
      throw new Error("expected a keyboard shortcut");
    }
  });

  it("Backspace removes the last recorded stroke before confirmation", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    key("k", { ctrlKey: true });
    key("s");
    expect(screen.getByText(/\[KeyK, KeyS\]/)).toBeTruthy();
    key("Backspace");
    expect(screen.getByText(/\[KeyK\]/)).toBeTruthy();
    key("Enter");
    const binding = onApplyScheme.mock.calls[0][0].bindings["test.action"]?.[0];
    if (binding && binding.kind === "keyboard") {
      expect(binding.strokes).toHaveLength(1);
    } else {
      throw new Error("expected a single-stroke shortcut");
    }
  });

  it("Escape cancels the capture without touching the scheme", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    key("k", { ctrlKey: true });
    key("Escape");
    key("Enter");
    expect(onApplyScheme).not.toHaveBeenCalled();
  });

  it("replaces an existing binding at its index instead of appending", () => {
    const base = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const existing: Shortcut = {
      kind: "keyboard",
      strokes: [{ code: "KeyA", ctrl: true, alt: false, shift: false, meta: false }],
    };
    base.bindings = setActionBindings(base, "test.action", [existing]).bindings;
    const onApplyScheme = vi.fn();
    render(
      <KeymapSettingsDialog
        open
        snapshot={[makeSnapshotItem("test.action", base)]}
        schemes={[base]}
        activeSchemeId={base.id}
        defaultSchemeName="Default"
        onActiveSchemeChange={vi.fn()}
        onSchemesChange={vi.fn()}
        onApplyScheme={onApplyScheme}
        onClose={vi.fn()}
      />,
    );
    // Click the existing binding swatch to re-record it in place.
    fireEvent.click(screen.getByTestId("keymap-replace-test.action-0"));
    key("b", { altKey: true });
    key("Enter");
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    const bindings = onApplyScheme.mock.calls[0][0].bindings["test.action"];
    expect(bindings).toHaveLength(1);
    if (bindings![0].kind === "keyboard") {
      expect(bindings![0].strokes[0].code).toBe("KeyB");
    }
  });
});
