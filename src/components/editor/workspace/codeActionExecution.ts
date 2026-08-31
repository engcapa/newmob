import type { LspCodeAction, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { WorkspaceEditApplyOutcome } from "./workspaceEditApply";

export type CodeActionExecutionResult =
  | { status: "applied-edit"; outcomes: WorkspaceEditApplyOutcome[]; undoToken?: string }
  | { status: "executed-command"; outcomes: WorkspaceEditApplyOutcome[]; undoToken?: string }
  | { status: "edit-failed"; outcomes: WorkspaceEditApplyOutcome[] }
  | { status: "language-mismatch"; reason: string; outcomes: [] }
  | { status: "stale-precondition"; reason: string; outcomes: [] }
  | { status: "empty"; outcomes: [] };

export interface CodeActionExecutionHooks {
  languageId?: string;
  applyEdit: (edit: LspWorkspaceEdit, options?: { undoToken?: string }) => Promise<WorkspaceEditApplyOutcome[]>;
  executeCommand: (command: string, argumentsValue: unknown) => Promise<unknown>;
}

export interface ActionExecutionTelemetryEntry {
  title: string;
  kind?: string | null;
  durationMs: number;
  status: CodeActionExecutionResult["status"];
  editFileCount: number;
  undoToken?: string;
  timestamp: number;
}

export const ActionExecutionTelemetry: {
  entries: ActionExecutionTelemetryEntry[];
  record(entry: ActionExecutionTelemetryEntry): void;
  recent(): readonly ActionExecutionTelemetryEntry[];
  clear(): void;
} = {
  entries: [],
  record(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > 50) this.entries.pop();
  },
  recent() {
    return this.entries;
  },
  clear() {
    this.entries = [];
  },
};

export async function executeCodeAction(
  action: LspCodeAction,
  hooks: CodeActionExecutionHooks,
  precondition?: () => { valid: true } | { valid: false; reason: string },
): Promise<CodeActionExecutionResult> {
  const startTime = Date.now();
  if (precondition) {
    const check = precondition();
    if (!check.valid) {
      const res: CodeActionExecutionResult = { status: "stale-precondition", reason: check.reason, outcomes: [] };
      ActionExecutionTelemetry.record({
        title: action.title,
        kind: action.kind,
        durationMs: Date.now() - startTime,
        status: res.status,
        editFileCount: 0,
        timestamp: Date.now(),
      });
      return res;
    }
  }

  // Language isolation guard (§8.22.8)
  const isJavaSpecific =
    Boolean(action.kind?.startsWith("quickfix.import.java")) ||
    Boolean(action.command?.includes("_java.")) ||
    Boolean(action.command?.includes("java."));
  if (isJavaSpecific && hooks.languageId && hooks.languageId !== "java") {
    const res: CodeActionExecutionResult = {
      status: "language-mismatch",
      reason: `Java quick fix "${action.title}" cannot be executed in non-Java file (${hooks.languageId})`,
      outcomes: [],
    };
    ActionExecutionTelemetry.record({
      title: action.title,
      kind: action.kind,
      durationMs: Date.now() - startTime,
      status: res.status,
      editFileCount: 0,
      timestamp: Date.now(),
    });
    return res;
  }

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

  const undoToken = `undo-action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  if (effectiveEdit) {
    outcomes = await hooks.applyEdit(effectiveEdit, { undoToken });
    if (outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "skipped")) {
      const res: CodeActionExecutionResult = { status: "edit-failed", outcomes };
      ActionExecutionTelemetry.record({
        title: action.title,
        kind: action.kind,
        durationMs: Date.now() - startTime,
        status: res.status,
        editFileCount: outcomes.length,
        undoToken,
        timestamp: Date.now(),
      });
      return res;
    }
  }

  if (effectiveCommand) {
    await hooks.executeCommand(effectiveCommand, action.commandArguments);
    const res: CodeActionExecutionResult = { status: "executed-command", outcomes, undoToken };
    ActionExecutionTelemetry.record({
      title: action.title,
      kind: action.kind,
      durationMs: Date.now() - startTime,
      status: res.status,
      editFileCount: outcomes.length,
      undoToken,
      timestamp: Date.now(),
    });
    return res;
  }

  if (effectiveEdit) {
    const res: CodeActionExecutionResult = { status: "applied-edit", outcomes, undoToken };
    ActionExecutionTelemetry.record({
      title: action.title,
      kind: action.kind,
      durationMs: Date.now() - startTime,
      status: res.status,
      editFileCount: outcomes.length,
      undoToken,
      timestamp: Date.now(),
    });
    return res;
  }

  const res: CodeActionExecutionResult = { status: "empty", outcomes: [] };
  ActionExecutionTelemetry.record({
    title: action.title,
    kind: action.kind,
    durationMs: Date.now() - startTime,
    status: res.status,
    editFileCount: 0,
    timestamp: Date.now(),
  });
  return res;
}

export const CodeActionExecutionCoordinator = {
  execute: executeCodeAction,
  telemetry: ActionExecutionTelemetry,
};
