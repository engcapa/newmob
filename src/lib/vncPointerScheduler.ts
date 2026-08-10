export interface VncPointerState {
  x: number;
  y: number;
  buttons: number;
}

export const VNC_POINTER_MOVE_INTERVAL_MS = 4;

type TimerHandle = ReturnType<typeof window.setTimeout>;

interface VncPointerSchedulerOptions {
  send: (pointer: VncPointerState) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  intervalMs?: number;
}

/**
 * Sends the leading pointer move immediately and retains only the newest move
 * during a short rate-limit window. Button transitions use sendNow() so they
 * cannot be reordered behind a pending movement.
 */
export class VncPointerScheduler {
  private pending: VncPointerState | null = null;
  private timer: TimerHandle | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly send: (pointer: VncPointerState) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly intervalMs: number;

  constructor(options: VncPointerSchedulerOptions) {
    this.send = options.send;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
    this.intervalMs = Math.max(0, options.intervalMs ?? VNC_POINTER_MOVE_INTERVAL_MS);
  }

  move(pointer: VncPointerState): void {
    const now = this.now();
    const elapsed = now - this.lastSentAt;
    if (this.timer === null && elapsed >= this.intervalMs) {
      this.pending = null;
      this.emit(pointer, now);
      return;
    }

    this.pending = pointer;
    if (this.timer !== null) return;

    const delay = Math.max(0, this.intervalMs - Math.max(0, elapsed));
    this.timer = this.setTimer(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) this.emit(pending, this.now());
    }, delay);
  }

  sendNow(pointer: VncPointerState): void {
    this.cancelPending();
    this.emit(pointer, this.now());
  }

  cancelPending(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  reset(): void {
    this.cancelPending();
    this.lastSentAt = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.reset();
  }

  private emit(pointer: VncPointerState, now: number): void {
    this.lastSentAt = now;
    this.send(pointer);
  }
}
