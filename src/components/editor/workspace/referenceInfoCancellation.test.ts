import { describe, expect, it } from "vitest";
import { ReferenceInfoController } from "./referenceInfoController";

function request(overrides: Partial<Parameters<ReferenceInfoController["request"]>[0]> = {}) {
  return {
    kind: "documentation" as const,
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

describe("§8.18.6 provider-deferred cancellation", () => {
  it("the provider receives a live signal and cancellation is observed before results land", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    let observedAbort = false;

    const first = controller.request(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve(null);
      }, { once: true });
      // Stays pending until the superseding request aborts it.
    }));

    // A superseding request cancels the previous in-flight one.
    const second = controller.request(request({ documentRevision: 4 }), async () => ({ title: "t", body: "b", source: "LS" }));
    await Promise.resolve();
    expect(observedAbort).toBe(true);
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe("cancelled");
    const secondOutcome = await second;
    expect(secondOutcome.kind).toBe("available");
    controller.dispose();
  });

  it("explicit cancel() aborts the in-flight ticket for the kind", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    let sawAbort = false;
    const pending = controller.request(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(null); }, { once: true });
    }));
    controller.cancel("documentation");
    const outcome = await pending;
    expect(sawAbort).toBe(true);
    expect(outcome.kind).toBe("cancelled");
    controller.dispose();
  });

  it("dispose() rejects cross-workspace leakage with cancelled", async () => {
    const controller = new ReferenceInfoController("ws-other");
    const outcome = await controller.request(request(), async () => ({ title: "t", body: "b", source: "LS" }));
    expect(outcome.kind).toBe("cancelled");
    controller.dispose();
  });

  it("does not record an aborted null as no-symbol", async () => {
    const controller = new ReferenceInfoController("ws-ref");
    const pending = controller.request(request(), ({ signal }) => new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    }));
    controller.cancel("documentation");
    const outcome = await pending;
    // Cancelled — NOT unavailable/no-symbol.
    expect(outcome.kind).toBe("cancelled");
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
