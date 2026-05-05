import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { Client, type ConnectConfig, type SFTPWrapper, type FileEntry as SftpFileEntry } from "ssh2";
import type { Duplex } from "stream";
import type { IncomingMessage } from "http";

export const SFTP_BRIDGE_PATH = "/__newmob/sftp-bridge";

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ALLOW_PRIVATE_TARGETS =
  process.env.DEV_PROXY_ALLOW_PRIVATE === "1" ||
  process.env.ALLOW_PRIVATE_TARGETS === "1";

interface ConnectMessage {
  id: string;
  type: "connect";
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
}

interface CommandMessage {
  id: string;
  type:
    | "list"
    | "stat"
    | "mkdir"
    | "remove"
    | "rmdir"
    | "rename"
    | "chmod"
    | "realpath"
    | "readtext"
    | "writetext"
    | "uploadbytes"
    | "downloadbytes";
  path?: string;
  oldPath?: string;
  newPath?: string;
  mode?: number;
  recursive?: boolean;
  contents?: string;
  bytesB64?: string;
  maxBytes?: number;
}

interface CancelMessage {
  id: string;
  type: "cancel";
  transferId: string;
}

interface CloseMessage {
  id?: string;
  type: "close";
}

type ClientMessage = ConnectMessage | CommandMessage | CancelMessage | CloseMessage;

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

function classifyEntry(entry: SftpFileEntry): {
  fileType: string;
  isHidden: boolean;
} {
  const mode = entry.attrs.mode ?? 0;
  let fileType = "unknown";
  const ifmt = mode & 0o170000;
  if (ifmt === 0o040000) fileType = "dir";
  else if (ifmt === 0o100000) fileType = "file";
  else if (ifmt === 0o120000) fileType = "symlink";
  else if (ifmt === 0o020000) fileType = "char";
  else if (ifmt === 0o060000) fileType = "block";
  else if (ifmt === 0o010000) fileType = "fifo";
  else if (ifmt === 0o140000) fileType = "socket";
  else if (entry.longname?.startsWith("d")) fileType = "dir";
  else if (entry.longname?.startsWith("l")) fileType = "symlink";
  else fileType = "file";
  return { fileType, isHidden: entry.filename.startsWith(".") };
}

function joinRemote(base: string, name: string): string {
  if (!base) return name;
  if (base === "/") return `/${name}`;
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

export function sftpProxyPlugin(): Plugin {
  let wss: WebSocketServer | null = null;

  return {
    name: "newmob-sftp-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      wss = new WebSocketServer({ noServer: true });

      wss.on("connection", (ws) => {
        let ssh: Client | null = null;
        let sftp: SFTPWrapper | null = null;
        let closed = false;
        const activeTransfers = new Map<string, { cancel: () => void }>();

        const cleanup = () => {
          if (closed) return;
          closed = true;
          for (const t of activeTransfers.values()) {
            try {
              t.cancel();
            } catch {
              /* noop */
            }
          }
          activeTransfers.clear();
          try {
            sftp?.end();
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

        const reply = (id: string, payload: Record<string, unknown>) => {
          send(ws, { id, ...payload });
        };

        const replyError = (id: string, message: string) => {
          reply(id, { type: "error", message });
        };

        ws.on("close", cleanup);
        ws.on("error", cleanup);

        ws.on("message", (raw) => {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(raw.toString()) as ClientMessage;
          } catch {
            return;
          }

          if (msg.type === "close") {
            cleanup();
            return;
          }

          if (msg.type === "cancel") {
            const handle = activeTransfers.get(msg.transferId);
            if (handle) handle.cancel();
            return;
          }

          if (msg.type === "connect") {
            if (ssh) {
              replyError(msg.id, "already connected");
              return;
            }
            const block = isBlockedTarget(msg.host);
            if (block.blocked) {
              replyError(msg.id, `Target host is not permitted from the dev proxy: ${block.reason}`);
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
                replyError(msg.id, "Browser preview cannot read key files. Paste the PEM private key text instead.");
                cleanup();
                return;
              }
            } else if (msg.authMethod === "Agent") {
              replyError(msg.id, "SSH agent is not available in browser preview.");
              cleanup();
              return;
            }

            ssh = new Client();
            ssh.on("ready", () => {
              ssh!.sftp((err, channel) => {
                if (err) {
                  replyError(msg.id, `Failed to open SFTP channel: ${err.message}`);
                  cleanup();
                  return;
                }
                sftp = channel;
                channel.realpath(".", (rerr, resolved) => {
                  const home = rerr ? "/" : resolved;
                  reply(msg.id, { type: "ok", homeDir: home });
                });
              });
            });

            ssh.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
              if (msg.authMethod === "Password" && msg.authData != null) {
                finish(prompts.map(() => msg.authData ?? ""));
              } else {
                finish([]);
              }
            });

            ssh.on("error", (err) => {
              replyError(msg.id, err.message);
              cleanup();
            });

            ssh.on("end", () => {
              if (!closed) {
                send(ws, { type: "closed" });
                cleanup();
              }
            });

            try {
              ssh.connect(cfg);
            } catch (err) {
              replyError(msg.id, (err as Error).message);
              cleanup();
            }
            return;
          }

          if (!sftp) {
            replyError(msg.id, "SFTP not connected");
            return;
          }

          const cmd = msg as CommandMessage;
          switch (cmd.type) {
            case "list": {
              const path = cmd.path || ".";
              sftp.readdir(path, (err, list) => {
                if (err) return replyError(cmd.id, err.message);
                const entries = list.map((e) => {
                  const cls = classifyEntry(e);
                  return {
                    name: e.filename,
                    path: joinRemote(path, e.filename),
                    size: Number(e.attrs.size ?? 0),
                    mtime: Number(e.attrs.mtime ?? 0),
                    mode: Number(e.attrs.mode ?? 0),
                    fileType: cls.fileType,
                    isHidden: cls.isHidden,
                    symlinkTarget: null,
                    owner: null,
                    group: null,
                  };
                });
                reply(cmd.id, { type: "ok", entries });
              });
              return;
            }
            case "stat": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              sftp.stat(cmd.path, (err, attrs) => {
                if (err) return replyError(cmd.id, err.message);
                const mode = Number(attrs.mode ?? 0);
                const ifmt = mode & 0o170000;
                let fileType = "file";
                if (ifmt === 0o040000) fileType = "dir";
                else if (ifmt === 0o120000) fileType = "symlink";
                reply(cmd.id, {
                  type: "ok",
                  entry: {
                    name: cmd.path.split("/").pop() ?? "",
                    path: cmd.path,
                    size: Number(attrs.size ?? 0),
                    mtime: Number(attrs.mtime ?? 0),
                    mode,
                    fileType,
                    isHidden: (cmd.path.split("/").pop() ?? "").startsWith("."),
                  },
                });
              });
              return;
            }
            case "mkdir": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              sftp.mkdir(cmd.path, (err) => {
                if (err) return replyError(cmd.id, err.message);
                reply(cmd.id, { type: "ok" });
              });
              return;
            }
            case "rmdir": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              sftp.rmdir(cmd.path, (err) => {
                if (err) return replyError(cmd.id, err.message);
                reply(cmd.id, { type: "ok" });
              });
              return;
            }
            case "remove": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              if (cmd.recursive) {
                recursiveRemove(sftp!, cmd.path)
                  .then(() => reply(cmd.id, { type: "ok" }))
                  .catch((e) => replyError(cmd.id, e.message ?? String(e)));
              } else {
                sftp.unlink(cmd.path, (err) => {
                  if (err) return replyError(cmd.id, err.message);
                  reply(cmd.id, { type: "ok" });
                });
              }
              return;
            }
            case "rename": {
              if (!cmd.oldPath || !cmd.newPath) return replyError(cmd.id, "missing path");
              sftp.rename(cmd.oldPath, cmd.newPath, (err) => {
                if (err) return replyError(cmd.id, err.message);
                reply(cmd.id, { type: "ok" });
              });
              return;
            }
            case "chmod": {
              if (!cmd.path || cmd.mode == null) return replyError(cmd.id, "missing path/mode");
              sftp.chmod(cmd.path, cmd.mode, (err) => {
                if (err) return replyError(cmd.id, err.message);
                reply(cmd.id, { type: "ok" });
              });
              return;
            }
            case "realpath": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              sftp.realpath(cmd.path, (err, resolved) => {
                if (err) return replyError(cmd.id, err.message);
                reply(cmd.id, { type: "ok", path: resolved });
              });
              return;
            }
            case "readtext": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              const max = Math.min(cmd.maxBytes ?? MAX_REQUEST_BYTES, MAX_REQUEST_BYTES);
              const chunks: Buffer[] = [];
              let total = 0;
              const stream = sftp.createReadStream(cmd.path);
              stream.on("data", (c: Buffer) => {
                total += c.length;
                if (total > max) {
                  stream.destroy(new Error(`file exceeds ${max} bytes`));
                  return;
                }
                chunks.push(c);
              });
              stream.on("error", (err) => replyError(cmd.id, err.message));
              stream.on("end", () => {
                reply(cmd.id, {
                  type: "ok",
                  contents: Buffer.concat(chunks).toString("utf8"),
                });
              });
              return;
            }
            case "writetext": {
              if (!cmd.path || cmd.contents == null) return replyError(cmd.id, "missing path/contents");
              const stream = sftp.createWriteStream(cmd.path);
              stream.on("error", (err) => replyError(cmd.id, err.message));
              stream.on("close", () => reply(cmd.id, { type: "ok" }));
              stream.end(Buffer.from(cmd.contents, "utf8"));
              return;
            }
            case "uploadbytes": {
              if (!cmd.path || !cmd.bytesB64) return replyError(cmd.id, "missing path/bytes");
              const buf = Buffer.from(cmd.bytesB64, "base64");
              if (buf.length > MAX_REQUEST_BYTES) {
                return replyError(cmd.id, `payload exceeds ${MAX_REQUEST_BYTES} bytes`);
              }
              const stream = sftp.createWriteStream(cmd.path);
              const total = buf.length;
              let written = 0;
              const startedAt = Date.now();
              const sendProgress = (final = false) => {
                const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
                const rate = written / elapsed;
                const eta = rate > 0 ? Math.max(0, (total - written) / rate) : 0;
                reply(cmd.id, {
                  type: "progress",
                  bytes: written,
                  total,
                  rate,
                  eta,
                  done: final,
                });
              };
              stream.on("error", (err) => replyError(cmd.id, err.message));
              stream.on("close", () => {
                sendProgress(true);
                reply(cmd.id, { type: "ok" });
              });
              const CHUNK = 64 * 1024;
              let offset = 0;
              const writeNext = () => {
                if (offset >= buf.length) {
                  stream.end();
                  return;
                }
                const end = Math.min(offset + CHUNK, buf.length);
                const slice = buf.subarray(offset, end);
                const ok = stream.write(slice);
                offset = end;
                written = offset;
                if (offset % (CHUNK * 4) === 0 || offset === buf.length) sendProgress(false);
                if (ok) {
                  setImmediate(writeNext);
                } else {
                  stream.once("drain", writeNext);
                }
              };
              writeNext();
              return;
            }
            case "downloadbytes": {
              if (!cmd.path) return replyError(cmd.id, "missing path");
              const max = MAX_REQUEST_BYTES;
              sftp.stat(cmd.path, (serr, attrs) => {
                if (serr) return replyError(cmd.id, serr.message);
                const total = Number(attrs.size ?? 0);
                if (total > max) {
                  return replyError(cmd.id, `file exceeds ${max} bytes`);
                }
                const chunks: Buffer[] = [];
                let received = 0;
                const startedAt = Date.now();
                const stream = sftp!.createReadStream(cmd.path);
                stream.on("data", (c: Buffer) => {
                  chunks.push(c);
                  received += c.length;
                  const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
                  const rate = received / elapsed;
                  const eta = rate > 0 ? Math.max(0, (total - received) / rate) : 0;
                  reply(cmd.id, {
                    type: "progress",
                    bytes: received,
                    total,
                    rate,
                    eta,
                    done: false,
                  });
                });
                stream.on("error", (err) => replyError(cmd.id, err.message));
                stream.on("end", () => {
                  reply(cmd.id, {
                    type: "ok",
                    bytesB64: Buffer.concat(chunks).toString("base64"),
                  });
                });
              });
              return;
            }
            default:
              replyError(cmd.id, `unknown command: ${cmd.type}`);
          }
        });
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (pathOf(req.url) !== SFTP_BRIDGE_PATH) return;
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

async function recursiveRemove(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, attrs) => {
      if (err) return reject(err);
      const mode = Number(attrs.mode ?? 0);
      if ((mode & 0o170000) !== 0o040000) {
        sftp.unlink(path, (uerr) => (uerr ? reject(uerr) : resolve()));
        return;
      }
      sftp.readdir(path, async (rderr, list) => {
        if (rderr) return reject(rderr);
        try {
          for (const entry of list) {
            await recursiveRemove(sftp, joinRemote(path, entry.filename));
          }
          sftp.rmdir(path, (rerr) => (rerr ? reject(rerr) : resolve()));
        } catch (e) {
          reject(e);
        }
      });
    });
  });
}
