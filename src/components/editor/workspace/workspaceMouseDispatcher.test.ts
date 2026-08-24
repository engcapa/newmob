import { afterEach, describe, expect, it, vi } from "vitest";
import { attachWorkspaceMouseDispatcher } from "./workspaceMouseDispatcher";
import { WorkspaceActionHost } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  type Shortcut,
} from "./workspaceKeymapScheme";

function makeHostWithMouseShortcut(shortcut: Shortcut) {
  const host = new WorkspaceActionHost({ workspaceId: "ws-mouse" });
  const executed: string[] = [];
  host.registerActions([{
    id: "test.mouse",
    title: "Mouse Action",
    category: "Edit",
    provenance: "local",
    run: async () => {
      executed.push("test.mouse");
      return { kind: "applied" as const };
    },
  }]);
  const scheme = createKeymapScheme({ id: "s", name: "S", base: "idea-windows-linux" });
  host.setKeymapScheme(setActionBindings(scheme, "test.mouse", [shortcut]));
  return { host, executed };
}

function mouseEvent(type: "click" | "dblclick", init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

describe("§8.19.2 workspace mouse dispatcher", () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  afterEach(() => {
    root.innerHTML = "";
  });

  it("executes a registered double-click binding and consumes the event", () => {
    const { host, executed } = makeHostWithMouseShortcut({
      kind: "mouse",
      button: 0,
      clickCount: 2,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
    const attached = attachWorkspaceMouseDispatcher(host, root);

    const event = mouseEvent("dblclick", { ctrlKey: true });
    root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(executed).toEqual(["test.mouse"]);
    attached.dispose();
  });

  it("leaves unbound gestures untouched (no preventDefault, no execution)", () => {
    const { host, executed } = makeHostWithMouseShortcut({
      kind: "mouse",
      button: 0,
      clickCount: 2,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
    const attached = attachWorkspaceMouseDispatcher(host, root);

    const plainClick = mouseEvent("click");
    root.dispatchEvent(plainClick);
    const wrongModifiers = mouseEvent("dblclick", { shiftKey: true });
    root.dispatchEvent(wrongModifiers);

    expect(plainClick.defaultPrevented).toBe(false);
    expect(wrongModifiers.defaultPrevented).toBe(false);
    expect(executed).toEqual([]);
    attached.dispose();
  });

  it("does not execute disabled actions and does not consume the gesture", () => {
    const { host, executed } = makeHostWithMouseShortcut({
      kind: "mouse",
      button: 0,
      clickCount: 1,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    // Same binding, but the action is user-disabled in the scheme.
    const scheme = createKeymapScheme({ id: "s2", name: "S2", base: "idea-windows-linux" });
    host.setKeymapScheme({
      ...scheme,
      disabledActionIds: ["test.mouse"],
      bindings: setActionBindings(scheme, "test.mouse", [{
        kind: "mouse", button: 0, clickCount: 1,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }]).bindings,
    });

    const event = mouseEvent("click");
    root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(executed).toEqual([]);
  });

  it("dispose stops dispatch entirely", () => {
    const { host, executed } = makeHostWithMouseShortcut({
      kind: "mouse",
      button: 0,
      clickCount: 2,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
    const attached = attachWorkspaceMouseDispatcher(host, root);
    attached.dispose();
    const spy = vi.fn();
    const event = mouseEvent("dblclick", { ctrlKey: true });
    root.addEventListener("dblclick", spy);
    root.dispatchEvent(event);
    root.removeEventListener("dblclick", spy);
    expect(spy).toHaveBeenCalled();
    expect(executed).toEqual([]);
  });
});
