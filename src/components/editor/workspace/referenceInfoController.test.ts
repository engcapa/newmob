import { describe, expect, it } from "vitest";
import { ReferenceInfoController, type ReferenceInfoRequest } from "./referenceInfoController";

function request(overrides: Partial<ReferenceInfoRequest> = {}): ReferenceInfoRequest {
  return {
    kind: "documentation",
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

describe("ReferenceInfoController", () => {
  it("cancels the prior request of the same kind", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    const first = controller.request(request(), ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(content("cancelled")));
    }));
    const second = controller.request(request({ documentRevision: 4 }), async () => content("new"));

    await expect(second).resolves.toEqual({ kind: "available", content: content("new") });
    await expect(first).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("rejects requests from another workspace", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    await expect(controller.request(
      request({ workspaceId: "workspace-b" }),
      async () => content("wrong"),
    )).resolves.toEqual({ kind: "cancelled", requestId: "disposed" });
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

  it("clears pending work and history on dispose", async () => {
    const controller = new ReferenceInfoController("workspace-a");
    controller.pushHistory(content("one"));
    const pending = controller.request(request(), ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(content("late")));
    }));
    controller.dispose();
    await expect(pending).resolves.toMatchObject({ kind: "cancelled" });
    expect(controller.historySnapshot()).toEqual({ content: null, canGoBack: false, canGoForward: false });
  });
});
