/**
 * Minimal LSP-over-stdio client for the jdtls fixture runner (§8.19.4 R3-c).
 *
 * Mirrors the wire behaviour of the production backend (src-tauri/src/lsp.rs):
 * Content-Length framing, request/response id correlation, and server→client
 * requests answered on demand. It intentionally implements nothing else —
 * this is provider-layer evidence collection, not a second LSP stack.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class LspClient {
  /**
   * @param {string} command absolute path to java
   * @param {string[]} args full JVM arg list (mirrors production launch)
   * @param {{cwd?: string, onDiagnostics?: (params: unknown) => void}} [options]
   */
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = ((this.stderrTail ?? "") + chunk.toString()).split("\n").slice(-40).join("\n");
    });
    this.child.stdin.on("error", () => {
      // Writes racing a dying server must not crash the runner; pending
      // requests are rejected through the exit path below.
    });
    this.exitInfo = null;
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`server exited (${JSON.stringify(this.exitInfo)}) while ${entry.method} was pending\n${this.stderrTail ?? ""}`));
      }
      this.pending.clear();
      this.resolveExit({ code, signal });
    });
    return this;
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error(`malformed LSP header: ${header}`);
      const length = Number.parseInt(match[1], 10);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.#dispatch(JSON.parse(body));
    }
  }

  #dispatch(message) {
    if (typeof message.id === "undefined" && message.method) {
      if (message.method === "textDocument/publishDiagnostics") {
        this.options.onDiagnostics?.(message.params);
        return;
      }
      // Server→client requests we honour: configuration defaults and the
      // register/unregister round-trips jdtls issues during import.
      if (message.method === "workspace/configuration" || message.method === "client/registerCapability"
        || message.method === "client/unregisterCapability" || message.method === "workspace/workspaceFolders"
        || message.method === "window/workDoneProgress/create") {
        const result = message.method === "workspace/configuration"
          ? (message.params.items ?? []).map(() => null)
          : null;
        this.#write({ jsonrpc: "2.0", id: message.id, result });
      }
      return;
    }
    if (typeof message.id !== "undefined" && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  #write(payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.child.stdin.write(Buffer.concat([head, body]));
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms${this.exitInfo ? ` (server exit ${JSON.stringify(this.exitInfo)})\n${this.stderrTail ?? ""}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      if (this.exitInfo) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${method} cannot start: server already exited ${JSON.stringify(this.exitInfo)}\n${this.stderrTail ?? ""}`));
        return;
      }
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async shutdown() {
    try {
      await this.request("shutdown", null, 10_000);
      this.notify("exit", null);
    } catch {
      // Forceful teardown below covers a wedged server.
    }
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    this.child.kill("SIGKILL");
    await this.exitPromise;
  }

  kill(signal = "SIGKILL") {
    this.child.kill(signal);
    return this.exitPromise;
  }
}
