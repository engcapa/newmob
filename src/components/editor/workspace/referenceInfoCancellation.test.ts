import { describe, expect, it } from "vitest";
import { ReferenceInfoController } from "./referenceInfoController";
import type { ReferenceInfoRequestV3 } from "./referenceInfoController";

function request(overrides: Partial<ReferenceInfoRequestV3> = {}): ReferenceInfoRequestV3 {
  return {
    kind: "quick-documentation",
    workspaceId: "ws-ref",
    fileKey: "k1",
    uri: "file:///p/A.java",
    languageId: "java",
    position: { line: 0, character: 6 },
    documentRevision: 3,
    providerGeneration: 1,
    ...overrides,
  };
}

const readyDoc = async () => ({
  state: "payload" as const,
  payload: { kind: "quick-documentation" as const, markdown: "# doc", source: null },
});

describe("§8.18.6 provider-deferred cancellation (§8.20.2 V3 channel)", () => {
  it("the provider receives a live signal and cancellation is observed before results land", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    let observedAbort = false;

    const first = controller.requestTyped(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve(null);
      }, { once: true });
      // Stays pending until the superseding request aborts it.
    }));

    // A superseding same-kind request cancels the previous in-flight one.
    const second = controller.requestTyped(request({ documentRevision: 4 }), readyDoc);
    await Promise.resolve();
    expect(observedAbort).toBe(true);
    const firstOutcome = await first;
    expect(firstOutcome.state).toBe("cancelled");
    const secondOutcome = await second;
    expect(secondOutcome.state).toBe("ready");
    controller.dispose();
  });

  it("explicit cancel() aborts the in-flight ticket for the kind only", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    let sawAbort = false;
    let otherKindAborted = false;
    const pending = controller.requestTyped(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(null); }, { once: true });
    }));
    void controller.requestTyped(request({ kind: "type-info" }), ({ signal }) =>
      new Promise<null>((resolve) => {
        signal.addEventListener("abort", () => { otherKindAborted = true; resolve(null); }, { once: true });
      }));
    controller.cancel("quick-documentation");
    const outcome = await pending;
    expect(sawAbort).toBe(true);
    expect(otherKindAborted).toBe(false);
    expect(outcome.state).toBe("cancelled");
    controller.dispose();
  });

  it("dispose() rejects cross-workspace leakage with cancelled", async () => {
    const controller = new ReferenceInfoController("ws-other");
    const outcome = await controller.requestTyped(request(), readyDoc);
    expect(outcome.state).toBe("cancelled");
    controller.dispose();
  });

  it("does not record an aborted null as no-symbol", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    const pending = controller.requestTyped(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    controller.cancel("quick-documentation");
    const outcome = await pending;
    // Cancelled — NOT unavailable/no-symbol.
    expect(outcome.state).toBe("cancelled");
    controller.dispose();
  });

  it("a superseded request that resolves late reports stale/cancelled, never ready", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    const rejectFirstRef: { current: ((error: Error) => void) | null } = { current: null };
    const first = controller.requestTyped(
      request({ kind: "parameter-info" }),
      ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        rejectFirstRef.current = reject;
      }),
    );
    const second = await controller.requestTyped(
      request({ kind: "parameter-info" }),
      async () => ({
        state: "payload" as const,
        payload: {
          kind: "parameter-info" as const,
          signatures: [{ label: "f(a)", parameters: [], documentation: null, activeParameter: null }],
          activeSignature: 0,
          activeParameter: 0,
        },
      }),
    );
    expect(second.state).toBe("ready");
    const firstOutcome = await first.catch(() => null);
    // The abort fired; if the provider still settles afterwards the result
    // must never surface as ready.
    rejectFirstRef.current?.(new Error("late"));
    expect(["cancelled", "stale"]).toContain(firstOutcome?.state);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// §8.18.6 External Documentation URL policy
// ---------------------------------------------------------------------------

describe("§8.18.6 external documentation URL allowlist", () => {
  it("allows https and configured http, rejects credential/file/js URLs", async () => {
    const { validateExternalDocUrl } = await import("./referenceDocumentation");
    expect(validateExternalDocUrl("https://docs.example.com/a")).toEqual({ kind: "allowed", url: "https://docs.example.com/a" });
    expect(validateExternalDocUrl("http://intranet/docs", { allowHttp: true }).kind).toBe("allowed");
    // Plain http is denied unless the workspace policy opts in.
    expect(validateExternalDocUrl("http://intranet/docs").kind).toBe("unavailable");
    for (const bad of [
      "file:///etc/passwd",
      "javascript:void(0)",
      "data:text/html,x",
      "https://user:pass@example.com",
      "not a url",
      "",
    ]) {
      expect(validateExternalDocUrl(bad).kind, bad).toBe("unavailable");
    }
  });
});
