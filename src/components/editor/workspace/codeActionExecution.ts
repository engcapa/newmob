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

  let effectiveEdit = action.edit;
  let effectiveCommand = action.command;

  const isApplyEditCommand =
    effectiveCommand === "_java.apply.workspaceEdit" ||
    effectiveCommand === "java.apply.workspaceEdit" ||
    effectiveCommand === "editor.action.applyWorkspaceEdit" ||
    effectiveCommand === "applyWorkspaceEdit";

  if (!effectiveEdit && isApplyEditCommand && Array.isArray(action.commandArguments)) {
    const firstArg = action.commandArguments[0] as Record<string, unknown> | undefined;
    if (firstArg && (firstArg.changes || firstArg.documentChanges || firstArg.documentEdits || firstArg.operations)) {
      effectiveEdit = firstArg as unknown as LspWorkspaceEdit;
      effectiveCommand = null;
    }
  }

  if (effectiveEdit) {
    outcomes = await hooks.applyEdit(effectiveEdit);
    if (outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "skipped")) {
      return { status: "edit-failed", outcomes };
    }
  }
  if (effectiveCommand) {
    await hooks.executeCommand(effectiveCommand, action.commandArguments);
    return { status: "executed-command", outcomes };
  }
  if (effectiveEdit) return { status: "applied-edit", outcomes };
  return { status: "empty", outcomes: [] };
}
