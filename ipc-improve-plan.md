# 计划：终端 IPC 二进制化改造

## Context

### 当前问题

当前终端输出和 ZMODEM 文件读写都经过 base64 + JSON 字符串层，存在不必要的编码、复制和短命对象分配。

**终端输出（远程/PTY -> 前端，高频路径）**

- `src-tauri/src/terminal/mod.rs`：本地 PTY 和 SSH 输出都先 `B64.encode(...)`，再通过 `app.emit("terminal-output-{sid}", encoded)` 发给前端。
- `src/lib/ipc.ts`：`listenTerminalOutput` 监听字符串 payload，`decodeBase64()` 使用 `atob` 并手动构造 `Uint8Array`。
- `src/lib/zmodem.ts`：所有终端输出继续进入 `Sentry.consume(Array.from(data))`，这部分 `Array.from` 分配本次不解决。

**终端输入（前端 -> 远程/PTY）**

- `writeTerminal(sessionId, data)` 仍然传 base64 字符串，Rust 端 `B64.decode(&data)` 后写入 PTY/SSH。
- 输入通常是 1-几十字节，收益远小于输出路径；本次不改，避免把 `sessionId` 挪到 raw invoke header 造成更大改动。

**ZMODEM 文件读写**

- `read_file_bytes` 当前返回 base64 字符串，发送大文件时会产生完整文件 + base64 字符串 + JS 解码副本。
- `write_file_bytes` 当前一次性接收完整 base64 字符串，接收大文件时会在 JS 侧先累积所有 chunk，再 merge，再 base64，再让 Rust 解码写盘。

### 必须修正的技术事实

- Tauri 2.11 的 `Channel<Vec<u8>>` 不等于 raw bytes。`Vec<u8>` 会按 `Serialize` 走 JSON 数组。
- 要通过 Channel 发送真正二进制，Rust 必须发送 `tauri::ipc::InvokeResponseBody::Raw(bytes)` 或 `tauri::ipc::Response::new(bytes)`。
- JS 侧 raw channel 收到的是 `ArrayBuffer`；调用业务代码前必须显式包装成 `Uint8Array`。
- `create_terminal` 后再 `attach` 会有早期输出丢失竞态；应在创建终端时同时传入输出 channel。

### 范围决策

- **终端输出改为 raw Channel**：创建终端时传入输出 channel，Rust 读循环发送 `InvokeResponseBody::Raw`。
- **前端生成 terminal session id**：`TerminalPanel` 在调用 create command 前生成 `sessionId`，用于构造 ZMODEM sender 和输出 channel，Rust 只校验去重并使用该 id。
- **终端输入暂不改**：继续保留 base64 字符串输入。
- **ZMODEM 接收改为流式写入**：用 raw invoke body 按 chunk 追加写盘，避免前端全量累积和 base64。
- **ZMODEM 发送只做 raw response**：`read_file_bytes` 返回 `tauri::ipc::Response`，但仍一次性读完整文件；真正流式发送不在本次范围。
- **SFTP bytes command 暂不纳入本次**：`sftp_upload_bytes`/`sftp_download_bytes` 仍保留 base64，避免把文件浏览器传输协议和终端/ZMODEM 改造混在一起。

---

## 收益重新评估

以下是基于当前代码结构和 Tauri 2.11 IPC 行为的保守估算，不是实测 benchmark。上线后必须用 profiling 验证。

### 基准假设

| 参数 | 值 | 说明 |
|---|---:|---|
| PTY 读缓冲 | 4096B | 当前 `terminal/mod.rs` 本地读循环使用 4KB buffer |
| 高速输出吞吐 | 2MB/s | 约 512 个 4KB chunk/s |
| 多 tab 压测 | 5 个活跃 tab | 约 10MB/s、2560 chunk/s |
| Tauri raw channel | `InvokeResponseBody::Raw` | 大于 1KB 的 raw payload 可能走 Tauri 内部 fetch 队列，不是零成本 |

### 单个 4KB 输出 chunk

| 项目 | 当前 base64 event | 改后 raw Channel | 可确认收益 |
|---|---|---|---|
| Rust 编码 | 4096B -> 约 5464B base64 字符串 | 直接发送 `Raw(Vec<u8>)` | 消除 Rust base64 编码和字符串分配 |
| IPC body 大小 | base64 膨胀约 33%，相对当前 raw 可少传约 25% | 4096B raw body + 少量控制消息 | 消除 base64 体积膨胀 |
| JS 解码 | `atob` 生成 binary string，再 copy 到 `Uint8Array` | `ArrayBuffer` 包装成 `Uint8Array` view | 消除 atob 和手动 copy |
| Tauri 传输开销 | event JSON 字符串 | raw channel；大块可能走内部 fetch | 仍有 IPC 调度和 ArrayBuffer 分配 |
| ZMODEM sentry | `Array.from(Uint8Array)` | 仍然 `Array.from(Uint8Array)` | 无变化，可能仍是 JS 分配热点 |

### 场景收益

| 场景 | 当前主要成本 | 改后预期 | 更准确的收益判断 |
|---|---|---|---|
| 单终端 2MB/s 输出 | 每秒约 512 次 base64 encode + event 字符串 + atob + copy；同时还有 xterm 渲染和 `Array.from` | 去掉 base64/atob/copy，保留 raw IPC、xterm、`Array.from` | IPC 编解码局部 CPU 预计下降 40-70%；端到端终端 CPU 通常只下降 1-8%，取决于渲染和 sentry 占比 |
| 5 tab 同时 2MB/s 输出 | 每秒约 2560 次字符串和解码分配，GC 压力明显 | 去掉 base64 字符串和 atob binary string，但 `Array.from` 仍存在 | GC 压力中等下降；不能再声称“接近 0”或“整体 80-90%” |
| ZMODEM 接收 100MB | JS chunks 约 100MB + merge 后 100MB + binary/base64 字符串约 133MB 以上 + Rust 解码副本约 100MB | 按 chunk raw append，内存主要是当前 chunk、IPC buffer、短队列和 Rust 写入缓冲 | 峰值从数百 MB 降到通常 < 20MB，保守可认为下降 90-95%+；这是本次最大收益 |
| ZMODEM 发送 100MB | Rust 读 100MB + base64 response 133MB + JS atob/binary string + Uint8Array | Rust 读 100MB + raw ArrayBuffer/Uint8Array；zmodem.js 仍要求完整 bytes | 峰值下降约 25-45%；仍不是流式发送 |
| 终端输入 | 小 payload base64 | 不变 | 无收益，符合范围决策 |

### 汇总表

| 指标 | 原计划说法 | 修正后判断 |
|---|---|---|
| 终端输出 IPC body | 传输 100MB 实际走 133MB | 正确；raw 后 body 回到约 100MB，体积相对当前减少约 25% |
| 终端输出 CPU | 编解码部分降低 80-90% | 对 base64/atob 局部成立偏乐观；考虑 raw channel 调度和 `Array.from` 后，端到端更可能是 1-8% |
| 单终端内存分配 | 降低 50% | 取决于 `Array.from` 占比；应表述为“删除 base64/atob 相关短命对象，GC 中等下降” |
| 多终端 GC | 明显改善 | 方向成立，但需 profiling 量化 |
| ZMODEM 接收大文件 | 降低 99% | 若串行 append 且不积压，90-95%+ 更稳妥 |
| ZMODEM 发送大文件 | 降低 40% | 25-45% 更合理，仍保留完整文件内存 |

---

## 实施方案

### 第一步：终端输出改为创建时 raw Channel

**涉及文件**

- `src-tauri/src/terminal/mod.rs`
- `src/lib/ipc.ts`
- `src/components/terminal/TerminalPanel.tsx`
- `src/stubs/tauri-core.ts`
- `src/stubs/sshClient.ts`
- `src/components/terminal/TerminalPanel.test.tsx`

**Rust command 接口**

前端生成 `sessionId`，Rust 使用传入 id，不再内部生成 id：

```rust
type TerminalOutputChannel = tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>;

#[tauri::command]
pub async fn create_local_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String>

#[tauri::command]
pub async fn create_ssh_terminal(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    auth_data: Option<String>,
    cols: u16,
    rows: u16,
    network_settings_json: Option<String>,
    on_output: TerminalOutputChannel,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String>
```

实现要求：

- Rust 校验 `session_id` 非空，并在插入 `state.terminals` 前检查重复 id；重复时返回错误。
- 本地读循环签名改为接收 `TerminalOutputChannel`，每次读到数据发送：

  ```rust
  let _ = on_output.send(tauri::ipc::InvokeResponseBody::Raw(buf[..n].to_vec()));
  ```

- SSH `output_rx.recv()` 循环同样发送 `InvokeResponseBody::Raw(data)`。
- `terminal-exit-{sid}` 和 `terminal-forward-error-{sid}` 继续使用现有 event；只替换 `terminal-output-{sid}`。
- 不新增 `AppState.output_channels`，避免全局持有 channel 导致泄漏。
- `close_terminal` 仍负责移除 `state.terminals` 并释放 PTY/SSH/forward；读循环结束后 channel 自然 drop。
- SSH 自然断开时，现有移除 terminal 和 abort forwards 的清理逻辑保留。

**前端 IPC 封装**

`src/lib/ipc.ts` 调整为由调用方提供 `sessionId` 和输出回调：

```typescript
export function createTerminalSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createBinaryOutputChannel(callback: (data: Uint8Array) => void): Channel<ArrayBuffer> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (message) => {
    callback(new Uint8Array(message));
  };
  return ch;
}

export async function createLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell: string | undefined,
  cwd: string | undefined,
  onOutput: (data: Uint8Array) => void,
): Promise<string>

export async function createSshTerminal(
  sessionId: string,
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  cols: number,
  rows: number,
  networkSettingsJson: string | null,
  onOutput: (data: Uint8Array) => void,
): Promise<string>
```

删除 `listenTerminalOutput` 和 `decodeBase64` 的终端输出用途；`encodeBase64` 保留给终端输入、认证数据等现有调用。

**TerminalPanel 调整**

- 在创建终端前生成 `sid = createTerminalSessionId()`。
- 先创建 `ZmodemSession`，其 sender 闭包直接使用这个已知 `sid` 调用 `writeTerminal(sid, ...)`。
- 调用 `createLocalTerminal(..., (raw) => zmodem.consume(raw))` 或 `createSshTerminal(..., (raw) => zmodem.consume(raw))`。
- 移除 `unlistenOutput` 变量和 cleanup 中的 `unlistenOutput?.()`；关闭输出通道通过 `closeTerminal(sid)` 触发后端任务结束。
- 保留 `listenTerminalExit` 和 `listenTerminalForwardError`。

### 第二步：ZMODEM 接收改为串行 raw 流式写入

**涉及文件**

- `src-tauri/src/state.rs`
- `src-tauri/src/config/mod.rs`
- `src-tauri/src/lib.rs`
- `src/lib/ipc.ts`
- `src/lib/zmodem.ts`
- `src/components/terminal/TerminalPanel.tsx`
- `src/stubs/tauri-core.ts`

**Rust 状态**

`state.rs` 新增写流句柄，句柄要保存 path 以便 abort 删除 partial 文件：

```rust
pub struct WriteStreamHandle {
    pub path: std::path::PathBuf,
    pub file: std::fs::File,
}

pub struct AppState {
    // existing fields...
    pub write_handles: Arc<Mutex<HashMap<String, WriteStreamHandle>>>,
}
```

**Rust commands**

在 `config/mod.rs` 新增四个命令：

```rust
#[tauri::command]
pub fn write_stream_open(path: String, state: State<'_, AppState>) -> Result<String, String>

#[tauri::command]
pub fn write_stream_append(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<(), String>

#[tauri::command]
pub fn write_stream_close(handle_id: String, state: State<'_, AppState>) -> Result<(), String>

#[tauri::command]
pub fn write_stream_abort(handle_id: String, state: State<'_, AppState>) -> Result<(), String>
```

实现要求：

- `open` 使用 `shellexpand::tilde` 展开路径，`OpenOptions::new().create(true).truncate(true).write(true)` 打开文件，并返回 `uuid` handle id。
- `append` 从 header `x-handle-id` 读取 handle id；`request.body()` 必须是 `InvokeBody::Raw(bytes)`，否则返回明确错误。
- `append` 在同一个 `Mutex<HashMap<...>>` 下取 `file` 并 `write_all(bytes)`，保证单进程内同一 handle 的写入顺序。
- `close` `flush()` 后从 map 移除 handle。
- `abort` 从 map 移除 handle，并 best-effort 删除 partial 文件。
- 所有锁错误、header 缺失、handle 不存在、非 raw body 都返回 `Err(String)`，不要静默吞掉。
- `lib.rs` 注册 `write_stream_open`、`write_stream_append`、`write_stream_close`、`write_stream_abort`。

**前端 IPC**

`src/lib/ipc.ts` 新增：

```typescript
export async function writeStreamOpen(path: string): Promise<string>

export async function writeStreamAppend(handleId: string, data: Uint8Array): Promise<void> {
  return invoke("write_stream_append", data, {
    headers: { "x-handle-id": handleId },
  });
}

export async function writeStreamClose(handleId: string): Promise<void>
export async function writeStreamAbort(handleId: string): Promise<void>
```

`src/stubs/tauri-core.ts` 的 `invoke` 签名同步支持第三个 `options` 参数，并在 browser preview 中用内存 map + `vfsWriteBytes` 模拟 open/append/close/abort。

**ZMODEM receive 串行化**

`ZmodemCallbacks` 用流式回调替换 `onWriteFile`：

```typescript
onOpenWriteStream: (fullPath: string) => Promise<string>;
onAppendWriteStream: (handleId: string, data: Uint8Array) => Promise<void>;
onCloseWriteStream: (handleId: string) => Promise<void>;
onAbortWriteStream: (handleId: string) => Promise<void>;
```

`doReceive` 不再维护 `chunks[]` 和 `mergeChunks()`。每个文件的处理逻辑必须串行 append：

```typescript
const handleId = await this.callbacks.onOpenWriteStream(fullPath);
let appendChain = Promise.resolve();
let appendError: unknown = null;

offer.on("input", (octets: number[]) => {
  const chunk = new Uint8Array(octets);
  progress.bytesTransferred += chunk.length;
  this.callbacks.onProgress({ ...progress });

  appendChain = appendChain
    .then(() => {
      if (appendError) return;
      return this.callbacks.onAppendWriteStream(handleId, chunk);
    })
    .catch((err: unknown) => {
      appendError = err;
    });
});

offer.accept()
  .then(async () => {
    await appendChain;
    if (appendError) throw appendError;
    await this.callbacks.onCloseWriteStream(handleId);
    this.callbacks.onComplete(details.name);
  })
  .catch(async (err: unknown) => {
    await this.callbacks.onAbortWriteStream(handleId).catch(() => undefined);
    this.callbacks.onError(err instanceof Error ? err.message : String(err));
  });
```

关键点：

- 不允许 `void onAppendWriteStream(...)` 直接并发 fire-and-forget，否则可能乱序写或 close 早于 append。
- close 前必须 `await appendChain`。
- 任一 append 失败后必须 abort，避免句柄泄漏和 partial 文件被当作成功结果。
- 每个 offer 独立 handle；多文件接收时逐个文件 open/append/close。

### 第三步：ZMODEM 发送文件改为 raw response

**Rust**

`config/mod.rs` 的 `read_file_bytes` 改为：

```rust
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let expanded = shellexpand::tilde(&path).to_string();
    let bytes = std::fs::read(&expanded)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}
```

保留旧 `write_file_bytes` 直到所有调用移除后再删除；本次改造完成后应只由历史或未迁移代码引用，若 `rg writeFileBytes` 无结果再删 Rust command 和 `lib.rs` 注册项。

**前端**

`readFileBytes` 返回 `Uint8Array`：

```typescript
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}
```

`startZmodemSend` 删除 `atob` 和手动 copy：

```typescript
const bytes = await readFileBytes(filePath);
files.push({ name: fileName, bytes });
```

### 第四步：Browser stubs 和测试同步

**Browser preview stubs**

- `src/stubs/tauri-core.ts` 导出最小 `Channel<T>`，包含 `onmessage`，供 Vite browser alias 编译和运行。
- `invoke` 支持第三个 options 参数：`invoke<T>(cmd, args?, options?)`。
- `create_ssh_terminal` stub 接收 `onOutput` channel，并把 `sshClient` 收到的 base64 输出转换成 `ArrayBuffer` 后调用 `channel.onmessage(buffer)`。
- `read_file_bytes` stub 返回 `vfsReadBytes(path)` 的 `ArrayBuffer`。
- `write_stream_*` stub 用内存 handle map 累积 chunk，close 时写入 `vfsWriteBytes(path, buffer)`，abort 时丢弃。

**单元测试**

- `TerminalPanel.test.tsx` 的 IPC mock 要从 `listenTerminalOutput` 改为新 create API：mock `createLocalTerminal`/`createSshTerminal` 接收 `onOutput`，测试里可主动调用该回调模拟终端输出。
- 删除 `decodeBase64` 相关 mock 断言；保留 `encodeBase64` 输入路径断言。
- `src/lib/zmodem.ts` 增加或更新测试：确认 receive 时 append 串行、close 等待 append、append 失败时 abort 且不上报 complete。
- `src/lib/ipc.ts` 如已有测试，增加 raw `readFileBytes` 和 `writeStreamAppend` header 参数测试；没有测试则通过 `TerminalPanel`/`zmodem` 覆盖核心行为。

---

## 关键文件清单

| 文件 | 改动类型 |
|---|---|
| `src-tauri/src/terminal/mod.rs` | create command 接收 `session_id` + raw output channel；输出发送 `InvokeResponseBody::Raw` |
| `src-tauri/src/state.rs` | 新增 `WriteStreamHandle` 和 `write_handles` |
| `src-tauri/src/config/mod.rs` | 新增 raw stream write commands；`read_file_bytes` 返回 `Response` |
| `src-tauri/src/lib.rs` | 注册新增 commands；迁移完成后移除旧 `write_file_bytes` 注册 |
| `src/lib/ipc.ts` | 新 create terminal API、binary channel helper、raw read/write stream API |
| `src/lib/zmodem.ts` | receive 改串行流式写；send 保持完整文件但使用 raw bytes |
| `src/components/terminal/TerminalPanel.tsx` | 创建前生成 sid；移除 output event listener；接入新 ZMODEM callbacks |
| `src/stubs/tauri-core.ts`、`src/stubs/sshClient.ts` | 支持 Channel、invoke options、raw file/stream stubs |
| `src/components/terminal/TerminalPanel.test.tsx` | 更新 IPC mock 和输出模拟方式 |

---

## 验证方案

### 自动化验证

1. `npm test`
2. `npm run build`
3. `cargo build` 或 `cargo tauri build --debug --no-bundle`
4. 针对 `zmodem.ts` 的 receive 单测必须覆盖：
   - 多 chunk 按顺序 append。
   - close 等待所有 append 完成。
   - append 失败会调用 abort，不调用 complete。
   - 多文件接收每个文件独立 open/close。

### 手动功能验证

1. 本地终端：打开本地 shell，执行 `printf`、`ls`、大量输出命令，确认输出正常。
2. SSH 终端：连接 SSH，确认登录 banner、命令输出、断开事件、端口转发错误事件仍正常。
3. 早期输出竞态：连接会立即输出 banner 的 SSH 服务器，确认第一屏输出不丢。
4. Tab 切换：多 tab 同时输出，切换时无输出串台、无异常。
5. ZMODEM 接收：远端 `sz small_file` 和 `sz large_file`，确认本地文件 hash 一致。
6. ZMODEM 接收失败：中途断开 SSH，确认 partial 文件被 abort 删除或不被报告成功。
7. ZMODEM 发送：本地选择文件，远端 `rz` 接收后 hash 一致。
8. Browser preview：SSH 输出仍能显示；ZMODEM 相关 UI 不因 stubs 缺失而崩溃。

### 性能验证

1. 改造前后分别记录单终端 `cat` 大文件输出时的 CPU、JS heap、minor GC 次数。
2. 记录 5 tab 同时输出时的 JS heap 增长和 UI 卡顿。
3. 记录 ZMODEM 接收 100MB 文件时的前端 heap 峰值和 Rust 进程 RSS。
4. 验收标准以趋势为主：终端输出不应回归，ZMODEM 接收内存峰值必须从数百 MB 降到几十 MB 以内。
