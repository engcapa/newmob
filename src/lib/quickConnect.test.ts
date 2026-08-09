import { describe, expect, it } from "vitest";
import { parseQuickConnectInput, parseSshConnectionCommand } from "./quickConnect";

describe("parseQuickConnectInput", () => {
  it("parses RDP URLs as password-auth sessions", () => {
    const parsed = parseQuickConnectInput("rdp://alice@win.example.test:3390");

    expect(parsed.config).toMatchObject({
      session_type: "RDP",
      host: "win.example.test",
      port: 3390,
      username: "alice",
      auth_method: "Password",
    });
  });

  it("uses the default RDP port when the URL omits one", () => {
    const parsed = parseQuickConnectInput("rdp://win.example.test");

    expect(parsed.config).toMatchObject({
      session_type: "RDP",
      host: "win.example.test",
      port: 3389,
      auth_method: "Password",
    });
  });

  it("parses VNC URLs through the password prompt path", () => {
    const parsed = parseQuickConnectInput("vnc://alice@desktop.example.test:5901");

    expect(parsed.config).toMatchObject({
      session_type: "VNC",
      host: "desktop.example.test",
      port: 5901,
      username: "alice",
      auth_method: "Password",
    });
    expect(parsed.authData).toBeNull();
  });

  it.each([
    ["ftp://ops@files.example.test:2121", "FTP", "files.example.test", 2121, "ops"],
    ["rlogin://bob@legacy.example.test", "Rlogin", "legacy.example.test", 513, "bob"],
    ["mosh alice@edge.example.test", "Mosh", "edge.example.test", 60001, "alice"],
  ])("parses terminal client protocol %s", (input, sessionType, host, port, username) => {
    const parsed = parseQuickConnectInput(input);

    expect(parsed.config).toMatchObject({
      session_type: sessionType,
      host,
      port,
      username,
      auth_method: "None",
    });
  });

  it("parses full OpenSSH commands into SSH session fields", () => {
    const parsed = parseSshConnectionCommand(
      "ssh -p 2222 -i ~/.ssh/prod_key -J ops@bastion.example.test:2200 " +
      "-L 127.0.0.1:15432:127.0.0.1:5432 -C -Y -6 -o ServerAliveInterval=45 " +
      "deploy@app.example.test tmux new -A -s main",
    );

    expect(parsed).toMatchObject({
      host: "app.example.test",
      port: 2222,
      username: "deploy",
      authMethod: { PrivateKey: { key_path: "~/.ssh/prod_key" } },
      keyPath: "~/.ssh/prod_key",
      options: {
        x11: true,
        x11Trusted: true,
        compression: true,
        startupCmd: "tmux new -A -s main",
        doNotExit: false,
        networkSettings: {
          proxyKind: "ssh-tunnel",
          jumpHost: "bastion.example.test",
          jumpPort: "2200",
          jumpUser: "ops",
          keepAlive: true,
          keepAliveIntervalSecs: "45",
          ipVersion: "ipv6",
        },
      },
    });
    expect(parsed?.options.networkSettings?.localForwards).toEqual([
      expect.objectContaining({
        local: "127.0.0.1:15432",
        remote: "127.0.0.1:5432",
      }),
    ]);
  });

  it("uses the OpenSSH parser for quick-connect SSH commands", () => {
    const parsed = parseQuickConnectInput("ssh -p 2201 -i '/home/me/prod key' deploy@app.example.test");

    expect(parsed.config).toMatchObject({
      session_type: "SSH",
      host: "app.example.test",
      port: 2201,
      username: "deploy",
      auth_method: { PrivateKey: { key_path: "/home/me/prod key" } },
    });
    expect(JSON.parse(parsed.config.options_json)).toMatchObject({
      x11: false,
      x11Trusted: true,
    });
  });

  it("normalizes OpenSSH local forward port-only specs for Taomni", () => {
    const parsed = parseSshConnectionCommand("ssh -L 15432:db.internal:5432 app.example.test");

    expect(parsed?.options.networkSettings?.localForwards).toEqual([
      expect.objectContaining({
        local: "127.0.0.1:15432",
        remote: "db.internal:5432",
      }),
    ]);
  });

  it("parses Serial targets without storing baud in the session port", () => {
    const parsed = parseQuickConnectInput("serial /dev/ttyUSB0:115200");

    expect(parsed.config).toMatchObject({
      session_type: "Serial",
      host: "/dev/ttyUSB0",
      port: 0,
      auth_method: "None",
    });
    expect(JSON.parse(parsed.config.options_json)).toMatchObject({ serialBaud: "115200" });
  });

  it.each([
    ["browser://docs.example.test", "https://docs.example.test"],
    ["browser https://docs.example.test/path?q=1", "https://docs.example.test/path?q=1"],
    ["https://docs.example.test/path?q=1", "https://docs.example.test/path?q=1"],
  ])("parses Browser targets as URL sessions", (input, url) => {
    const parsed = parseQuickConnectInput(input);

    expect(parsed.config).toMatchObject({
      name: url,
      session_type: "Browser",
      host: url,
      port: 0,
      username: null,
      auth_method: "None",
    });
  });
});
