import type { CodeDebugSession } from "../../useCodeDebugSession";
import type { DebugStepAction } from "../../dapDebugModel";

export type DebugActionId =
  | "resume"
  | "pause"
  | "stop"
  | "restart"
  | "hotReload"
  | "showExecutionPoint"
  | "stepOver"
  | "stepInto"
  | "stepOut"
  | "stepBack"
  | "restartFrame"
  | "runToCursor";

export interface DebugActionContext {
  debug: CodeDebugSession;
  activeRunning: boolean;
  stopped: boolean;
  selectedFrameId?: number | null;
  onShowExecutionPoint?: () => void;
  onRunToCursor?: (line: number) => void;
  targetCursorLine?: number;
}

export interface DebugActionDescriptor {
  id: DebugActionId;
  label: string;
  shortcut?: string;
  iconName?: string;
  isSupported: (ctx: DebugActionContext) => boolean;
  isAvailable: (ctx: DebugActionContext) => boolean;
  disabledReason: (ctx: DebugActionContext) => string | undefined;
  execute: (ctx: DebugActionContext, signal?: AbortSignal) => Promise<void> | void;
}

export function isHotReloadSupported(capabilities: Record<string, unknown> | undefined): boolean {
  if (!capabilities) return false;
  if (capabilities.supportsHotReload === true) return true;
  if (capabilities["java.redefineClasses"] === true) return true;
  if (capabilities.supportsRedefineClasses === true) return true;
  return false;
}

export const debugActionDescriptors: Record<DebugActionId, DebugActionDescriptor> = {
  resume: {
    id: "resume",
    label: "Resume Program",
    shortcut: "F9",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.activeRunning && ctx.stopped && !ctx.debug.isStepping,
    disabledReason: (ctx) => {
      if (!ctx.activeRunning) return "No active debug session";
      if (!ctx.stopped) return "Program is already running";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("continue");
    },
  },

  pause: {
    id: "pause",
    label: "Pause Program",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.activeRunning && !ctx.stopped && !ctx.debug.isStepping,
    disabledReason: (ctx) => {
      if (!ctx.activeRunning) return "No active debug session";
      if (ctx.stopped) return "Program is already paused";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("pause");
    },
  },

  stop: {
    id: "stop",
    label: "Stop",
    shortcut: "Ctrl+F2",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.activeRunning,
    disabledReason: (ctx) => (!ctx.activeRunning ? "No active debug session" : undefined),
    execute: (ctx) => {
      ctx.debug.terminate();
    },
  },

  restart: {
    id: "restart",
    label: "Restart",
    shortcut: "Ctrl+F5",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.activeRunning || ctx.debug.canRestart,
    disabledReason: (ctx) => (!ctx.activeRunning && !ctx.debug.canRestart ? "Cannot restart session" : undefined),
    execute: (ctx) => {
      ctx.debug.restart();
    },
  },

  hotReload: {
    id: "hotReload",
    label: "Hot Reload Classes",
    isSupported: (ctx) => isHotReloadSupported(ctx.debug.capabilities),
    isAvailable: (ctx) => ctx.activeRunning && isHotReloadSupported(ctx.debug.capabilities),
    disabledReason: (ctx) => {
      if (!isHotReloadSupported(ctx.debug.capabilities)) {
        return "Hot Reload is not supported by this debug adapter";
      }
      if (!ctx.activeRunning) return "No active debug session";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.hotReload();
    },
  },

  showExecutionPoint: {
    id: "showExecutionPoint",
    label: "Show Execution Point",
    shortcut: "Alt+F10",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.stopped && typeof ctx.onShowExecutionPoint === "function",
    disabledReason: (ctx) => (!ctx.stopped ? "Program is not stopped at a breakpoint or pause" : undefined),
    execute: (ctx) => {
      if (ctx.onShowExecutionPoint) {
        ctx.onShowExecutionPoint();
      }
    },
  },

  stepOver: {
    id: "stepOver",
    label: "Step Over",
    shortcut: "F8",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.stopped && !ctx.debug.isStepping,
    disabledReason: (ctx) => {
      if (!ctx.stopped) return "Program is running";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("stepOver");
    },
  },

  stepInto: {
    id: "stepInto",
    label: "Step Into",
    shortcut: "F7",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.stopped && !ctx.debug.isStepping,
    disabledReason: (ctx) => {
      if (!ctx.stopped) return "Program is running";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("stepIn");
    },
  },

  stepOut: {
    id: "stepOut",
    label: "Step Out",
    shortcut: "Shift+F8",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.stopped && !ctx.debug.isStepping,
    disabledReason: (ctx) => {
      if (!ctx.stopped) return "Program is running";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("stepOut");
    },
  },

  stepBack: {
    id: "stepBack",
    label: "Step Back",
    isSupported: (ctx) => ctx.debug.capabilities.supportsStepBack === true,
    isAvailable: (ctx) => ctx.stopped && !ctx.debug.isStepping && ctx.debug.capabilities.supportsStepBack === true,
    disabledReason: (ctx) => {
      if (!ctx.debug.capabilities.supportsStepBack) return "Step Back is not supported by this debug adapter";
      if (!ctx.stopped) return "Program is running";
      if (ctx.debug.isStepping) return "Stepping in progress";
      return undefined;
    },
    execute: async (ctx) => {
      await ctx.debug.step("stepBack" as DebugStepAction);
    },
  },

  restartFrame: {
    id: "restartFrame",
    label: "Restart Frame",
    isSupported: (ctx) => ctx.debug.capabilities.supportsRestartFrame === true,
    isAvailable: (ctx) => ctx.stopped && ctx.selectedFrameId != null && ctx.debug.capabilities.supportsRestartFrame === true,
    disabledReason: (ctx) => {
      if (!ctx.debug.capabilities.supportsRestartFrame) return "Restart Frame is not supported by this debug adapter";
      if (!ctx.stopped) return "Program is running";
      if (ctx.selectedFrameId == null) return "No stack frame selected";
      return undefined;
    },
    execute: async (ctx) => {
      if (ctx.selectedFrameId != null) {
        await ctx.debug.restartFrame(ctx.selectedFrameId);
      }
    },
  },

  runToCursor: {
    id: "runToCursor",
    label: "Run to Cursor",
    shortcut: "Alt+F9",
    isSupported: () => true,
    isAvailable: (ctx) => ctx.stopped && typeof ctx.onRunToCursor === "function" && ctx.targetCursorLine != null,
    disabledReason: (ctx) => {
      if (!ctx.stopped) return "Program is running";
      if (ctx.targetCursorLine == null) return "No cursor line specified";
      return undefined;
    },
    execute: (ctx) => {
      if (ctx.onRunToCursor && ctx.targetCursorLine != null) {
        ctx.onRunToCursor(ctx.targetCursorLine);
      }
    },
  },
};

export function getDebugAction(id: DebugActionId): DebugActionDescriptor {
  return debugActionDescriptors[id];
}
