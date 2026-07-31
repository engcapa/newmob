import { describe, expect, it } from "vitest";
import { buildInteractiveCommandInput, renderTerminalTask, terminalTaskShell } from "./commandInput";

describe("buildInteractiveCommandInput", () => {
  it("submits a single command with carriage return", () => {
    expect(buildInteractiveCommandInput("Get-Host | Select-Object Version")).toBe(
      "Get-Host | Select-Object Version\r",
    );
  });

  it("does not add an extra enter when the command already has a trailing newline", () => {
    expect(buildInteractiveCommandInput("pwd\n")).toBe("pwd\r");
    expect(buildInteractiveCommandInput("pwd\r\n")).toBe("pwd\r");
  });

  it("normalizes multiline commands to repeated terminal enters", () => {
    expect(buildInteractiveCommandInput("echo one\n$PSVersionTable.PSVersion")).toBe(
      "echo one\r$PSVersionTable.PSVersion\r",
    );
  });

  it("preserves intentional blank lines inside the command", () => {
    expect(buildInteractiveCommandInput("cat <<'EOF'\n\nEOF")).toBe("cat <<'EOF'\r\rEOF\r");
  });
});

describe("terminal task rendering", () => {
  it("uses the registered shell instead of the host platform", () => {
    expect(terminalTaskShell({ platform: "windows", shellId: "git-bash" })).toBe("posix");
    expect(terminalTaskShell({ platform: "linux", shellId: "powershell" })).toBe("powershell");
    expect(terminalTaskShell({ platform: "windows", shellId: "command-prompt" })).toBe("cmd");
  });

  it("renders and escapes a PowerShell task", () => {
    const task = renderTerminalTask("Write-Output 'it''s fine'", {
      platform: "windows",
      shellId: "powershell",
    });
    expect(task.shell).toBe("powershell");
    expect(task.input).toContain("[scriptblock]::Create('Write-Output ''it''''s fine''')");
    expect(task.input).toContain("TaomniTaskExit=");
    expect(buildInteractiveCommandInput(task.input).endsWith("\r")).toBe(true);
  });

  it("renders POSIX and Git Bash tasks with single-quote escaping", () => {
    const task = renderTerminalTask("printf '%s\\n' \"it's\"", {
      platform: "windows",
      shellId: "git-bash",
    });
    expect(task.shell).toBe("posix");
    expect(task.input).toContain(`eval 'printf '"'"'%s\\n'"'"' "it'"'"'s"'`);
    expect(task.input).toContain("__taomni_status=$?");
  });

  it("renders cmd with deferred status capture and protects outer metacharacters", () => {
    const task = renderTerminalTask("echo one && echo 100%", {
      platform: "windows",
      shellId: "command-prompt",
    });
    expect(task.shell).toBe("cmd");
    expect(task.input).toContain("echo one ^&^& echo 100%%");
    expect(task.input).toContain('call set "taomniStatus=%%errorlevel%%"');
    expect(task.input.split("\n")).toHaveLength(2);
    expect(buildInteractiveCommandInput(task.input)).not.toContain("\n");
  });

  it("scopes appended task variables to a POSIX command", () => {
    const task = renderTerminalTask("./mvnw exec:java", {
      platform: "linux",
      shellId: "bash",
    }, {
      MAVEN_OPTS: {
        value: "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED 'quoted'",
        mode: "append",
      },
      "invalid-name": { value: "ignored", mode: "replace" },
    });
    expect(task.input).toContain("( export MAVEN_OPTS=");
    expect(task.input).toContain("${MAVEN_OPTS:+${MAVEN_OPTS} }");
    expect(task.input).toContain(`'"'"'quoted'"'"'`);
    expect(task.input).not.toContain("invalid-name");
  });

  it("restores PowerShell task variables and uses setlocal for cmd", () => {
    const variables = {
      MAVEN_OPTS: {
        value: "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
        mode: "append" as const,
      },
    };
    const powershell = renderTerminalTask("mvn.cmd exec:java", {
      platform: "windows",
      shellId: "powershell",
    }, variables);
    expect(powershell.input).toContain("$taomniEnvironment['MAVEN_OPTS']");
    expect(powershell.input).toContain("$env:MAVEN_OPTS=");
    expect(powershell.input).toContain("finally");

    const cmd = renderTerminalTask("mvn.cmd exec:java", {
      platform: "windows",
      shellId: "command-prompt",
    }, variables);
    expect(cmd.input).toContain("setlocal DisableDelayedExpansion");
    expect(cmd.input).toContain('set "MAVEN_OPTS=%MAVEN_OPTS% --add-opens=');
    expect(cmd.input).toContain("endlocal");
  });
});
