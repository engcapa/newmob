import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { Duplex } from "stream";
import type { IncomingMessage } from "http";

export const SSH_BRIDGE_PATH = "/__newmob/ssh-bridge";

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const ALLOW_PRIVATE_TARGETS =
  process.env.DEV_PROXY_ALLOW_PRIVATE === "1" ||
  process.env.ALLOW_PRIVATE_TARGETS === "1";

const ALLOWED_SIGNALS = new Set([
  "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS",
  "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM",
]);

interface ConnectMessage {
  type: "connect";
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  cols: number;
  rows: number;
  test?: boolean;
}

interface DataMessage {
  type: "data";
  data: string;
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

interface SignalMessage {
  type: "signal";
  signal: string;
}

interface CloseMessage {
  type: "close";
}

type ClientMessage =
  | ConnectMessage
  | DataMessage
  | ResizeMessage
  | SignalMessage
  | CloseMessage;

function send(ws: WebSocket, payload: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function looksLikePemKey(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

function isBlockedTarget(host: string): { blocked: boolean; reason?: string } {
  const lower = host.trim().toLowerCase();
  if (!lower) return { blocked: true, reason: "empty host" };

  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (!ALLOW_PRIVATE_TARGETS && a === 127) return { blocked: true, reason: "loopback target blocked" };
    if (a === 0) return { blocked: true, reason: "0.0.0.0 target blocked" };
    if (!ALLOW_PRIVATE_TARGETS && a === 10) return { blocked: true, reason: "private 10.0.0.0/8 blocked" };
    if (a === 169 && b === 254) return { blocked: true, reason: "link-local blocked" };
    if (!ALLOW_PRIVATE_TARGETS && a === 192 && b === 168) return { blocked: true, reason: "private 192.168.0.0/16 blocked" };
    if (!ALLOW_PRIVATE_TARGETS && a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: "private 172.16.0.0/12 blocked" };
    return { blocked: false };
  }

  if (
    !ALLOW_PRIVATE_TARGETS &&
    (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal"))
  ) {
    return { blocked: true, reason: "loopback hostname blocked" };
  }
  if (!ALLOW_PRIVATE_TARGETS && lower === "::1") {
    return { blocked: true, reason: "loopback target blocked" };
  }
  if (lower === "::") {
    return { blocked: true, reason: "loopback target blocked" };
  }
  if (lower.startsWith("fe80:")) {
    return { blocked: true, reason: "link-local IPv6 blocked" };
  }
  if (!ALLOW_PRIVATE_TARGETS && (lower.startsWith("fc") || lower.startsWith("fd"))) {
    return { blocked: true, reason: "private IPv6 blocked" };
  }
  return { blocked: false };
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  const idx = url.indexOf("?");
  const p = idx >= 0 ? url.slice(0, idx) : url;
  return p.replace(/\/+$/, "");
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch {
    return false;
  }
}

export function sshProxyPlugin(): Plugin {
  let wss: WebSocketServer | null = null;

  return {
    name: "newmob-ssh-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      wss = new WebSocketServer({ noServer: true });

      wss.on("connection", (ws) => {
        let ssh: Client | null = null;
        let channel: ClientChannel | null = null;
        let closed = false;
        let paused = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          try {
            channel?.end();
          } catch {
            /* noop */
          }
          try {
            ssh?.end();
          } catch {
            /* noop */
          }
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
              ws.close();
            } catch {
              /* noop */
            }
          }
        };

        const checkBackpressure = () => {
          if (!channel || closed) return;
          if (!paused && ws.bufferedAmount > HIGH_WATER) {
            paused = true;
            channel.pause();
            const tick = () => {
              if (closed) return;
              if (ws.bufferedAmount < LOW_WATER) {
                paused = false;
                channel?.resume();
              } else {
                setTimeout(tick, 50);
              }
            };
            setTimeout(tick, 50);
          }
        };

        ws.on("close", cleanup);
        ws.on("error", cleanup);

        ws.on("message", (raw) => {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
          } catch {
            send(ws, { type: "error", message: "invalid JSON" });
            return;
          }

          if (msg.type === "connect") {
            if (ssh) {
              send(ws, { type: "error", message: "already connected" });
              return;
            }

            const block = isBlockedTarget(msg.host);
            if (block.blocked) {
              send(ws, {
                type: "error",
                message: `Target host is not permitted from the dev proxy: ${block.reason}`,
              });
              cleanup();
              return;
            }

            const cfg: ConnectConfig = {
              host: msg.host,
              port: msg.port || 22,
              username: msg.username,
              readyTimeout: 15000,
              keepaliveInterval: 30000,
              tryKeyboard: true,
            };

            if (msg.authMethod === "Password") {
              cfg.password = msg.authData ?? "";
            } else if (msg.authMethod === "PrivateKey") {
              if (msg.authData && looksLikePemKey(msg.authData)) {
                cfg.privateKey = msg.authData;
              } else {
                send(ws, {
                  type: "error",
                  message:
                    "Browser preview cannot read key files. Paste the PEM private key text into the password field instead.",
                });
                cleanup();
                return;
              }
            } else if (msg.authMethod === "Agent") {
              send(ws, {
                type: "error",
                message: "SSH agent is not available in browser preview.",
              });
              cleanup();
              return;
            }

            ssh = new Client();

            ssh.on("ready", () => {
              if (msg.test) {
                send(ws, {
                  type: "ok",
                  message: `Authenticated to ${msg.host}:${msg.port} as ${msg.username}`,
                });
                cleanup();
                return;
              }

              ssh!.shell(
                { cols: msg.cols, rows: msg.rows, term: "xterm-256color" },
                (err, ch) => {
                  if (err) {
                    send(ws, {
                      type: "error",
                      message: `Failed to open shell: ${err.message}`,
                    });
                    cleanup();
                    return;
                  }
                  channel = ch;
                  send(ws, { type: "ready" });

                  ch.on("data", (chunk: Buffer) => {
                    send(ws, { type: "output", data: chunk.toString("base64") });
                    checkBackpressure();
                  });
                  ch.stderr.on("data", (chunk: Buffer) => {
                    send(ws, { type: "output", data: chunk.toString("base64") });
                    checkBackpressure();
                  });
                  ch.on("close", () => {
                    send(ws, { type: "closed" });
                    cleanup();
                  });
                },
              );
            });

            ssh.on(
              "keyboard-interactive",
              (_name, _instructions, _lang, prompts, finish) => {
                if (msg.authMethod === "Password" && msg.authData != null) {
                  finish(prompts.map(() => msg.authData ?? ""));
                } else {
                  finish([]);
                }
              },
            );

            ssh.on("error", (err) => {
              send(ws, { type: "error", message: err.message });
              cleanup();
            });

            ssh.on("end", () => {
              send(ws, { type: "closed" });
              cleanup();
            });

            try {
              ssh.connect(cfg);
            } catch (err) {
              send(ws, { type: "error", message: (err as Error).message });
              cleanup();
            }
            return;
          }

          if (msg.type === "data") {
            if (!channel) return;
            try {
              channel.write(Buffer.from(msg.data, "base64"));
            } catch (err) {
              console.error("[ssh-proxy] write error:", err);
            }
            return;
          }

          if (msg.type === "resize") {
            if (!channel) return;
            try {
              channel.setWindow(msg.rows, msg.cols, 0, 0);
            } catch (err) {
              console.error("[ssh-proxy] resize error:", err);
            }
            return;
          }

          if (msg.type === "signal") {
            if (!channel) return;
            const sig = (msg.signal ?? "").toUpperCase().replace(/^SIG/, "");
            if (!ALLOWED_SIGNALS.has(sig)) return;
            try {
              (channel as unknown as { signal: (s: string) => void }).signal(sig);
            } catch (err) {
              console.error("[ssh-proxy] signal error:", err);
            }
            return;
          }

          if (msg.type === "close") {
            cleanup();
            return;
          }
        });
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (pathOf(req.url) !== SSH_BRIDGE_PATH) return;
        if (!isSameOriginRequest(req)) {
          try {
            socket.destroy();
          } catch {
            /* noop */
          }
          return;
        }
        wss!.handleUpgrade(req, socket as Duplex, head, (ws) => {
          wss!.emit("connection", ws, req);
        });
      });
    },
    closeBundle() {
      wss?.close();
      wss = null;
    },
  };
}
