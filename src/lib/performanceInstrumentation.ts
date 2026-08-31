/**
 * Optional, passive observation for real IPC performance runs. The observer
 * is absent during normal use and can never change the operation result.
 */
export interface PerformanceIpcEvent {
  phase: "start" | "end";
  command: string;
  args: unknown;
  atMs: number;
  ok?: boolean;
  error?: string;
}

type PerformanceIpcObserver = (event: PerformanceIpcEvent) => void;
type PerformanceGlobal = typeof globalThis & {
  __TAOMNI_PERF_OBSERVER__?: PerformanceIpcObserver;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function notify(event: PerformanceIpcEvent): void {
  const observer = (globalThis as PerformanceGlobal).__TAOMNI_PERF_OBSERVER__;
  if (typeof observer !== "function") return;
  try {
    observer(event);
  } catch {
    // Measurement must never affect the production IPC path.
  }
}

export function invokeWithPerformanceObservation<T>(
  command: string,
  args: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  notify({ phase: "start", command, args, atMs: nowMs() });
  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (error) {
    notify({ phase: "end", command, args, atMs: nowMs(), ok: false, error: String(error) });
    return Promise.reject(error);
  }
  return pending.then(
    (value) => {
      notify({ phase: "end", command, args, atMs: nowMs(), ok: true });
      return value;
    },
    (error) => {
      notify({ phase: "end", command, args, atMs: nowMs(), ok: false, error: String(error) });
      throw error;
    },
  );
}
