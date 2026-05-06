export interface InputEchoSuppressor {
  readonly done: boolean;
  filter(data: Uint8Array, now?: number): Uint8Array;
}

class ByteInputEchoSuppressor implements InputEchoSuppressor {
  private readonly needle: Uint8Array;
  private readonly expiresAt: number;
  private matched = 0;
  private finished = false;

  constructor(text: string, ttlMs: number, now: number) {
    this.needle = new TextEncoder().encode(text);
    this.expiresAt = now + ttlMs;
  }

  get done(): boolean {
    return this.finished;
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (this.finished || this.needle.length === 0) return data;

    if (now > this.expiresAt) {
      const held = this.needle.slice(0, this.matched);
      this.matched = 0;
      this.finished = true;
      return concatBytes(held, data);
    }

    const out: number[] = [];

    for (const byte of data) {
      if (this.finished) {
        out.push(byte);
        continue;
      }

      let current = byte;
      let consumed = false;

      while (!consumed) {
        if (current === this.needle[this.matched]) {
          this.matched += 1;
          consumed = true;
          if (this.matched === this.needle.length) {
            this.matched = 0;
            this.finished = true;
          }
        } else if (this.matched > 0) {
          for (let i = 0; i < this.matched; i += 1) {
            out.push(this.needle[i]);
          }
          this.matched = 0;
        } else {
          out.push(current);
          consumed = true;
        }
      }
    }

    return new Uint8Array(out);
  }
}

class MarkerInputEchoSuppressor implements InputEchoSuppressor {
  private readonly start: Uint8Array;
  private readonly end: Uint8Array;
  private readonly expiresAt: number;
  private startPending: number[] = [];
  private endPending: number[] = [];
  private suppressedHeld: number[] = [];
  private suppressing = false;
  private droppingLineEnd = false;
  private droppedCarriageReturn = false;
  private finished = false;

  constructor(start: string, end: string, ttlMs: number, now: number) {
    this.start = new TextEncoder().encode(start);
    this.end = new TextEncoder().encode(end);
    this.expiresAt = now + ttlMs;
  }

  get done(): boolean {
    return this.finished;
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (this.finished || this.start.length === 0 || this.end.length === 0) return data;

    if (now > this.expiresAt) {
      const held = new Uint8Array(this.suppressing ? this.suppressedHeld : this.startPending);
      this.startPending = [];
      this.endPending = [];
      this.suppressedHeld = [];
      this.finished = true;
      return concatBytes(held, data);
    }

    const out: number[] = [];

    for (const byte of data) {
      if (this.finished) {
        out.push(byte);
      } else if (this.suppressing) {
        this.consumeSuppressedByte(byte);
      } else if (this.droppingLineEnd) {
        this.consumeLineEndByte(byte, out);
      } else {
        this.consumeVisibleByte(byte, out);
      }
    }

    return new Uint8Array(out);
  }

  private consumeVisibleByte(byte: number, out: number[]) {
    this.startPending.push(byte);

    while (!isPrefix(this.startPending, this.start)) {
      const shifted = this.startPending.shift();
      if (shifted !== undefined) out.push(shifted);
    }

    if (this.startPending.length === this.start.length) {
      this.startPending = [];
      this.suppressedHeld = [...this.start];
      this.suppressing = true;
      out.push(...CLEAR_CURRENT_LINE);
    }
  }

  private consumeSuppressedByte(byte: number) {
    this.suppressedHeld.push(byte);
    this.endPending.push(byte);

    while (!isPrefix(this.endPending, this.end) && this.endPending.length > 0) {
      this.endPending.shift();
    }

    if (this.endPending.length === this.end.length) {
      this.endPending = [];
      this.suppressedHeld = [];
      this.suppressing = false;
      this.droppingLineEnd = true;
      this.droppedCarriageReturn = false;
    }
  }

  private consumeLineEndByte(byte: number, out: number[]) {
    if (byte === 0x0d) {
      this.droppedCarriageReturn = true;
      return;
    }

    if (byte === 0x0a && this.droppedCarriageReturn) {
      this.finish();
      return;
    }

    if (byte === 0x0a) {
      this.finish();
      return;
    }

    this.finish();
    out.push(byte);
  }

  private finish() {
    this.droppingLineEnd = false;
    this.droppedCarriageReturn = false;
    this.finished = true;
  }
}

export function createInputEchoSuppressor(
  text: string,
  ttlMs = 5000,
  now = Date.now(),
): InputEchoSuppressor {
  if (text.includes("__newmob_cwd_sync_done")) {
    return new MarkerInputEchoSuppressor(
      "printf '\\033]7;file://%s%s\\033\\\\'",
      ": __newmob_cwd_sync_done",
      ttlMs,
      now,
    );
  }
  return new ByteInputEchoSuppressor(text, ttlMs, now);
}

function isPrefix(value: number[], prefix: Uint8Array): boolean {
  if (value.length > prefix.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== prefix[i]) return false;
  }
  return true;
}

const CLEAR_CURRENT_LINE = [0x0d, 0x1b, 0x5b, 0x32, 0x4b];

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
