import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitLineChange } from "./gitEditorChrome";
import { useDeferredGitLineChanges } from "./useDeferredGitLineChanges";

const changed: GitLineChange[] = [{
  kind: "modified",
  startLine: 0,
  endLine: 0,
  oldStartLine: 0,
  oldEndLine: 0,
  oldText: "before",
  newText: "after",
}];

describe("useDeferredGitLineChanges", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces text changes and only computes the latest visible buffer after idle", () => {
    vi.useFakeTimers();
    const buildChanges = vi.fn(() => changed);
    const initial = [{
      key: "main.rs",
      sourceKey: "head-1",
      headText: "before",
      bufferText: "first",
    }];
    const { result, rerender } = renderHook(
      ({ sources }) => useDeferredGitLineChanges(sources, { delayMs: 100, buildChanges }),
      { initialProps: { sources: initial } },
    );

    rerender({ sources: [{ ...initial[0], bufferText: "second" }] });
    rerender({ sources: [{ ...initial[0], bufferText: "final" }] });
    act(() => vi.advanceTimersByTime(99));
    expect(buildChanges).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    act(() => vi.runOnlyPendingTimers());
    expect(buildChanges).toHaveBeenCalledTimes(1);
    expect(buildChanges).toHaveBeenCalledWith("before", "final");
    expect(result.current["main.rs"]).toEqual(changed);
  });

  it("reuses a cached diff when the active buffer has not changed", () => {
    vi.useFakeTimers();
    const buildChanges = vi.fn(() => changed);
    const source = {
      key: "main.rs",
      sourceKey: "head-1",
      headText: "before",
      bufferText: "after",
    };
    const { rerender } = renderHook(
      ({ sources }) => useDeferredGitLineChanges(sources, { delayMs: 10, buildChanges }),
      { initialProps: { sources: [source] } },
    );

    act(() => vi.runAllTimers());
    rerender({ sources: [{ ...source }] });
    act(() => vi.runAllTimers());
    expect(buildChanges).toHaveBeenCalledTimes(1);
  });

  it("does not restart debounce timer on equivalent source rerenders to prevent starvation", () => {
    vi.useFakeTimers();
    const buildChanges = vi.fn(() => changed);
    const source = {
      key: "main.rs",
      sourceKey: "head-1",
      headText: "before",
      bufferText: "first",
    };
    const { rerender } = renderHook(
      ({ sources }) => useDeferredGitLineChanges(sources, { delayMs: 100, buildChanges }),
      { initialProps: { sources: [source] } },
    );

    // Unrelated re-renders pass new array references with identical content at 50ms and 80ms
    act(() => vi.advanceTimersByTime(50));
    rerender({ sources: [{ ...source }] });
    act(() => vi.advanceTimersByTime(30));
    rerender({ sources: [{ ...source }] });

    // At 100ms from initial render, the debounce timer should fire (not delayed by rerenders)
    act(() => vi.advanceTimersByTime(20));
    act(() => vi.runOnlyPendingTimers());
    expect(buildChanges).toHaveBeenCalledTimes(1);
    expect(buildChanges).toHaveBeenCalledWith("before", "first");
  });
});
