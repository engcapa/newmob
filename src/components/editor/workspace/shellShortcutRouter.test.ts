import { describe, expect, it } from "vitest";
import {
  isReopenTabChord,
  resolveShellShortcutRoute,
  type ShellShortcutClaim,
} from "./shellShortcutRouter";

const claim = (overrides: Partial<ShellShortcutClaim> = {}): ShellShortcutClaim => ({
  ownerId: "workspace-1",
  actionId: "workspace.reopenClosedTab",
  scope: "active-workspace",
  priority: 40,
  enabled: true,
  canExecute: true,
  disabledReason: null,
  ...overrides,
});

describe("resolveShellShortcutRoute (W0 §8.20.1)", () => {
  it("unclaimed when no claims exist", () => {
    expect(resolveShellShortcutRoute([])).toEqual({ state: "unclaimed" });
  });

  it("unclaimed when every claim is disabled", () => {
    expect(resolveShellShortcutRoute([claim({ enabled: false })])).toEqual({
      state: "unclaimed",
    });
  });

  it("dispatches the top claim", () => {
    expect(resolveShellShortcutRoute([claim()])).toEqual({
      state: "dispatch",
      ownerId: "workspace-1",
      actionId: "workspace.reopenClosedTab",
    });
  });

  it("ranks modal above active-workspace regardless of priority", () => {
    const route = resolveShellShortcutRoute([
      claim({ scope: "active-workspace", priority: 100 }),
      claim({ ownerId: "dialog-1", actionId: "dialog.confirm", scope: "modal", priority: 1 }),
    ]);
    expect(route).toEqual({ state: "dispatch", ownerId: "dialog-1", actionId: "dialog.confirm" });
  });

  it("breaks same-scope ties by higher priority", () => {
    const route = resolveShellShortcutRoute([
      claim({ ownerId: "low", priority: 10 }),
      claim({ ownerId: "high", priority: 50 }),
    ]);
    expect(route).toMatchObject({ state: "dispatch", ownerId: "high" });
  });

  it("blocks (preventDefault) when the top claim cannot execute", () => {
    const route = resolveShellShortcutRoute([
      claim({ canExecute: false, disabledReason: "reopen stack is empty" }),
    ]);
    expect(route).toEqual({
      state: "blocked",
      reason: "reopen stack is empty",
      preventDefault: true,
    });
  });

  it("falls through to a lower claim when the top is disabled", () => {
    const route = resolveShellShortcutRoute([
      claim({ enabled: false }),
      claim({ ownerId: "shell", scope: "shell", actionId: "shell.newTerminal" }),
    ]);
    expect(route).toEqual({
      state: "dispatch",
      ownerId: "shell",
      actionId: "shell.newTerminal",
    });
  });
});

describe("isReopenTabChord", () => {
  const base = { key: "t", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };

  it("matches Ctrl+Shift+T and Cmd+Shift+T", () => {
    expect(isReopenTabChord(base)).toBe(true);
    expect(isReopenTabChord({ ...base, ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("rejects wrong modifiers and keys", () => {
    expect(isReopenTabChord({ ...base, shiftKey: false })).toBe(false);
    expect(isReopenTabChord({ ...base, altKey: true })).toBe(false);
    expect(isReopenTabChord({ ...base, key: "T" })).toBe(true); // case-insensitive
    expect(isReopenTabChord({ ...base, key: "n" })).toBe(false);
    expect(isReopenTabChord({ ...base, ctrlKey: false, metaKey: false })).toBe(false);
  });
});
