import { describe, expect, it } from "vitest";
import { TerminalImeInputGuard } from "./terminalImeGuard";

function createGuard() {
  let now = 0;
  let timerCallback: (() => void) | null = null;
  const commits: string[] = [];

  const guard = new TerminalImeInputGuard({
    commit: (data) => commits.push(data),
    now: () => now,
    setTimer: (callback) => {
      timerCallback = callback;
      return 1 as unknown as ReturnType<typeof window.setTimeout>;
    },
    clearTimer: () => {
      timerCallback = null;
    },
  });

  return {
    guard,
    commits,
    advance: (ms: number) => {
      now += ms;
    },
    hasTimer: () => timerCallback !== null,
    runTimer: () => {
      const callback = timerCallback;
      if (callback) callback();
    },
  };
}

describe("TerminalImeInputGuard", () => {
  it("suppresses preedit data during composition and commits compositionend text itself", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionUpdate("你");

    expect(state.guard.filterTerminalData("n")).toBeNull();
    expect(state.guard.filterTerminalData("你")).toBeNull();

    state.guard.handleCompositionEnd("你好");

    expect(state.hasTimer()).toBe(false);
    expect(state.commits).toEqual(["你好"]);
    expect(state.guard.filterTerminalData("你好")).toBeNull();

    state.advance(10);
    expect(state.guard.filterTerminalData("你好")).toBeNull();
  });

  it("falls back to committing composition text when xterm emits no final data", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("");
    state.guard.handleInput("中文", "insertText");
    state.runTimer();

    expect(state.commits).toEqual(["中文"]);
    expect(state.guard.filterTerminalData("中文")).toBeNull();
  });

  it("uses beforeinput text when compositionend does not carry committed data", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleBeforeInput("测试", "insertCompositionText");
    state.guard.handleCompositionEnd("");
    state.runTimer();

    expect(state.commits).toEqual(["测试"]);
  });

  it("uses late input text when WebKitGTK reports compositionend before final data", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("");
    state.guard.handleInput("测试", "insertText");

    expect(state.commits).toEqual(["测试"]);
    expect(state.guard.filterTerminalData("测试")).toBeNull();
  });

  it("suppresses fragmented post-composition data and commits the full text once", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("你好");

    expect(state.guard.filterTerminalData("你")).toBeNull();
    expect(state.guard.filterTerminalData("好")).toBeNull();

    state.runTimer();
    expect(state.commits).toEqual(["你好"]);
    expect(state.guard.filterTerminalData("你")).toBeNull();
  });

  it("collapses duplicated committed text emitted by xterm on Linux IMEs", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("中");

    expect(state.commits).toEqual(["中"]);
    expect(state.guard.filterTerminalData("中中")).toBeNull();
    expect(state.guard.filterTerminalData("中")).toBeNull();
  });

  it("collapses duplicated commit prefixes while preserving following control input", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleBeforeInput("中", "insertCompositionText");
    state.guard.handleCompositionEnd("中");

    expect(state.commits).toEqual(["中"]);
    expect(state.guard.filterTerminalData("中中\r")).toBe("\r");
  });

  it("strips the previously committed IME prefix that fcitx5 can include in the next xterm payload", () => {
    const state = createGuard();
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("这");
    expect(state.guard.filterTerminalData("这")).toBeNull();

    state.advance(200);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("这是");
    expect(state.guard.filterTerminalData("这是")).toBeNull();

    state.advance(200);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("是一个");
    expect(state.guard.filterTerminalData("是一个")).toBeNull();

    state.advance(200);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("一个问题");
    expect(state.guard.filterTerminalData("一个问题")).toBeNull();

    expect(state.commits.join("")).toBe("这是一个问题");
  });

  it("strips a stale preedit fragment before the previous committed prefix", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("是");
    expect(state.guard.filterTerminalData("是")).toBeNull();

    state.advance(200);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("一是一个");

    expect(state.commits).toEqual(["是", "一个"]);
    expect(state.guard.filterTerminalData("一是一个")).toBeNull();
  });

  it("keeps a longer reliable input candidate when the last composition update was partial", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionUpdate("哈");
    state.guard.handleCompositionEnd("");
    state.guard.handleInput("哈哈", "insertText");

    expect(state.commits).toEqual(["哈哈"]);
    expect(state.guard.filterTerminalData("哈哈")).toBeNull();
  });

  it("does not treat a new composition of the same text as a duplicate", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("哈");
    expect(state.commits).toEqual(["哈"]);
    expect(state.guard.filterTerminalData("哈")).toBeNull();

    state.advance(220);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("哈");

    expect(state.commits).toEqual(["哈", "哈"]);
    expect(state.guard.filterTerminalData("哈")).toBeNull();
  });

  it("handles ASCII text committed through fcitx5 without letting cumulative xterm data through", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("a");
    expect(state.guard.filterTerminalData("a")).toBeNull();

    state.advance(220);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("ab");
    expect(state.guard.filterTerminalData("ab")).toBeNull();

    state.advance(220);
    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("abc");
    expect(state.guard.filterTerminalData("abc")).toBeNull();

    expect(state.commits.join("")).toBe("abc");
  });

  it("handles later fcitx5 commits even when WebKitGTK skips compositionstart", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("这");
    state.advance(100);
    state.guard.handleCompositionEnd("是");
    state.advance(100);
    state.guard.handleCompositionEnd("一个");
    state.advance(100);
    state.guard.handleCompositionEnd("问题");

    expect(state.commits.join("")).toBe("这是一个问题");
  });

  it("does not double commit a repeated compositionend payload in the same suppress window", () => {
    const state = createGuard();

    state.guard.handleCompositionStart();
    state.guard.handleCompositionEnd("这");
    state.guard.handleCompositionEnd("这");

    expect(state.commits).toEqual(["这"]);
  });

  it("does not suppress normal input outside an IME composition window", () => {
    const state = createGuard();

    expect(state.guard.filterTerminalData("中")).toBe("中");
    state.advance(10);
    expect(state.guard.filterTerminalData("中")).toBe("中");
    expect(state.guard.filterTerminalData("a")).toBe("a");
    expect(state.guard.filterTerminalData("\r")).toBe("\r");
    expect(state.guard.filterTerminalData("\x1b[A")).toBe("\x1b[A");
  });
});
