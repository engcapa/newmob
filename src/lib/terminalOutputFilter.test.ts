import { describe, expect, it } from "vitest";
import { createInputEchoSuppressor } from "./terminalOutputFilter";

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytes(text: string): Uint8Array {
  return enc.encode(text);
}

function text(data: Uint8Array): string {
  return dec.decode(data);
}

describe("terminal output filtering", () => {
  const clearLine = "\r\x1b[2K";
  const cwdQueryCommand =
    " printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; : __newmob_cwd_sync_done";

  it("removes the echoed one-shot terminal cwd query command", () => {
    const suppressor = createInputEchoSuppressor(cwdQueryCommand, 5000, 100);
    const osc7 = "\x1b]7;file://host/home/user\x1b\\";
    const output = text(suppressor.filter(bytes(`(base) user@host:~$${cwdQueryCommand}\r\n${osc7}`), 120));

    expect(output).toBe(`(base) user@host:~$ ${clearLine}${osc7}`);
    expect(suppressor.done).toBe(true);
  });

  it("removes the one-shot cwd query command without relying on the leading space", () => {
    const suppressor = createInputEchoSuppressor(cwdQueryCommand, 5000, 100);
    const echoedWithoutLeadingSpace = cwdQueryCommand.trimStart();
    const output = text(suppressor.filter(bytes(`(base) user@host:~$ ${echoedWithoutLeadingSpace}\r\n`), 120));

    expect(output).toBe(`(base) user@host:~$ ${clearLine}`);
    expect(suppressor.done).toBe(true);
  });

  it("removes the echoed command across output chunks", () => {
    const suppressor = createInputEchoSuppressor(cwdQueryCommand, 5000, 100);
    const split = cwdQueryCommand.indexOf("\"${HOSTNAME");

    const first = text(suppressor.filter(bytes(`prompt$${cwdQueryCommand.slice(0, split)}`), 120));
    const second = text(suppressor.filter(bytes(`${cwdQueryCommand.slice(split)}\r\nprompt$`), 130));

    expect(first).toBe(`prompt$ ${clearLine}`);
    expect(second).toBe("prompt$");
    expect(suppressor.done).toBe(true);
  });

  it("releases a partial match when the suppression window expires", () => {
    const suppressor = createInputEchoSuppressor(cwdQueryCommand, 50, 100);
    const prefix = cwdQueryCommand.trimStart().slice(0, 12);

    expect(text(suppressor.filter(bytes(prefix), 120))).toBe("");
    expect(text(suppressor.filter(bytes(" normal output"), 200))).toBe(`${prefix} normal output`);
    expect(suppressor.done).toBe(true);
  });

  it("releases a started marker match when the suppression window expires", () => {
    const suppressor = createInputEchoSuppressor(cwdQueryCommand, 50, 100);
    const prefix = "printf '\\033]7;file://%s%s\\033\\\\' partial";

    expect(text(suppressor.filter(bytes(prefix), 120))).toBe(clearLine);
    expect(text(suppressor.filter(bytes(" output"), 200))).toBe(`${prefix} output`);
    expect(suppressor.done).toBe(true);
  });
});
