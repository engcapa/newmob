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
  if (text.includes("__taomni_cwd_sync_done")) {
    return new MarkerInputEchoSuppressor(
      "printf '\\033]7;file://%s%s\\033\\\\'",
      ": __taomni_cwd_sync_done",
      ttlMs,
      now,
    );
  }
  return new ByteInputEchoSuppressor(text, ttlMs, now);
}

// ESC ] 7 ; — the start of an OSC 7 "report cwd" sequence.
const OSC7_INTRODUCER = [0x1b, 0x5d, 0x37, 0x3b];

/**
 * Suppressor for an injected cwd-probe command (or a `cd` that ends with one).
 *
 * Rather than trying to match the echoed command text — which shell line
 * editors (bash readline, zsh zle, PowerShell PSReadLine) defeat by
 * interleaving color and cursor-movement escapes and wrapping long lines — this
 * clears the current line, then drops *everything* until the real OSC 7 escape
 * byte arrives, then passes the OSC 7 reply and all following output through.
 *
 * This is robust because the echoed command can never contain a real ESC
 * (0x1B): the probe writes the escape as literal text (`[char]27`, `\033`), so
 * the only real OSC 7 in the stream is the one the command emits when it runs.
 * The result is the echoed command vanishing and the shell redrawing a clean
 * prompt in its place.
 */
class Osc7BlankingSuppressor implements InputEchoSuppressor {
  private readonly expiresAt: number;
  private clearedLine = false;
  private matched = 0;
  private finished = false;

  constructor(ttlMs: number, now: number) {
    this.expiresAt = now + ttlMs;
  }

  get done(): boolean {
    return this.finished;
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (this.finished) return data;

    if (now > this.expiresAt) {
      // Gave up waiting for the OSC 7 reply; stop dropping and let output flow.
      this.finished = true;
      return data;
    }

    const out: number[] = [];
    if (!this.clearedLine) {
      // Wipe the prompt line the echo is landing on; the shell will redraw a
      // fresh prompt after the (dropped) command runs.
      out.push(...CLEAR_CURRENT_LINE);
      this.clearedLine = true;
    }

    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      if (byte === OSC7_INTRODUCER[this.matched]) {
        this.matched += 1;
        if (this.matched === OSC7_INTRODUCER.length) {
          // Found the real OSC 7: emit it and everything after, untouched.
          out.push(...OSC7_INTRODUCER);
          for (let j = i + 1; j < data.length; j += 1) out.push(data[j]);
          this.finished = true;
          return new Uint8Array(out);
        }
      } else {
        // Mismatch mid-introducer: those bytes were echo noise, so drop them
        // and restart the match (the byte may itself be a fresh ESC).
        this.matched = byte === OSC7_INTRODUCER[0] ? 1 : 0;
      }
      // Every other byte is dropped (the echoed command + its newline).
    }

    return new Uint8Array(out);
  }
}

/** See {@link Osc7BlankingSuppressor}. The TTL bounds how long output is
 *  dropped if the OSC 7 reply never arrives (e.g. the terminal was busy running
 *  a foreground command when the probe was queued), so worst-case output loss
 *  is short. */
export function createOsc7BlankingSuppressor(
  ttlMs = 1500,
  now = Date.now(),
): InputEchoSuppressor {
  return new Osc7BlankingSuppressor(ttlMs, now);
}

/**
 * Hide an injected task wrapper until its real OSC start marker arrives.
 * Shell line editors may colorize, wrap, or split the echo, so matching the
 * echoed source is unreliable. The marker is emitted immediately before the
 * real command; everything after it is genuine task output and passes through.
 */
class TaskStartOutputSuppressor implements InputEchoSuppressor {
  private readonly marker: Uint8Array;
  private readonly display: Uint8Array;
  private readonly expiresAt: number;
  private readonly held: number[] = [];
  private finished = false;

  constructor(marker: string, displayCommand: string, ttlMs: number, now: number) {
    const encoder = new TextEncoder();
    this.marker = encoder.encode(marker);
    this.display = encoder.encode(displayCommand);
    this.expiresAt = now + ttlMs;
  }

  get done(): boolean {
    return this.finished;
  }

  filter(data: Uint8Array, now = Date.now()): Uint8Array {
    if (this.finished || this.marker.length === 0) return data;
    for (const byte of data) this.held.push(byte);

    const markerAt = indexOfBytes(this.held, this.marker);
    if (markerAt >= 0) {
      const after = new Uint8Array(this.held.slice(markerAt + this.marker.length));
      this.held.length = 0;
      this.finished = true;
      return concatManyBytes(
        new Uint8Array(CLEAR_CURRENT_LINE),
        this.display,
        new Uint8Array([0x0d, 0x0a]),
        after,
      );
    }

    // Never hold an unbounded stream. On timeout or excessive preamble, fail
    // open so no real terminal output can be lost.
    if (now > this.expiresAt || this.held.length > 64 * 1024) {
      const released = new Uint8Array(this.held);
      this.held.length = 0;
      this.finished = true;
      return released;
    }
    return new Uint8Array();
  }
}

export function createTaskStartOutputSuppressor(
  marker: string,
  displayCommand: string,
  ttlMs = 5000,
  now = Date.now(),
): InputEchoSuppressor {
  return new TaskStartOutputSuppressor(marker, displayCommand, ttlMs, now);
}

function indexOfBytes(haystack: number[], needle: Uint8Array): number {
  const last = haystack.length - needle.length;
  for (let start = 0; start <= last; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function concatManyBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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
