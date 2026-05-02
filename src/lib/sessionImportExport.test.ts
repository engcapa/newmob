import { describe, expect, it } from "vitest";
import type { SessionConfig } from "./ipc";
import {
  parseMobaXtermSessions,
  parseNewMobSessions,
  serializeMobaXtermSessions,
  serializeNewMobSessions,
} from "./sessionImportExport";

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "session-1",
    name: "Prod",
    session_type: "SSH",
    group_path: "User sessions / Production",
    host: "prod.example.com",
    port: 22,
    username: "deploy",
    auth_method: { PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } },
    options_json: JSON.stringify({
      x11: false,
      compression: true,
      startupCmd: "uptime",
      jumpHost: "bastion.example.com",
      jumpUser: "jump",
      jumpPort: "2222",
      terminalProfile: {
        fontFamily: "JetBrains Mono",
        fontSize: 13,
        fontLigatures: true,
        theme: "classic",
        scrollback: 5000,
        cursorStyle: "block",
        cursorBlink: true,
        showScrollbar: true,
        copyOnSelect: false,
        rightClickBehavior: "menu",
        readOnly: false,
        bracketedPaste: true,
        multilinePasteConfirm: true,
        syntaxMode: "shell",
        loggingEnabled: false,
        logPath: "C:\\secret\\terminal.log",
      },
    }),
    created_at: 100,
    updated_at: 100,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("NewMob session import/export", () => {
  it("round trips safe session fields and strips local log paths", () => {
    const exported = serializeNewMobSessions([session()], "Production");
    const parsed = JSON.parse(exported.text) as { sessions: Array<{ folder_path: string | null; options: Record<string, unknown> }> };

    expect(parsed.sessions[0].folder_path).toBeNull();
    expect(JSON.stringify(parsed.sessions[0].options)).not.toContain("terminal.log");

    const result = parseNewMobSessions(exported.text, {
      targetFolder: "Imported",
      now: 1234,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "Prod",
      session_type: "SSH",
      group_path: "User sessions / Imported / Production",
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      created_at: 1234,
      updated_at: 1234,
      last_connected_at: null,
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } });
  });

  it("imports legacy JSON safely and creates duplicate names instead of overwriting", () => {
    const legacy = JSON.stringify({
      sessions: [
        {
          id: "existing-id",
          name: "Prod",
          session_type: "SSH",
          group_path: "User sessions / Production",
          host: "prod.example.com",
          port: 70000,
          username: "deploy",
          auth_method: "Password",
          options_json: JSON.stringify({
            compression: true,
            proxyPass: "secret",
            terminalProfile: { fontSize: 16 },
          }),
          created_at: 1,
          updated_at: 1,
          last_connected_at: 1,
          sort_order: 0,
        },
      ],
    });

    const result = parseNewMobSessions(legacy, {
      targetFolder: "Production",
      now: 2222,
      existingSessions: [session()],
    });

    expect(result.sessions[0].id).not.toBe("existing-id");
    expect(result.sessions[0].name).toBe("Prod (2)");
    expect(result.sessions[0].port).toBe(65535);
    expect(result.sessions[0].last_connected_at).toBeNull();
    expect(result.sessions[0].options_json).toContain("compression");
    expect(result.sessions[0].options_json).not.toContain("proxyPass");
    expect(result.sessions[0].options_json).not.toContain("secret");
  });
});

describe("MobaXterm session import/export", () => {
  it("imports SSH sessions from nested bookmark folders", () => {
    const sshBasic = [
      "0",
      "sesafrazu01",
      "22",
      "azroot",
      "",
      "-1",
      "-1",
      "echo__PIPE__ok",
      "jump.example.com",
      "2222",
      "jump",
      "0",
      "0",
      "0",
      "_ProfileDir_\\keys\\id.ppk",
      "",
      "-1",
      "0",
      "0",
      "0",
      "",
      "1080",
      "",
      "0",
      "0",
      "1",
    ].join("%");
    const text = [
      "[Bookmarks]",
      "SubRep=Azure",
      "ImgNum=41",
      "[Bookmarks_1]",
      "SubRep=Azure\\PRE",
      "ImgNum=41",
      `sesafrazu01=#109#${sshBasic}#MobaFont%10%0%0%0%0%236,236,236%0,0,0%180,180,192%0%-1%0%%xterm%-1#0#SSH__DIEZE__comment#-1`,
    ].join("\r\n");

    const result = parseMobaXtermSessions(text, {
      targetFolder: "Imported",
      now: 3333,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "sesafrazu01",
      session_type: "SSH",
      group_path: "User sessions / Imported / Azure / PRE",
      host: "sesafrazu01",
      port: 22,
      username: "azroot",
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "_ProfileDir_\\keys\\id.ppk" } });
    expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
      x11: true,
      compression: true,
      startupCmd: "echo|ok",
      jumpHost: "jump.example.com",
      jumpPort: "2222",
      jumpUser: "jump",
      description: "SSH#comment",
    });
  });

  it("imports SFTP private key path but does not import plaintext proxy passwords", () => {
    const text = [
      "[Bookmarks]",
      "SubRep=",
      "ImgNum=42",
      "sftp-one=#140#7%sftp.example.com%22%alice%-1%0%%%0%C:\\keys\\alice.ppk%4%proxy.example.com%1080%proxy-user%proxy-secret%C:\\tmp%-1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1#0# #-1",
    ].join("\r\n");

    const result = parseMobaXtermSessions(text, { now: 4444 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "sftp-one",
      session_type: "SFTP",
      host: "sftp.example.com",
      username: "alice",
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\alice.ppk" } });
    expect(JSON.stringify(result.sessions[0])).not.toContain("proxy-secret");
  });

  it("exports MobaXterm bookmark sections with CRLF and skips unsupported session types", () => {
    const result = serializeMobaXtermSessions([
      session(),
      session({
        id: "rdp-1",
        name: "Desktop",
        session_type: "RDP",
        group_path: "User sessions / Production / Desktops",
        host: "rdp.example.com",
        port: 3389,
        username: "admin",
        auth_method: "None",
        options_json: "{}",
      }),
      session({
        id: "local-1",
        name: "Local",
        session_type: "LocalShell",
        group_path: "User sessions / Production",
        host: "",
        port: 0,
        username: null,
        auth_method: "None",
        options_json: "{}",
      }),
    ], "Production");

    expect(result.text).toContain("[Bookmarks]\r\nSubRep=Production\r\nImgNum=41\r\n");
    expect(result.text).toContain("[Bookmarks_1]\r\nSubRep=Production\\Desktops\r\nImgNum=41\r\n");
    expect(result.text).toContain("Prod=#109#0%prod.example.com%22%deploy");
    expect(result.text).toContain("Desktop=#91#4%rdp.example.com%3389%admin");
    expect(result.text).not.toContain("Local=");
    expect(result.skipped).toBe(1);
  });
});
