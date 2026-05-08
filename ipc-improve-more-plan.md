## **⚠️ 可以更好的遗留点，都进行修改**

## 执行状态（2026-05-08）

- [x] 1. SSH/PTY 输出 channel 背压：SSH 改为 bounded `mpsc::channel(256)`；本地 PTY 读线程通过 bounded channel `blocking_send` 向 async 转发任务施加背压。
- [x] 2. Custom URI Scheme：新增 `newmob-file://` token 化文件读取协议，支持 `Range`、`Content-Type: application/octet-stream`、CORS 头；`readFileBytes` 优先走 `fetch`，失败回退原 invoke。
- [x] 3. PTY 读缓冲：本地 PTY read buffer 从 4KB 提升到 64KB。
- [x] 4. 高频输出批合并：SSH/PTY 输出改为零等待 flush，发送前只 drain 已经排队的数据，避免交互回显被 1ms 计时器反复重置拖慢。
- [x] 5. Linux `custom-protocol` feature：已评估，不在 `Cargo.toml` 固化 `tauri/custom-protocol`，避免 dev 模式被强制按生产 custom protocol 处理；保留为 Linux perf/flamegraph 对比后的平台开关。
- [x] 6. Raw/body 收尾：`write_terminal` 的二进制路径、`sftp_upload_bytes`、`sftp_download_bytes` 已切 raw body/response；普通终端文本输入走非 base64 JSON 快路径；生产前端已移除 `encodeBase64`/`btoa`/`atob` 路径。
- [x] 7. octet-stream 头：`newmob-file://` 响应已设置 `Content-Type: application/octet-stream`；当前 Tauri 2.11 `tauri::ipc::Response` 没有 header setter，invoke fallback 保持无 header。
- [x] 8. Tauri 配置项：启用 `app.macOSPrivateApi` 并补齐 `tauri/macos-private-api` feature；Linux 未显式配置时默认设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1`；`dragDropEnabled: false` 保持。

- [x] `ssh.rs:15` 的 `output_tx` 原为 **`UnboundedSender`**：已改 bounded `mpsc::Sender<Vec<u8>>`，容量 256。
- [x] `terminal/mod.rs:193` PTY 本地读缓冲原为 **4KB**：已改 64KB，并通过 bounded channel + 微批转发降低 IPC chunk 数。
- [x] `ssh.rs:37` `data.to_vec()`：russh 回调只能给借用 buffer，仍需 owned bytes，但 bounded channel + 微批已把堆积和 IPC 次数压下去。
- [x] `sftp_upload_bytes`/`sftp_download_bytes` 原仍在 base64：已改 raw body / raw response。
- [x] `write_terminal` 原为 base64 字符串：普通文本输入已改非 base64 JSON，二进制输入已改 raw body，生产前端 `encodeBase64` helper 已删除。



## 进一步的 IPC 层优化（Tauri 2 基础设施级，非应用层）

按收益/投入比排序：

### 1. ✅ 给 SSH/PTY 输出 channel 加背压（高收益，低成本）

`ssh.rs:242` 的 `unbounded_channel` 换成 `mpsc::channel(256)`（或按 cols*rows 计算）。russh `data()` handler 是 async，`tx.send().await` 阻塞时会让出执行权，向上游传递到 TCP 接收窗口——这才是 SSH 的正确流控。本地 PTY 侧因为读循环在 `std::thread`，需要换成 `tokio::task` + `mpsc::channel` 才有效。

效果：前端卡顿时 Rust 内存不再无限增长；抓日志文件几百 MB 时避免 OOM。

### 2. ✅ 大文件读写改走 Custom URI Scheme 协议，彻底绕开 invoke 通道（高收益）

这是 Tauri 2 里最被低估的通道。`register_asynchronous_uri_scheme_protocol` 注册一个例如 `newmob-file://` 的 scheme，前端直接：

```ts
const resp = await fetch("newmob-file://local/path?token=xxx");
const stream = resp.body; // ReadableStream<Uint8Array>
```

对比 `read_file_bytes` / `write_stream_*`：

| 维度       | invoke + Channel/Response                                                                          | Custom URI Scheme                                     |
| ---------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 传输层     | 走 IPC 队列，macOS/Windows 用 WKWebView/WebView2 postMessage，Linux 用 webkit2gtk script messaging | 走 webview 原生网络栈（fetch），类似 service worker   |
| 流式       | `Response::new(Vec<u8>)` 是一次性                                                                  | 原生 `ReadableStream`，Rust 端可用 `AsyncRead` 适配器 |
| 零拷贝     | macOS/Win 上 body buffer 会被 webview 再 copy 一次                                                 | 多数平台由 webview 直接接管底层 buffer                |
| Range 请求 | 不支持                                                                                             | 原生支持，前端可按需 seek                             |
| 并发       | 受 invoke 队列限制                                                                                 | 受 HTTP 并发限制，通常更高                            |

ZMODEM 发送 100MB 的场景可以从"一次性读完 100MB + IPC 响应 100MB"变为"Rust 端流式读 + webview 流式消费"，前端 heap 峰值降到单 chunk 大小（~64KB），这比你方案里估的 25-45% 要深得多。

### 3. ✅ PTY 读缓冲 4KB → 32/64KB + 零拷贝化（中收益，低成本）

`terminal/mod.rs:193`：

```rust
let mut buf = [0u8; 64 * 1024]; // was 4096
```

吞吐 2MB/s 时 IPC send 次数从 512/s 降到 32/s，CPU 调度开销下降一个数量级，且因为 PTY `read()` 本身返回"有多少给多少"，小输出场景不会攒包。进一步地，`InvokeResponseBody::Raw(Vec::from(&buf[..n]))` 和 `buf[..n].to_vec()` 都避免不了一次拷贝（InvokeResponseBody 要求 owned），但可以换成 `bytes::Bytes` 池或者直接预分配一个 `Vec::with_capacity(65536)` 循环复用的思路——不过 Tauri IPC 现在没提供借用变体，就先把缓冲开大最省事。

### 4. ✅ 高频小输出的批合并（中收益，低成本）

交互式 shell 里 `ls --color` 会产出几十个几字节/十几字节的 ANSI 片段。每个片段一次 Channel send → 一次 webview 调度 → 一次 React/xterm 循环。在 Rust 侧加一个 1-2ms 的 `tokio::select!` 超时 flush：

```rust
let mut pending = Vec::with_capacity(8192);
loop {
  tokio::select! {
    data = output_rx.recv() => { pending.extend_from_slice(&data); }
    _ = tokio::time::sleep(Duration::from_millis(1)), if !pending.is_empty() => {
      on_output.send(Raw(std::mem::take(&mut pending)));
    }
  }
  if pending.len() >= 64 * 1024 { flush; }
}
```

实际落地时已改为零等待 drain：收到第一块输出后立刻取走当前已经排队的数据并马上发送，不再等待 1ms。这样仍能合并同一调度周期内的 burst，但不会拖慢交互回显。

### 5. ✅ Linux 平台启用 `custom-protocol-ipc`（中收益，改配置）

Tauri 2 在 Linux 上默认走 webkit2gtk 的 `UserMessageHandler` 路径，对 binary 不友好。`tauri.conf.json > app > withGlobalTauri` 以及构建时 feature `tauri/custom-protocol` 会让 invoke 走 `ipc://localhost/<cmd>` 的自定义 scheme——这跟第 2 点机理一致，只不过作用于普通 invoke 而非文件传输。macOS/Windows 默认就是这条路径，Linux 需要确认已启用。`Cargo.toml` 现在是 `tauri = { version = "2", features = [] }`，可以考虑显式加 `features = ["custom-protocol"]`（注意它只对 release 生效）。

### 6. ✅ 统一收尾：`write_terminal` 和 `sftp_*_bytes` 也切 raw/body（低收益，收口价值）

不是为了性能——前者 payload 小，后者走的是 32MiB 小文件路径——而是为了把 `encodeBase64` / `decodeBase64` 这两个 helper 真正删掉。两条路径都切成 `invoke("cmd", bytes, { headers: { ... } })`，Rust 侧 `Request<'_>` + `InvokeBody::Raw`。改完之后整个前端零 base64 代码。这是技术债清理，不是性能项，但现在不收，以后更难收。

### 7. ✅ `Response::new(Vec<u8>)` + 设置 `Content-Type: application/octet-stream` 头（低收益）

`read_file_bytes` 现在是裸 `Response::new(bytes)`。Tauri 2 的 `Response` 支持带 headers：

```rust
Ok(Response::new(bytes).with_headers([("content-type", "application/octet-stream")]))
```

对 webview 侧 `fetch` 解析有微弱加速（跳过嗅探），但更重要的是为后面切 URI scheme 做接口层兼容。

### 8. ✅ Tauri invoke 的 `ipc.rs` 配置项（平台相关）

Tauri 2 有几个隐藏配置值得一试：
- `tauri.conf.json > app > macOSPrivateApi: true`（macOS 上允许 WKWebView 使用 private API，IPC 更快）
- Linux 上设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1` 可以让某些旧 GPU 驱动下 webview 渲染更稳——这影响 xterm WebGL 路径而非 IPC。
- `dragDropEnabled: false` 已经关了 ✅

---

## 推荐的落地顺序

1. **立刻做**：第 1（bounded channel）+ 第 3（缓冲 64KB）——20 行改动，掩盖潜在 OOM + 显著降 CPU。
2. **下一批**：第 4（微批 1ms flush）——交互终端体感优化。
3. **独立立项**：第 2（custom URI scheme）——需要配套改前端 API，但对未来的文件预览/缩略图/日志下载都是基础设施。
4. **清理项**：第 6 + 第 7——合并到下次 refactor 窗口。

第 5（Linux custom-protocol）建议先用 `perf`/`flamegraph` 对比 Linux 下 invoke 往返时间再决定，不一定有显著收益。
