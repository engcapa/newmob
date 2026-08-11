import { describe, expect, it, vi } from "vitest";
import type { LspCodeAction, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { executeCodeAction } from "./codeActionExecution";

const edit: LspWorkspaceEdit = { documentEdits: [], operations: [] };

function action(overrides: Partial<LspCodeAction>): LspCodeAction {
  return {
    title: "Fix",
    kind: "quickfix",
    isPreferred: true,
    edit: null,
    command: null,
    commandArguments: null,
    raw: {},
    ...overrides,
  };
}

describe("executeCodeAction", () => {
  it("applies an edit before executing the action command", async () => {
    const calls: string[] = [];
    const result = await executeCodeAction(action({
      edit,
      command: "java.apply.workspaceEdit",
      commandArguments: [{ id: 1 }],
    }), {
      applyEdit: async () => {
        calls.push("edit");
        return [{ operationIndex: 0, path: "/repo/a.ts", status: "applied-disk" }];
      },
      executeCommand: async () => {
        calls.push("command");
      },
    });

    expect(calls).toEqual(["edit", "command"]);
    expect(result.status).toBe("executed-command");
  });

  it("does not execute the command after a partial edit failure", async () => {
    const executeCommand = vi.fn(async () => {});
    const result = await executeCodeAction(action({ edit, command: "unsafe.followup" }), {
      applyEdit: async () => [{
        operationIndex: 0,
        path: "/repo/a.ts",
        status: "failed",
        reason: "hash mismatch",
      }],
      executeCommand,
    });

    expect(result.status).toBe("edit-failed");
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("executes command-only actions with their opaque arguments", async () => {
    const executeCommand = vi.fn(async () => ({ ok: true }));
    const commandArguments = { project: "app" };
    const result = await executeCodeAction(action({
      command: "workspace.reload",
      commandArguments,
    }), {
      applyEdit: vi.fn(async () => []),
      executeCommand,
    });

    expect(executeCommand).toHaveBeenCalledWith("workspace.reload", commandArguments);
    expect(result.status).toBe("executed-command");
  });
});
