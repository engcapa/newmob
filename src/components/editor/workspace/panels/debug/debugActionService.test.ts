import { describe, expect, it, vi } from "vitest";
import {
  createDebugActionService,
  isHotReloadSupported,
  type DebugActionContext,
} from "./debugActionService";
import type { CodeDebugSession } from "../../useCodeDebugSession";

describe("debugActionService (D6.3)", () => {
  it("evaluates hot reload support capabilities", () => {
    expect(isHotReloadSupported(undefined)).toBe(false);
    expect(isHotReloadSupported({})).toBe(false);
    expect(isHotReloadSupported({ supportsHotReload: true })).toBe(true);
    expect(isHotReloadSupported({ "java.redefineClasses": true })).toBe(true);
    expect(isHotReloadSupported({ supportsRedefineClasses: true })).toBe(true);
  });

  it("dispatches debug action and returns typed ActionResult", async () => {
    const mockStep = vi.fn().mockResolvedValue(undefined);
    const mockDebug = {
      isStepping: false,
      step: mockStep,
      terminate: vi.fn(),
      restart: vi.fn(),
      capabilities: {},
    } as unknown as CodeDebugSession;

    const ctx: DebugActionContext = {
      debug: mockDebug,
      activeRunning: true,
      stopped: true,
    };

    const service = createDebugActionService(() => ctx);

    const state = service.getState("resume");
    expect(state.supported).toBe(true);
    expect(state.available).toBe(true);

    const result = await service.execute("resume");
    expect(result.kind).toBe("applied");
    expect(result.requestId).toMatch(/^dbg-resume-/);
    expect(mockStep).toHaveBeenCalledWith("continue");
  });

  it("handles cancelled signal gracefully", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockDebug = {
      isStepping: false,
      step: vi.fn(),
      capabilities: {},
    } as unknown as CodeDebugSession;

    const ctx: DebugActionContext = {
      debug: mockDebug,
      activeRunning: true,
      stopped: true,
    };

    const service = createDebugActionService(() => ctx);
    const result = await service.execute("resume", undefined, controller.signal);
    expect(result.kind).toBe("cancelled");
  });
});
