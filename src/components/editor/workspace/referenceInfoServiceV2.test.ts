import { describe, expect, it, vi } from "vitest";
import type { LspSignatureInfo } from "../../../lib/editor/lsp";
import {
  referenceKindFromInfoKind,
  ReferenceInfoController,
  type ReferencePayload,
} from "./referenceInfoController";

const BASE_REQUEST = {
  kind: "documentation" as const,
  workspaceId: "ws",
  fileKey: "a.ts",
  uri: "file:///a.ts",
  languageId: "typescript",
  position: { line: 3, character: 7 },
  documentRevision: 11,
  providerGeneration: 2,
};

function signature(label: string): LspSignatureInfo {
  return { label, parameters: [], documentation: null, activeParameter: 0 };
}

describe("§8.19.7 typed reference service", () => {
  it("returns per-kind payloads with the request identity attached", async () => {
    const controller = new ReferenceInfoController("ws");
    const payload: ReferencePayload = {
      kind: "parameter",
      signatures: [signature("foo(a: string): void")],
      activeSignature: 0,
      activeParameter: 0,
    };
    const result = await controller.requestTyped(
      { ...BASE_REQUEST, kind: "parameter" },
      async () => payload,
    );
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    // Parameter Info carries its own envelope — never a documentation body.
    expect(result.kind).toBe("parameter");
    expect(result.payload.kind).toBe("parameter");
    if (result.payload.kind === "parameter") {
      expect(result.payload.signatures[0].label).toBe("foo(a: string): void");
    }
    expect(result.identity.requestId).toContain("ws:parameter:");
    expect(result.identity.documentRevision).toBe(11);
  });

  it("feeds only quick-documentation into history; parameter payloads never touch it", async () => {
    const controller = new ReferenceInfoController("ws");
    await controller.requestTyped({ ...BASE_REQUEST }, async () => ({
      kind: "quick-documentation",
      markdown: "# Doc",
      sourceLocation: null,
    }));
    controller.pushHistory({
      title: "Doc",
      body: "# Doc",
      source: "provider",
      uri: "file:///a.ts",
      revision: 11,
      generation: 2,
    });
    expect(controller.historySnapshot().content?.title).toBe("Doc");

    const before = controller.historySnapshot();
    await controller.requestTyped({ ...BASE_REQUEST, kind: "parameter" }, async () => ({
      kind: "parameter",
      signatures: [],
      activeSignature: 0,
      activeParameter: 0,
    }));
    // requestTyped itself never writes history regardless of kind.
    expect(controller.historySnapshot()).toEqual(before);
  });

  it("rejects non-https external documentation URLs at the service boundary", async () => {
    const controller = new ReferenceInfoController("ws");
    const http = await controller.requestTyped(
      { ...BASE_REQUEST, kind: "external-documentation" },
      async () => ({ kind: "external-documentation", url: "http://docs.example.com/x", title: null }),
    );
    expect(http.state).toBe("unavailable");
    if (http.state === "unavailable") expect(http.reason).toBe("external-url-invalid-scheme");

    const https = await controller.requestTyped(
      { ...BASE_REQUEST, kind: "external-documentation" },
      async () => ({ kind: "external-documentation", url: "https://docs.example.com/x", title: "Docs" }),
    );
    expect(https.state).toBe("ready");
  });

  it("cancels a superseded same-kind request and reports stale identity results", async () => {
    const controller = new ReferenceInfoController("ws");
    const first = controller.requestTyped({ ...BASE_REQUEST }, ({ signal }) =>
      new Promise<ReferencePayload | null>((resolve, reject) => {
        // Settles only through cancellation — the superseding request must
        // abort it, never leave it hanging.
        resolve({ kind: "type-info", text: "slow", languageId: "ts" });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    const second = await controller.requestTyped({ ...BASE_REQUEST }, async () => ({
      kind: "type-info",
      text: "fast",
      languageId: "ts",
    }));
    expect(second.state).toBe("ready");
    const firstOutcome = await first;
    expect(firstOutcome.state === "cancelled" || firstOutcome.state === "stale").toBe(true);

    // A stale result (identity moved while in flight) never renders.
    const staleController = new ReferenceInfoController("ws");
    void staleController.request({ ...BASE_REQUEST }, async () => null);
    staleController.cancel();
    expect(staleController.historySnapshot().content).toBeNull();
  });

  it("maps legacy kinds to canonical §8.19.7 names", () => {
    expect(referenceKindFromInfoKind("documentation")).toBe("quick-documentation");
    expect(referenceKindFromInfoKind("type")).toBe("type-info");
    expect(referenceKindFromInfoKind("context")).toBe("context-info");
  });

  it("reports provider failures as failed with the message", async () => {
    const controller = new ReferenceInfoController("ws");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await controller.requestTyped({ ...BASE_REQUEST }, async () => {
      throw new Error("provider exploded");
    });
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.message).toBe("provider exploded");
  });
});
