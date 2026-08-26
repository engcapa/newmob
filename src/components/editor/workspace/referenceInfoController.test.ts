import { describe, expect, it } from "vitest";
import {
  isLegacyContextInfoKind,
  LEGACY_CONTEXT_INFO_REASON,
  migrateLegacyContextInfoRecord,
  ReferenceInfoController,
  type ReferenceInfoRequestV3,
  type ReferenceProviderOutcome,
} from "./referenceInfoController";
import type { LspSignatureInfo } from "../../../lib/editor/lsp";

function request(overrides: Partial<ReferenceInfoRequestV3> = {}): ReferenceInfoRequestV3 {
  return {
    kind: "quick-documentation",
    workspaceId: "workspace-a",
    fileKey: "root:src/main.ts",
    uri: "file:///repo/src/main.ts",
    languageId: "typescript",
    position: { line: 0, character: 2 },
    documentRevision: 3,
    providerGeneration: 7,
    ...overrides,
  };
}

const content = (title: string) => ({
  title,
  body: `${title} documentation`,
  source: "TypeScript Language Server",
  uri: `file:///repo/${title}.ts`,
  revision: 3,
  generation: 7,
});

describe("ReferenceInfoController §8.20.2 V3", () => {
  it("supersedes the prior in-flight request of the same kind", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    const first = controller.requestTyped(request(), ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null));
    }));
    const second = controller.requestTyped(
      request({ documentRevision: 4 }),
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# new", source: null } }),
    );

    await expect(second).resolves.toMatchObject({ state: "ready" });
    await expect(first).resolves.toMatchObject({ state: "cancelled" });
    controller.dispose();
  });

  it("runs different kinds concurrently without superseding each other", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    let parameterSettled = false;
    const parameter = controller.requestTyped(
      request({ kind: "parameter-info" }),
      ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(null));
        setTimeout(() => {
          parameterSettled = true;
          resolve({
            state: "payload",
            payload: { kind: "parameter-info", signatures: [{ label: "f(a)", parameters: [], documentation: null, activeParameter: null }], activeSignature: 0, activeParameter: 0 },
          });
        }, 10);
      }),
    );
    const doc = await controller.requestTyped(
      request(),
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# doc", source: null } }),
    );
    expect(doc.state).toBe("ready");
    const parameterResult = await parameter;
    expect(parameterSettled).toBe(true);
    expect(parameterResult.state).toBe("ready");
    controller.dispose();
  });

  it("rejects requests from another workspace and unknown kinds", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    await expect(controller.requestTyped(
      request({ workspaceId: "workspace-b" }),
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "x", source: null } }),
    )).resolves.toEqual({ state: "cancelled", requestId: "disposed" });
    // Legacy context-info kinds never reach a provider: they migrate.
    await expect(controller.requestTyped(
      request({ kind: "context-info" as never }),
      async () => null,
    )).resolves.toEqual({
      state: "unavailable",
      kind: "expression-static-data",
      reason: LEGACY_CONTEXT_INFO_REASON,
    });
    controller.dispose();
  });

  it("owns independent Back and Forward history", () => {
    const first = new ReferenceInfoController("workspace-a");
    const second = new ReferenceInfoController("workspace-b");
    first.pushHistory(content("one"));
    expect(first.pushHistory(content("two"))).toMatchObject({ canGoBack: true, canGoForward: false });
    expect(first.goBack()).toMatchObject({ content: content("one"), canGoForward: true });
    expect(first.goForward()).toMatchObject({ content: content("two"), canGoBack: true });
    expect(second.historySnapshot()).toEqual({ content: null, canGoBack: false, canGoForward: false });
  });

  it("clears pending work, lastReady and history on dispose", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    controller.pushHistory(content("one"));
    await controller.requestTyped(
      request(),
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# d", source: null } }),
    );
    const pending = controller.requestTyped(request(), ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null));
    }));
    controller.dispose();
    await expect(pending).resolves.toMatchObject({ state: "cancelled" });
    expect(controller.historySnapshot()).toEqual({ content: null, canGoBack: false, canGoForward: false });
    expect(controller.lastReady("quick-documentation")).toBeNull();
  });

  it("validates payloads per kind at the boundary", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    const signature: LspSignatureInfo = { label: "f(a: string)", parameters: [], documentation: null, activeParameter: null };
    const run = (kind: ReferenceInfoRequestV3["kind"], outcome: ReferenceProviderOutcome) =>
      controller.requestTyped(request({ kind }), async () => outcome);

    await expect(run("parameter-info", { state: "payload", payload: { kind: "parameter-info", signatures: [], activeSignature: 0, activeParameter: 0 } }))
      .resolves.toMatchObject({ state: "unavailable", reason: "empty-signatures" });
    await expect(run("parameter-info", { state: "payload", payload: { kind: "parameter-info", signatures: [signature], activeSignature: 0, activeParameter: 0 } }))
      .resolves.toMatchObject({ state: "ready" });
    await expect(run("quick-documentation", { state: "payload", payload: { kind: "quick-documentation", markdown: "   ", source: null } }))
      .resolves.toMatchObject({ state: "unavailable", reason: "empty-documentation" });
    await expect(run("type-info", { state: "payload", payload: { kind: "type-info", display: "", source: "provider" } }))
      .resolves.toMatchObject({ state: "unavailable", reason: "empty-type" });
    await expect(run("expression-static-data", { state: "payload", payload: { kind: "expression-static-data", facts: [], source: "provider" } }))
      .resolves.toMatchObject({ state: "unavailable", reason: "empty-facts" });
    await expect(run("expression-static-data", {
      state: "payload",
      payload: { kind: "expression-static-data", facts: [{ id: "f1", label: "value", value: "1" }], source: "provider" },
    })).resolves.toMatchObject({ state: "ready" });
    // https-only policy enforced inside the controller, not by callers.
    await expect(run("external-documentation", { state: "payload", payload: { kind: "external-documentation", url: "http://docs.example.com/x", title: "Docs" } }))
      .resolves.toMatchObject({ state: "unavailable", reason: "external-url-invalid-scheme" });
    await expect(run("external-documentation", { state: "payload", payload: { kind: "external-documentation", url: "https://docs.example.com/x", title: "Docs" } }))
      .resolves.toMatchObject({ state: "ready" });
    controller.dispose();
  });

  it("propagates provider-declared unavailability reasons verbatim", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    await expect(controller.requestTyped(
      request({ kind: "type-info" }),
      async () => ({ state: "unavailable", reason: "provider-no-type-info-channel" }),
    )).resolves.toEqual({
      state: "unavailable",
      kind: "type-info",
      reason: "provider-no-type-info-channel",
    });
    await expect(controller.requestTyped(
      request({ kind: "expression-static-data" }),
      async () => null,
    )).resolves.toMatchObject({ state: "unavailable", reason: "no-symbol" });
    controller.dispose();
  });

  it("records lastReady only on ready results, keyed by kind", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    expect(controller.lastReady("quick-documentation")).toBeNull();
    const ready = await controller.requestTyped(
      request(),
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# doc", source: null } }),
    );
    expect(ready.state).toBe("ready");
    expect(controller.lastReady("quick-documentation")?.payload).toMatchObject({ kind: "quick-documentation" });
    expect(controller.lastReady("type-info")).toBeNull();
    // Unavailable results never overwrite the fact source.
    await controller.requestTyped(
      request({ kind: "parameter-info" }),
      async () => null,
    );
    expect(controller.lastReady("parameter-info")).toBeNull();
    controller.dispose();
  });

  it("rejects a payload whose kind does not match the request", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    const result = await controller.requestTyped(
      request({ kind: "type-info" }),
      // A provider trying to smuggle documentation through a type-info
      // request fails loudly instead of rendering.
      async () => ({ state: "payload", payload: { kind: "quick-documentation", markdown: "# x", source: null } }) as never,
    );
    expect(result.state).toBe("failed");
    controller.dispose();
  });

  it("migrates every legacy context-info spelling to explicit unavailable", () => {
    expect(isLegacyContextInfoKind("context")).toBe(true);
    expect(isLegacyContextInfoKind("context-info")).toBe(true);
    expect(isLegacyContextInfoKind("expression-static-data")).toBe(false);
    expect(migrateLegacyContextInfoRecord()).toEqual({
      state: "unavailable",
      kind: "expression-static-data",
      reason: LEGACY_CONTEXT_INFO_REASON,
    });
  });
});
