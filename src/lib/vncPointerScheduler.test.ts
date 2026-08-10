import { describe, expect, it } from "vitest";
import { VncPointerScheduler, type VncPointerState } from "./vncPointerScheduler";

function createScheduler() {
  let now = 0;
  let timer: (() => void) | null = null;
  let timerDelay: number | null = null;
  const sent: VncPointerState[] = [];
  const scheduler = new VncPointerScheduler({
    send: (pointer) => sent.push(pointer),
    now: () => now,
    setTimer: (callback, delay) => {
      timer = callback;
      timerDelay = delay;
      return 1 as unknown as ReturnType<typeof window.setTimeout>;
    },
    clearTimer: () => {
      timer = null;
      timerDelay = null;
    },
  });

  return {
    scheduler,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
    timerDelay: () => timerDelay,
    runTimer: () => {
      const callback = timer;
      timer = null;
      timerDelay = null;
      callback?.();
    },
  };
}

describe("VncPointerScheduler", () => {
  it("sends the leading move immediately and the latest trailing move at 4 ms", () => {
    const state = createScheduler();
    state.scheduler.move({ x: 1, y: 2, buttons: 0 });
    expect(state.sent).toEqual([{ x: 1, y: 2, buttons: 0 }]);

    state.advance(1);
    state.scheduler.move({ x: 2, y: 3, buttons: 0 });
    state.advance(1);
    state.scheduler.move({ x: 4, y: 5, buttons: 0 });

    expect(state.timerDelay()).toBe(3);
    expect(state.sent).toHaveLength(1);
    state.advance(2);
    state.runTimer();
    expect(state.sent).toEqual([
      { x: 1, y: 2, buttons: 0 },
      { x: 4, y: 5, buttons: 0 },
    ]);
  });

  it("cancels an older move before sending a button transition", () => {
    const state = createScheduler();
    state.scheduler.move({ x: 1, y: 1, buttons: 0 });
    state.advance(1);
    state.scheduler.move({ x: 2, y: 2, buttons: 0 });
    state.scheduler.sendNow({ x: 3, y: 3, buttons: 1 });
    state.runTimer();

    expect(state.sent).toEqual([
      { x: 1, y: 1, buttons: 0 },
      { x: 3, y: 3, buttons: 1 },
    ]);
  });

  it("drops pending work on reset and lets the next move lead immediately", () => {
    const state = createScheduler();
    state.scheduler.move({ x: 1, y: 1, buttons: 0 });
    state.advance(1);
    state.scheduler.move({ x: 2, y: 2, buttons: 0 });
    state.scheduler.reset();
    state.scheduler.move({ x: 8, y: 9, buttons: 0 });
    state.runTimer();

    expect(state.sent).toEqual([
      { x: 1, y: 1, buttons: 0 },
      { x: 8, y: 9, buttons: 0 },
    ]);
  });
});
