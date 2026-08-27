import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceInfoController } from "./referenceInfoController";
import {
  ParameterInfoSession,
  type ParameterDisplayState,
  type ReferenceSessionContext,
} from "./referenceInfoSession";

function context(overrides: Partial<ReferenceSessionContext> = {}): ReferenceSessionContext {
  return {
    fileKey: "a.ts",
    uri: "file:///a.ts",
    languageId: "typescript",
    documentRevision: 5,
    providerGeneration: 1,
    ...overrides,
  };
}

const trigger = (overrides: Partial<Parameters<ParameterInfoSession["request"]>[0]> = {}) => ({
  position: { line: 1, character: 8 },
  anchorOffset: 12,
  triggerCharacter: null,
  origin: "explicit" as const,
  ...overrides,
});

const READY_PAYLOAD = {
  state: "payload" as const,
  payload: {
    kind: "parameter-info" as const,
    signatures: [{ label: "open(path: string, mode: number)", parameters: [], documentation: null, activeParameter: null }],
    activeSignature: 0,
    activeParameter: 1,
  },
};
const readySignatures = async () => READY_PAYLOAD;

describe("ParameterInfoSession §8.20.2 single channel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("explicit requests bypass the configured delay", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller, {
      preferences: { autoPopup: true, delayMs: 400, showFullSignatures: false },
    });
    session.setContext(context());
    const provider = vi.fn(readySignatures);
    expect(session.request(trigger({ origin: "explicit" }), provider)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({
      phase: "shown",
      view: { activeParameter: 1, anchorOffset: 12 },
    });
    session.dispose();
  });

  it("typed triggers honour the auto-popup gate and delay preference", async () => {
    const controller = new ReferenceInfoController("ws");
    const provider = vi.fn(readySignatures);

    // Gate off → typed triggers never fire.
    const gated = new ParameterInfoSession(controller, {
      preferences: { autoPopup: false, delayMs: 100, showFullSignatures: false },
    });
    gated.setContext(context());
    expect(gated.request(trigger({ origin: "typing", triggerCharacter: "(" }), provider)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(provider).not.toHaveBeenCalled();

    // Gate on → the request waits out the full configured delay.
    const delayed = new ParameterInfoSession(controller, {
      preferences: { autoPopup: true, delayMs: 250, showFullSignatures: false },
    });
    delayed.setContext(context());
    expect(delayed.request(trigger({ origin: "typing", triggerCharacter: "(" }), provider)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(provider).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(provider).toHaveBeenCalledTimes(1);
    gated.dispose();
    delayed.dispose();
  });

  it("closes tooltips when identity moves; late results never resurrect them", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller);
    const resolveLateRef: { current: ((value: typeof READY_PAYLOAD | null) => void) | null } = { current: null };
    session.setContext(context());

    // In-flight request whose answer arrives only after cancellation.
    void session.request(
      trigger({ origin: "explicit" }),
      () => new Promise<typeof READY_PAYLOAD | null>((resolve) => {
        resolveLateRef.current = resolve;
      }),
    );
    expect(session.getState().phase).toBe("pending");

    // Document edit closes the OLD tooltip (§8.20.2).
    session.setContext(context({ documentRevision: 6 }));
    expect(session.getState().phase).toBe("hidden");

    // The cancelled request's eventual answer must not resurrect the popup.
    resolveLateRef.current?.(READY_PAYLOAD);
    await vi.advanceTimersByTimeAsync(10);
    expect(session.getState().phase).toBe("hidden");

    // A fresh request on the new identity still shows…
    void session.request(trigger(), readySignatures);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().phase).toBe("shown");
    // …and a provider restart (generation change) closes it again.
    session.invalidate("provider-changed");
    expect(session.getState().phase).toBe("hidden");
    session.dispose();
  });

  it("caret moves without an edit dismiss via invalidate", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller);
    session.setContext(context());
    void session.request(trigger(), readySignatures);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().phase).toBe("shown");
    session.invalidate("caret-moved");
    expect(session.getState().phase).toBe("hidden");
    session.dispose();
  });

  it("escape cancels only this kind and reports whether UI was showing", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller);
    session.setContext(context());

    // Nothing open → Esc must NOT claim the keystroke.
    expect(session.escape()).toBe(false);

    void session.request(trigger(), readySignatures);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().phase).toBe("shown");
    expect(session.escape()).toBe(true);
    expect(session.getState().phase).toBe("hidden");

    // A pending delayed schedule is also cancelled by Esc.
    const delayed = new ParameterInfoSession(controller, {
      preferences: { autoPopup: true, delayMs: 300, showFullSignatures: false },
    });
    delayed.setContext(context());
    const provider = vi.fn(readySignatures);
    delayed.request(trigger({ origin: "typing", triggerCharacter: "(" }), provider);
    expect(delayed.escape()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(provider).not.toHaveBeenCalled();
    delayed.dispose();
  });

  it("an empty provider answer resolves hidden, never shown", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller);
    session.setContext(context());
    void session.request(
      trigger({ origin: "explicit" }),
      async () => ({ state: "unavailable" as const, reason: "no-symbol" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().phase).toBe("hidden");
    session.dispose();
  });

  it("stale schedules (identity moved during the delay) never reach the provider", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller, {
      preferences: { autoPopup: true, delayMs: 100, showFullSignatures: false },
    });
    session.setContext(context());
    const provider = vi.fn(readySignatures);
    session.request(trigger({ origin: "typing", triggerCharacter: "(" }), provider);
    // Identity moved while the delay was running.
    session.setContext(context({ documentRevision: 7 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(provider).not.toHaveBeenCalled();
    expect(session.getState().phase).toBe("hidden");
    session.dispose();
  });

  it("publishes every display transition to subscribers", async () => {
    const controller = new ReferenceInfoController("ws");
    const session = new ParameterInfoSession(controller);
    const seen: ParameterDisplayState["phase"][] = [];
    session.subscribe((state) => seen.push(state.phase));
    session.setContext(context());
    void session.request(trigger(), readySignatures);
    await vi.advanceTimersByTimeAsync(0);
    session.invalidate("closing-char");
    expect(seen).toEqual(["hidden", "pending", "shown", "hidden"]);
    session.dispose();
  });
});
