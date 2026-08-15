import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { workspaceSemanticIndexIsCurrent } from "./workspaceSemanticIndex";
import { useWorkspaceSemanticIndex } from "./useWorkspaceSemanticIndex";

describe("useWorkspaceSemanticIndex", () => {
  it("coordinates query generations and rejects results invalidated in flight", () => {
    const { result } = renderHook(() => useWorkspaceSemanticIndex("workspace"));
    let token!: ReturnType<typeof result.current.beginBuild>;
    act(() => {
      token = result.current.beginBuild("language-server");
      result.current.finishQuery(token, { kind: "symbols", resultCount: 3 });
    });
    expect(result.current.snapshot.status).toBe("ready");
    expect(workspaceSemanticIndexIsCurrent(result.current.snapshot)).toBe(true);

    act(() => {
      token = result.current.beginBuild("language-server");
      result.current.invalidate("document-edited", ["src/main.ts"]);
      result.current.finishQuery(token, { kind: "references", resultCount: 2 });
    });
    expect(result.current.snapshot.status).toBe("stale");
    expect(result.current.snapshot.lastQuery).toMatchObject({
      kind: "references",
      resultCount: 2,
    });
    expect(workspaceSemanticIndexIsCurrent(result.current.snapshot)).toBe(false);
  });

  it("resets state when the workspace identity changes", () => {
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useWorkspaceSemanticIndex(workspaceId),
      { initialProps: { workspaceId: "one" } },
    );
    act(() => {
      result.current.invalidate("external-file-change", ["a.ts"]);
    });
    expect(result.current.snapshot.revision).toBe(1);

    rerender({ workspaceId: "two" });
    expect(result.current.snapshot).toMatchObject({
      status: "stale",
      generation: 0,
      revision: 0,
      invalidatedPaths: [],
    });
  });

  it("advances the live revision before publishing a batched editor update", () => {
    const { result } = renderHook(() => useWorkspaceSemanticIndex("workspace"));
    act(() => {
      result.current.invalidateSilently("document-edited", ["src/main.ts"]);
    });
    expect(result.current.current().revision).toBe(1);
    expect(result.current.snapshot.revision).toBe(0);

    act(() => result.current.publishCurrent());
    expect(result.current.snapshot.revision).toBe(1);
  });

  it("keeps an older same-revision result usable without overwriting newer query metadata", () => {
    const { result } = renderHook(() => useWorkspaceSemanticIndex("workspace"));
    let oldToken!: ReturnType<typeof result.current.beginBuild>;
    let currentToken!: ReturnType<typeof result.current.beginBuild>;
    act(() => {
      oldToken = result.current.beginBuild("language-server");
      currentToken = result.current.beginBuild("language-server");
      const completion = result.current.finishQuery(oldToken, { kind: "symbols", resultCount: 99 });
      expect(completion.accepted).toBe(true);
      expect(completion.snapshot.generation).toBe(currentToken.generation);
      expect(completion.snapshot.indexedRevision).toBe(oldToken.revision);
    });
    expect(result.current.snapshot.status).toBe("building");
    expect(result.current.snapshot.lastQuery).toBeNull();

    act(() => {
      const completion = result.current.finishQuery(currentToken, { kind: "references", resultCount: 2 });
      expect(completion.accepted).toBe(true);
    });
    expect(result.current.snapshot.status).toBe("ready");
    expect(result.current.snapshot.lastQuery).toMatchObject({
      kind: "references",
      resultCount: 2,
      generation: currentToken.generation,
    });
  });
});
