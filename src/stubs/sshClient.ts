import { emit } from "./tauri-event";

const BRIDGE_PATH = "/__newmob/ssh-bridge";
const HANDSHAKE_TIMEOUT_MS = 20000;
const OPEN_TIMEOUT_MS = 8000;

interface ActiveSession {
  ws: WebSocket;
}

const sessions = new Map<string, ActiveSession>();

function bridgeUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BRIDGE_PATH}`;
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeUrl());
    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("WebSocket connection timeout"));
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      window.clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("WebSocket connection failed"));
    };
  });
}

export interface SshConnectArgs {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  cols: number;
  rows: number;
  onOutput?: { onmessage?: (data: ArrayBuffer) => void };
}

type ConnectState = "handshake" | "streaming" | "closed";

export async function sshConnect(args: SshConnectArgs): Promise<string> {
  const sid = args.sessionId;
  const ws = await openSocket();

  let state: ConnectState = "handshake";

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const failHandshake = (err: Error) => {
    if (state !== "handshake") return;
    state = "closed";
    try {
      ws.close();
    } catch {
      /* noop */
    }
    rejectReady?.(err);
  };

  const handshakeTimer = window.setTimeout(
    () => failHandshake(new Error("SSH handshake timeout")),
    HANDSHAKE_TIMEOUT_MS,
  );

  ws.addEventListener("message", (ev) => {
    let msg: { type: string; data?: string; message?: string };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }

    if (state === "handshake") {
      if (msg.type === "ready") {
        state = "streaming";
        sessions.set(sid, { ws });
        window.clearTimeout(handshakeTimer);
        resolveReady?.();
      } else if (msg.type === "error") {
        window.clearTimeout(handshakeTimer);
        failHandshake(new Error(msg.message ?? "SSH connection failed"));
      }
      return;
    }

    if (state === "streaming") {
      if (msg.type === "output" && typeof msg.data === "string") {
        args.onOutput?.onmessage?.(bytesB64ToArrayBuffer(msg.data));
      } else if (msg.type === "closed" || msg.type === "error") {
        state = "closed";
        void emit(`terminal-exit-${sid}`, "closed");
        sessions.delete(sid);
      }
    }
  });

  ws.addEventListener("close", () => {
    window.clearTimeout(handshakeTimer);
    if (state === "handshake") {
      failHandshake(new Error("WebSocket closed before SSH ready"));
    } else if (state === "streaming") {
      state = "closed";
      void emit(`terminal-exit-${sid}`, "closed");
      sessions.delete(sid);
    }
  });

  ws.addEventListener("error", () => {
    window.clearTimeout(handshakeTimer);
    if (state === "handshake") {
      failHandshake(new Error("WebSocket error during SSH handshake"));
    }
  });

  ws.send(JSON.stringify({ type: "connect", ...args }));

  await ready;
  return sid;
}

function bytesB64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function sshTest(args: Omit<SshConnectArgs, "sessionId" | "cols" | "rows" | "onOutput">): Promise<string> {
  const ws = await openSocket();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      fn();
    };

    const timer = window.setTimeout(
      () => settle(() => reject(new Error("SSH test timeout"))),
      HANDSHAKE_TIMEOUT_MS,
    );

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (msg.type === "ok") {
          settle(() => resolve(msg.message ?? "Connection successful"));
        } else if (msg.type === "error") {
          settle(() => reject(new Error(msg.message ?? "Connection failed")));
        }
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener("close", () => {
      settle(() => reject(new Error("WebSocket closed before SSH test result")));
    });

    ws.addEventListener("error", () => {
      settle(() => reject(new Error("WebSocket error during SSH test")));
    });

    ws.send(
      JSON.stringify({
        type: "connect",
        ...args,
        cols: 80,
        rows: 24,
        test: true,
      }),
    );
  });
}

export function sshWrite(sid: string, dataB64: string): void {
  const sess = sessions.get(sid);
  if (!sess) return;
  try {
    sess.ws.send(JSON.stringify({ type: "data", data: dataB64 }));
  } catch (err) {
    console.error("[ssh-stub] write error:", err);
  }
}

export function sshResize(sid: string, cols: number, rows: number): void {
  const sess = sessions.get(sid);
  if (!sess) return;
  try {
    sess.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  } catch (err) {
    console.error("[ssh-stub] resize error:", err);
  }
}

export function sshSignal(sid: string, signal: string): void {
  const sess = sessions.get(sid);
  if (!sess) return;
  try {
    sess.ws.send(JSON.stringify({ type: "signal", signal }));
  } catch (err) {
    console.error("[ssh-stub] signal error:", err);
  }
}

export function sshClose(sid: string): void {
  const sess = sessions.get(sid);
  if (!sess) return;
  try {
    sess.ws.send(JSON.stringify({ type: "close" }));
  } catch {
    /* noop */
  }
  try {
    sess.ws.close();
  } catch {
    /* noop */
  }
  sessions.delete(sid);
}

export function isSshSession(sid: string): boolean {
  return sessions.has(sid);
}
