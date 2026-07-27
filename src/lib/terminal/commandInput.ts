export type TerminalTaskShell = "powershell" | "posix" | "cmd";

export interface TerminalTaskEnvironment {
  platform?: string | null;
  shellId?: string | null;
  shellName?: string | null;
}

export interface RenderedTerminalTask {
  input: string;
  displayCommand: string;
  startMarker: string;
  shell: TerminalTaskShell;
}

const TASK_START_BEL = "\x1b]633;TaomniTaskStart\x07";
const TASK_START_ST = "\x1b]633;TaomniTaskStart\x1b\\";

/** Resolve task syntax from the shell that the backend actually launched. */
export function terminalTaskShell(environment?: TerminalTaskEnvironment | null): TerminalTaskShell {
  const id = environment?.shellId?.trim().toLowerCase() ?? "";
  const name = environment?.shellName?.trim().toLowerCase() ?? "";
  const identity = `${id} ${name}`;

  if (/powershell|pwsh/.test(identity)) return "powershell";
  if (id === "command-prompt" || /(^|[\\/\s])cmd(?:\.exe)?($|\s)/.test(identity)) return "cmd";
  // A concrete non-default shell id is authoritative. Bash, Git Bash, zsh,
  // WSL, and other workspace shells use POSIX task syntax even on Windows.
  if (id && id !== "default") return "posix";
  return environment?.platform?.toLowerCase() === "windows" ? "powershell" : "posix";
}

/** Render a task wrapper that reports status without replacing the live shell. */
export function renderTerminalTask(
  command: string,
  environment?: TerminalTaskEnvironment | null,
): RenderedTerminalTask {
  const source = command.replace(/\r\n|\r/g, "\n").trim();
  const displayCommand = source.replace(/\s*\n\s*/g, " ");
  const shell = terminalTaskShell(environment);

  if (shell === "powershell") {
    const script = source.replace(/'/g, "''");
    return {
      shell,
      displayCommand,
      startMarker: TASK_START_BEL,
      input: `[Console]::Write([char]27+']633;TaomniTaskStart'+[char]7); & ([scriptblock]::Create('${script}')); $taomniSucceeded=$?; $taomniStatus=if ($taomniSucceeded) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }; [Console]::Write([char]27+']633;TaomniTaskExit='+$taomniStatus+[char]7)`,
    };
  }

  if (shell === "cmd") {
    const escaped = escapeCmdCall(source);
    return {
      shell,
      displayCommand,
      startMarker: TASK_START_ST,
      input: `for /F "delims=" %A in ('echo prompt $E^| cmd') do @set "taomniEsc=%A"\n<nul set /p "=%taomniEsc%]633;TaomniTaskStart%taomniEsc%\\" & call ${escaped} & call set "taomniStatus=%%errorlevel%%" & call <nul set /p "=%%taomniEsc%%]633;TaomniTaskExit=%%taomniStatus%%%%taomniEsc%%\\"`,
    };
  }

  const script = source.replace(/'/g, `'"'"'`);
  return {
    shell,
    displayCommand,
    startMarker: TASK_START_BEL,
    input: `printf '\\033]633;TaomniTaskStart\\a'; eval '${script}'; __taomni_status=$?; printf '\\033]633;TaomniTaskExit=%s\\a' "$__taomni_status"`,
  };
}

function escapeCmdCall(command: string): string {
  // CALL reparses its argument. Protect metacharacters from the outer parse,
  // then let the CALL parse restore their original command meaning.
  let out = "";
  let quoted = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      out += char;
    } else if (char === "%") {
      out += "%%";
    } else if (char === "^") {
      out += "^^^^";
    } else if (!quoted && /[&|<>()]/.test(char)) {
      out += `^${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Build stdin for an interactive terminal command.
 *
 * xterm sends Enter as carriage return (`\r`) to PTYs, including Windows
 * ConPTY and SSH PTYs. Treat command newlines as repeated Enter presses rather
 * than OS text-file line endings; using `\n` can leave PowerShell/PSReadLine in
 * a continuation prompt instead of submitting the command.
 */
export function buildInteractiveCommandInput(command: string): string {
  return `${command.replace(/\r\n|\r|\n/g, "\r").replace(/\r+$/g, "")}\r`;
}
