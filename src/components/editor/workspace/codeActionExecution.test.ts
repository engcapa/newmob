import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LspCodeAction, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { executeCodeAction, ActionExecutionTelemetry, CodeActionExecutionCoordinator } from "./codeActionExecution";

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

  it("unwraps and applies workspace edit when command is _java.apply.workspaceEdit", async () => {
    const applyEdit = vi.fn(async () => [{ operationIndex: 0, path: "/repo/App.java", status: "applied-disk" as const }]);
    const executeCommand = vi.fn(async () => {});
    const customEdit = { documentEdits: [{ uri: "file:///repo/App.java", edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import java.util.List;\n" }] }], operations: [] };

    const result = await executeCodeAction(action({
      edit: null,
      command: "_java.apply.workspaceEdit",
      commandArguments: [customEdit],
    }), {
      applyEdit,
      executeCommand,
    });

    expect(applyEdit).toHaveBeenCalledWith(customEdit, expect.anything());
    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.status).toBe("applied-edit");
  });

  describe("§8.22.8 U3 Provider Code Action Production Integration", () => {
    beforeEach(() => {
      ActionExecutionTelemetry.clear();
    });

    it("resolves unpopulated action via resolveAction hook before execution", async () => {
      const applyEdit = vi.fn(async () => [{ operationIndex: 0, path: "/repo/App.java", status: "applied-disk" as const }]);
      const unresolvedAction = action({
        title: "Add import 'java.util.Map'",
        kind: "quickfix.import",
        edit: null,
        command: null,
      });

      const resolvedAction = action({
        title: "Add import 'java.util.Map'",
        kind: "quickfix.import",
        edit: { documentEdits: [{ uri: "file:///repo/App.java", edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import java.util.Map;\n" }] }], operations: [] },
      });

      const resolveAction = vi.fn(async () => resolvedAction);

      const result = await CodeActionExecutionCoordinator.execute(unresolvedAction, {
        applyEdit,
        executeCommand: vi.fn(async () => {}),
        resolveAction,
      });

      expect(resolveAction).toHaveBeenCalledWith(unresolvedAction);
      expect(applyEdit).toHaveBeenCalled();
      expect(result.status).toBe("applied-edit");
      expect((result as any).undoToken).toBeDefined();

      const telemetry = ActionExecutionTelemetry.recent();
      expect(telemetry).toHaveLength(1);
      expect(telemetry[0].title).toBe("Add import 'java.util.Map'");
      expect(telemetry[0].status).toBe("applied-edit");
    });

    it("blocks Java quickfix when file language is not Java (language-mismatch)", async () => {
      const applyEdit = vi.fn(async () => []);
      const javaAction = action({
        title: "Import 'java.util.List'",
        kind: "quickfix.import.java",
        edit: { documentEdits: [], operations: [] },
      });

      const result = await CodeActionExecutionCoordinator.execute(javaAction, {
        languageId: "typescript",
        applyEdit,
        executeCommand: vi.fn(async () => {}),
      });

      expect(result.status).toBe("language-mismatch");
      expect(applyEdit).not.toHaveBeenCalled();
      expect((result as any).reason).toContain("cannot be executed in non-Java file");
    });
  });
});

