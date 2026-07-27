import { describe, expect, it } from "vitest";
import {
  createInputEchoSuppressor,
  createOsc7BlankingSuppressor,
  createTaskStartOutputSuppressor,
} from "./terminalOutputFilter";

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
    " printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; : __taomni_cwd_sync_done";

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

describe("OSC 7 blanking suppressor", () => {
  const clearLine = "\r\x1b[2K";
  const osc7 = "\x1b]7;file://host/D:/code\x1b\\";

  it("drops a PowerShell probe echo (colors and all) and keeps the OSC 7 reply", () => {
    const suppressor = createOsc7BlankingSuppressor(2500, 100);
    // PSReadLine re-colorizes the echoed command; the escape is literal text.
    const echoed =
      "\x1b[93m[Console]\x1b[0m::Write([char]27+']7;file://'+$env:COMPUTERNAME+...)";
    const newPrompt = "PS D:\\code> ";
    const output = text(
      suppressor.filter(bytes(`${echoed}\r\n${osc7}${newPrompt}`), 120),
    );

    expect(output).toBe(`${clearLine}${osc7}${newPrompt}`);
    expect(output).not.toContain("Console");
    expect(suppressor.done).toBe(true);
  });

  it("drops a wrapped bash probe echo across chunks", () => {
    const suppressor = createOsc7BlankingSuppressor(2500, 100);
    // A long echo that readline wrapped, arriving split — none of it should show.
    const first = text(
      suppressor.filter(bytes("$  printf '\\033]7;file://%s%s\\033\\\\' \"$HOST"), 110),
    );
    const second = text(
      suppressor.filter(bytes(`NAME\" \"$PWD\"\r\n${osc7}user@host:~/x$ `), 120),
    );

    expect(first).toBe(clearLine); // line cleared, echo dropped
    expect(second).toBe(`${osc7}user@host:~/x$ `);
    expect(suppressor.done).toBe(true);
  });

  it("hides an SSH cd whose trailing probe emits the OSC 7", () => {
    const suppressor = createOsc7BlankingSuppressor(2500, 100);
    const echoed = " cd '/var/log' && printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"";
    const osc7log = "\x1b]7;file://host/var/log\x1b\\";
    const output = text(suppressor.filter(bytes(`${echoed}\r\n${osc7log}[root@host log]# `), 120));

    expect(output).toBe(`${clearLine}${osc7log}[root@host log]# `);
    expect(output).not.toContain("cd '/var/log'");
    expect(suppressor.done).toBe(true);
  });

  it("stops dropping once the window expires so output is not lost forever", () => {
    const suppressor = createOsc7BlankingSuppressor(50, 100);
    expect(text(suppressor.filter(bytes("echoed command no osc7"), 120))).toBe(clearLine);
    expect(text(suppressor.filter(bytes("later real output"), 200))).toBe("later real output");
    expect(suppressor.done).toBe(true);
  });
});

describe("task start output suppressor", () => {
  const clearLine = "\r\x1b[2K";
  const marker = "\x1b]633;TaomniTaskStart\x07";

  it("hides the echoed wrapper, shows the display command, keeps task output", () => {
    const suppressor = createTaskStartOutputSuppressor(marker, "pnpm test", 5000, 100);
    // The shell echoes the whole instrumented wrapper, then the marker fires,
    // then real task output flows.
    const echoed = "& ([scriptblock]::Create('pnpm test')); [Console]::Write(...)";
    const output = text(
      suppressor.filter(bytes(`${echoed}\r\n${marker}PASS  1 test\r\n`), 120),
    );
    expect(output).toBe(`${clearLine}pnpm test\r\nPASS  1 test\r\n`);
    expect(output).not.toContain("scriptblock");
    expect(suppressor.done).toBe(true);
  });

  it("finds the marker even when split across chunks with noisy ANSI echo", () => {
    const suppressor = createTaskStartOutputSuppressor(marker, "mvn compile", 5000, 100);
    // Noisy PSReadLine colouring precedes the marker, which itself is split.
    const first = text(
      suppressor.filter(bytes(`\x1b[93m& { mvn compile }\x1b[0m\r\n\x1b]633;Taomni`), 110),
    );
    const second = text(suppressor.filter(bytes(`TaskStart\x07[INFO] BUILD\r\n`), 120));
    expect(first).toBe(""); // nothing shown until the marker completes
    expect(second).toBe(`${clearLine}mvn compile\r\n[INFO] BUILD\r\n`);
    expect(suppressor.done).toBe(true);
  });

  it("fails open when the marker never arrives before the window expires", () => {
    const suppressor = createTaskStartOutputSuppressor(marker, "go build", 50, 100);
    expect(text(suppressor.filter(bytes("partial wrapper echo"), 120))).toBe("");
    // On timeout the held bytes are released rather than lost.
    expect(text(suppressor.filter(bytes(" more"), 200))).toBe("partial wrapper echo more");
    expect(suppressor.done).toBe(true);
  });
});
