import type { LspCodeAction, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { WorkspaceEditApplyOutcome } from "./workspaceEditApply";

export type CodeActionExecutionResult =
  | { status: "applied-edit"; outcomes: WorkspaceEditApplyOutcome[] }
  | { status: "executed-command"; outcomes: WorkspaceEditApplyOutcome[] }
  | { status: "edit-failed"; outcomes: WorkspaceEditApplyOutcome[] }
  | { status: "empty"; outcomes: [] };

export interface CodeActionExecutionHooks {
  applyEdit: (edit: LspWorkspaceEdit) => Promise<WorkspaceEditApplyOutcome[]>;
  executeCommand: (command: string, argumentsValue: unknown) => Promise<unknown>;
}

export async function executeCodeAction(
  action: LspCodeAction,
  hooks: CodeActionExecutionHooks,
): Promise<CodeActionExecutionResult> {
  let outcomes: WorkspaceEditApplyOutcome[] = [];
  if (action.edit) {
    outcomes = await hooks.applyEdit(action.edit);
    if (outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "skipped")) {
      return { status: "edit-failed", outcomes };
    }
  }
  if (action.command) {
    await hooks.executeCommand(action.command, action.commandArguments);
    return { status: "executed-command", outcomes };
  }
  if (action.edit) return { status: "applied-edit", outcomes };
  return { status: "empty", outcomes: [] };
}
