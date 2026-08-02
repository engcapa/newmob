export type TerminalTaskShell = "powershell" | "posix" | "cmd";

export interface TerminalTaskEnvironment {
  platform?: string | null;
  shellId?: string | null;
  shellName?: string | null;
}

/**
 * Environment values scoped to one rendered task. `append` preserves a value
 * the interactive shell already has, which is essential for MAVEN_OPTS.
 */
export interface TerminalTaskVariable {
  value: string;
  mode?: "append" | "replace";
}

export type TerminalTaskVariables = Record<string, TerminalTaskVariable>;

export interface RenderedTerminalTask {
  input: string;
  displayCommand: string;
  startMarker: string;
  shell: TerminalTaskShell;
}

export interface TerminalExecutionCommand {
  executable: string;
  args: string[];
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

/**
 * Convert a structured executable/argv pair to syntax for the interactive
 * shell that owns the workspace terminal. Built-in workspace targets use this
 * path; user-authored tasks intentionally remain raw shell commands.
 */
export function renderTerminalExecutionCommand(
  execution: TerminalExecutionCommand,
  environment?: TerminalTaskEnvironment | null,
): string {
  const values = [execution.executable, ...execution.args];
  const shell = terminalTaskShell(environment);
  if (shell === "powershell") {
    return `& ${values.map(quotePowerShell).join(" ")}`;
  }
  if (shell === "cmd") {
    return values.map(quoteCmdArgument).join(" ");
  }
  return values.map(quotePosix).join(" ");
}

/** Render a task wrapper that reports status without replacing the live shell. */
export function renderTerminalTask(
  command: string,
  environment?: TerminalTaskEnvironment | null,
  taskVariables?: TerminalTaskVariables,
): RenderedTerminalTask {
  const source = command.replace(/\r\n|\r/g, "\n").trim();
  const displayCommand = source.replace(/\s*\n\s*/g, " ");
  const shell = terminalTaskShell(environment);
  const variables = normalizeTaskVariables(taskVariables);

  if (shell === "powershell") {
    const script = source.replace(/'/g, "''");
    if (variables.length > 0) {
      return {
        shell,
        displayCommand,
        startMarker: TASK_START_BEL,
        input: renderPowerShellTaskWithVariables(script, variables),
      };
    }
    return {
      shell,
      displayCommand,
      startMarker: TASK_START_BEL,
      input: `[Console]::Write([char]27+']633;TaomniTaskStart'+[char]7); & ([scriptblock]::Create('${script}')); $taomniSucceeded=$?; $taomniStatus=if ($taomniSucceeded) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }; [Console]::Write([char]27+']633;TaomniTaskExit='+$taomniStatus+[char]7)`,
    };
  }

  if (shell === "cmd") {
    const escaped = escapeCmdCall(source);
    if (variables.length > 0) {
      return {
        shell,
        displayCommand,
        startMarker: TASK_START_ST,
        input: renderCmdTaskWithVariables(escaped, variables),
      };
    }
    return {
      shell,
      displayCommand,
      startMarker: TASK_START_ST,
      input: `for /F "delims=" %A in ('echo prompt $E^| cmd') do @set "taomniEsc=%A"\n<nul set /p "=%taomniEsc%]633;TaomniTaskStart%taomniEsc%\\" & call ${escaped} & call set "taomniStatus=%%errorlevel%%" & call <nul set /p "=%%taomniEsc%%]633;TaomniTaskExit=%%taomniStatus%%%%taomniEsc%%\\"`,
    };
  }

  const script = source.replace(/'/g, `'"'"'`);
  if (variables.length > 0) {
    return {
      shell,
      displayCommand,
      startMarker: TASK_START_BEL,
      input: `printf '\\033]633;TaomniTaskStart\\a'; ( ${renderPosixVariableSetup(variables)}; eval '${script}' ); __taomni_status=$?; printf '\\033]633;TaomniTaskExit=%s\\a' "$__taomni_status"`,
    };
  }
  return {
    shell,
    displayCommand,
    startMarker: TASK_START_BEL,
    input: `printf '\\033]633;TaomniTaskStart\\a'; eval '${script}'; __taomni_status=$?; printf '\\033]633;TaomniTaskExit=%s\\a' "$__taomni_status"`,
  };
}

interface NormalizedTaskVariable {
  name: string;
  value: string;
  mode: "append" | "replace";
}

function normalizeTaskVariables(taskVariables?: TerminalTaskVariables): NormalizedTaskVariable[] {
  if (!taskVariables) return [];
  return Object.entries(taskVariables)
    .filter(([name, variable]) => (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      && !!variable
      && typeof variable.value === "string"
    ))
    .map(([name, variable]) => ({
      name,
      value: variable.value,
      mode: variable.mode === "replace" ? "replace" : "append",
    }));
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderPosixVariableSetup(variables: NormalizedTaskVariable[]): string {
  return variables.map(({ name, value, mode }) => {
    const quoted = quotePosix(value);
    if (mode === "replace") return `export ${name}=${quoted}`;
    return `export ${name}="\${${name}:+\${${name}} }"${quoted}`;
  }).join("; ");
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function renderPowerShellTaskWithVariables(
  script: string,
  variables: NormalizedTaskVariable[],
): string {
  const remember = variables.map(({ name }) => (
    `$taomniEnvironment['${name}']=[Environment]::GetEnvironmentVariable('${name}','Process')`
  )).join("; ");
  const setup = variables.map(({ name, value, mode }) => {
    const quoted = quotePowerShell(value);
    if (mode === "replace") return `$env:${name}=${quoted}`;
    return `$env:${name}=if ([string]::IsNullOrWhiteSpace($taomniEnvironment['${name}'])) { ${quoted} } else { $taomniEnvironment['${name}']+' '+${quoted} }`;
  }).join("; ");
  const restore = variables.map(({ name }) => (
    `if ($null -eq $taomniEnvironment['${name}']) { Remove-Item Env:${name} -ErrorAction SilentlyContinue } else { $env:${name}=$taomniEnvironment['${name}'] }`
  )).join("; ");
  return `[Console]::Write([char]27+']633;TaomniTaskStart'+[char]7); $taomniStatus=1; $taomniEnvironment=@{}; try { ${remember}; ${setup}; & ([scriptblock]::Create('${script}')); $taomniSucceeded=$?; $taomniStatus=if ($taomniSucceeded) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 } } finally { ${restore} }; [Console]::Write([char]27+']633;TaomniTaskExit='+$taomniStatus+[char]7)`;
}

function escapeCmdSetValue(value: string): string {
  return value.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/"/g, '""');
}

function renderCmdTaskWithVariables(
  escapedCommand: string,
  variables: NormalizedTaskVariable[],
): string {
  const setup = variables.map(({ name, value, mode }) => {
    const prefix = mode === "append" ? `%${name}% ` : "";
    return `set "${name}=${prefix}${escapeCmdSetValue(value)}"`;
  }).join(" & ");
  return `for /F "delims=" %A in ('echo prompt $E^| cmd') do @set "taomniEsc=%A"\n<nul set /p "=%taomniEsc%]633;TaomniTaskStart%taomniEsc%\\" & setlocal DisableDelayedExpansion & ${setup} & call ${escapedCommand} & call set "taomniStatus=%%errorlevel%%" & call <nul set /p "=%%taomniEsc%%]633;TaomniTaskExit=%%taomniStatus%%%%taomniEsc%%\\" & endlocal`;
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
