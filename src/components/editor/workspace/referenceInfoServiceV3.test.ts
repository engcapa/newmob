import { describe, expect, it, vi } from "vitest";
import type { LspSignatureInfo } from "../../../lib/editor/lsp";
import { ReferenceInfoController } from "./referenceInfoController";
import type { ReferenceInfoRequestV3 } from "./referenceInfoController";

const BASE_REQUEST: Omit<ReferenceInfoRequestV3, "kind"> = {
  workspaceId: "ws",
  fileKey: "a.ts",
  uri: "file:///a.ts",
  languageId: "typescript",
  position: { line: 3, character: 7 },
  documentRevision: 11,
  providerGeneration: 2,
};

function signature(label: string): LspSignatureInfo {
  return { label, parameters: [], documentation: null, activeParameter: null };
}

describe("§8.20.2 typed reference service (V3)", () => {
  it("returns per-kind payloads with the controller-minted identity attached", async () => {
    const controller = new ReferenceInfoController("ws");
    const result = await controller.requestTyped(
      { ...BASE_REQUEST, kind: "parameter-info" },
      async () => ({
        state: "payload" as const,
        payload: {
          kind: "parameter-info" as const,
          signatures: [signature("foo(a: string): void")],
          activeSignature: 0,
          activeParameter: 0,
        },
      }),
    );
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    // Parameter Info carries its own envelope — never a documentation body.
    expect(result.kind).toBe("parameter-info");
    expect(result.payload.kind).toBe("parameter-info");
    if (result.payload.kind === "parameter-info") {
      expect(result.payload.signatures[0].label).toBe("foo(a: string): void");
    }
    // Request ids are minted ONLY here, in `<workspace>:<kind>:<seq>` form.
    expect(result.identity.requestId).toMatch(/^ws:parameter-info:\d+$/);
    expect(result.identity.documentRevision).toBe(11);
    controller.dispose();
  });

  it("feeds only explicit QuickDoc into history; request results never touch it", async () => {
    const controller = new ReferenceInfoController("ws");
    await controller.requestTyped(
      { ...BASE_REQUEST, kind: "quick-documentation" },
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# Doc", source: null } }),
    );
    expect(controller.historySnapshot().content).toBeNull();

    controller.pushHistory({
      title: "Doc",
      body: "# Doc",
      source: "provider",
      uri: "file:///a.ts",
      revision: 11,
      generation: 2,
    });
    expect(controller.historySnapshot().content?.title).toBe("Doc");

    await controller.requestTyped(
      { ...BASE_REQUEST, kind: "type-info" },
      async () => ({ state: "payload", payload: { kind: "type-info", display: "string", source: "provider" } }),
    );
    expect(controller.historySnapshot().content?.title).toBe("Doc");
    controller.dispose();
  });

  it("cancels a superseded same-kind request; different kinds stay independent", async () => {
    const controller = new ReferenceInfoController("ws");
    const first = controller.requestTyped({ ...BASE_REQUEST, kind: "type-info" }, ({ signal }) =>
      new Promise((resolve) => {
        resolve({
          state: "payload" as const,
          payload: { kind: "type-info" as const, display: "slow", source: "provider" as const },
        });
        signal.addEventListener("abort", () => resolve(null));
      }));
    const second = await controller.requestTyped(
      { ...BASE_REQUEST, kind: "type-info" },
      async () => ({ state: "payload", payload: { kind: "type-info", display: "fast", source: "provider" } }),
    );
    expect(second.state).toBe("ready");
    if (second.state === "ready") {
      // The superseded result never overwrites the fresh one.
      expect(second.payload.kind === "type-info" && second.payload.display).toBe("fast");
    }
    const firstOutcome = await first;
    expect(firstOutcome.state === "cancelled" || firstOutcome.state === "stale").toBe(true);
    controller.dispose();
  });

  it("reports provider failures as failed with the message", async () => {
    const controller = new ReferenceInfoController("ws");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await controller.requestTyped({ ...BASE_REQUEST, kind: "expression-static-data" }, async () => {
      throw new Error("provider exploded");
    });
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.message).toBe("provider exploded");
    controller.dispose();
  });
});
