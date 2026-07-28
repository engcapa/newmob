# SocksCap macOS Phase 6 — Rust 地基实施计划

**目标**：在不依赖 Apple Developer 账号 / 签名 / 公证 / 真机的前提下，把 macOS 透明捕获（Phase 6 / ADR-0003）里**可单测**的地基先建好，让日后拿到 entitlement 时只剩 Xcode target + 签名这一步外部工作。

**约束**：不碰 Phase 1 的现有 system-proxy 路径（保持 `cargo test --lib sockscap` 全绿），不引入编译假激活。

## ⚠️ 架构修正（FFI 单一真相，落地版）

初版计划是"纯 Rust decision + Swift 各自实现"。评审时发现这会导致 **Rust 与 Swift 两份实现漂移**——真机上 `handleNewFlow` 的行为和 Rust 单测无绑定关系。查证还发现两个真机事实（见 ADR-0003 附注）：

1. `NEFlowMetaData.sourceAppSigningIdentifier` **不保证等于 bundle id**；macOS 权威身份是 `sourceAppAuditToken` 经代码签名机构派生的 signing identifier。
2. app↔provider IPC 通常走 `sendProviderMessage`/`handleAppMessage`，控制协议应设计成 **transport-无关**。

因此改为 **FFI 单一真相**：decision + control 逻辑放进独立最小 crate `sockscap-core`（`crate-type = ["rlib","staticlib"]`，仅依赖 serde）。引擎链接其 rlib，macOS 系统扩展链接其 staticlib 并经 C-ABI 调用——**同一份实现，Swift 侧零决策逻辑，不可能漂移**。系统扩展是独立进程，不能链接完整 `taomni_lib`（tokio/tauri/webview），这也是必须独立 crate 的原因。

## 交付结构（已实现）

```
src-tauri/
  Cargo.toml                     // 新增 [workspace] members=["sockscap-core"] + path dep
  sockscap-core/                 // 新 crate：单一真相
    Cargo.toml                   // rlib + staticlib, deps: serde/serde_json
    include/sockscap_core.h      // 手维护 C 头，扩展经 bridging header/module map 引入
    src/decision.rs              // macos_provider_decision + SelectedApps（身份=signing id）
    src/control.rs               // 版本化协议：消息/codec/ControlServer::handle_request 纯函数
    src/ffi.rs                   // extern "C"：selection_from_json/_free/provider_decide/protocol_version
    tests/ffi_smoke.c            // C 程序链接 .a 调用 decision —— 真机 ABI 边界证明
    tests/run_ffi_smoke.sh       // cargo build -p sockscap-core → cc 链接 → 运行
  src/sockscap/transparent/      // 引擎侧薄胶水
    decision.rs                  // re-export core + selected_from_config(&SocksCapConfig)
    control.rs                   // re-export core
    adapter.rs                   // #[cfg(macos)] AF_UNIX serve 循环 + activate() fail-fast
    mod.rs
```

Swift provider（在 `feat/sockscap-cross-platform-design` 分支）需改为：`handleNewFlow` 里调 `sockscap_provider_decide(...)`，删掉自己的 `selectedAppIDs.contains` 判断。本轮未改 Swift（它在设计分支）；改法已在 header 与 adapter 文档写明。

## 背景：为什么是这两块

`resources/macos-provider/SockscapTransparentProxyProvider.swift`（在 `feat/sockscap-cross-platform-design` 分支）两次引用 Rust 侧的 `sockscap::transparent::macos_provider_decision`，但该符号在任何分支都不存在。ADR-0003 与设计计划 §4.1 还要求一个「版本化 JSON-lines 控制协议：调用方认证 + 心跳 + 原子配置版本 + 恢复状态」，同样只有文字没有代码。这两者都是平台无关的纯逻辑，正好是账号门槛之外能落地的部分。

细粒度路由（PROXY/DIRECT/BLOCK）已由 `PolicyEngine` 在 SOCKS 后面完成，所以 provider decision 只是**粗粒度捕获门**：handle（转发进 SOCKS）还是 passthrough（DIRECT 直连），对齐 Swift `handleNewFlow`。

## 核心逻辑要点

### decision（身份=signing identifier）

```rust
pub enum ProviderFlowDecision { Handle, PassThrough }
pub struct SelectedApps { global: bool, signing_ids: HashSet<String>, self_bypass: HashSet<String> }
pub fn macos_provider_decision(source_signing_id: &str, selected: &SelectedApps) -> ProviderFlowDecision
```

规则：`self_bypass` 命中 → PassThrough（先判，防自捕获递归）；`is_global()` → Handle；`signing_ids` 含该 id → Handle；否则 PassThrough。空/NULL id = 不可归属，**跟随 scope**（global→Handle，app→PassThrough），不静默 over-capture。`global` 显式跟踪，不用"空集=global"（避免 App 组无可解析身份时误判全捕获）。

**身份修正**：输入是 provider 从 `sourceAppAuditToken` 派生的 signing identifier，不是假设的 bundle id。`selected_from_config` 目前用 `AppSelector.bundle_id` 作为 macOS signing identifier（多数 app 二者相等）；真机上 picker 应存 signing identifier，防伪由 audit token 保证。

### control（transport-无关）

单行 JSON + `\n`（对齐 helper.rs）。满足 ADR-0003 四项：协议版本握手（不匹配 fail-fast）、token 认证（失败拒绝后续所有请求）、原子配置版本（只接受 `> current`，旧版本被拒且不动已应用配置）、Ping/Pong 心跳 + `Report` 返回 `{state, active_config_version, degraded}`。断链时 provider fail-open(DIRECT)。核心是纯函数 `ControlServer::handle_request`，无 I/O，穷举单测。

### ffi（C-ABI 单一真相）

`sockscap_selection_from_json` / `sockscap_selection_free` / `sockscap_provider_decide` / `sockscap_control_protocol_version`。FFI 安全：NULL 与非法 UTF-8 都处理、无跨界 panic、所有权明确（from_json 返回指针须 free 一次）。NULL selection → fail closed(PassThrough)。

### adapter（`#[cfg(macos)]`，引擎侧）

`activate()` **明确返回 entitlement 未打包错误，不假装成功**（保持 preflight fail-fast）。`serve_control` 是真实可测的 `AF_UNIX` 服务循环，驱动 core 的 `ControlServer`。

## 接线（保持 Phase 1 不变）

`sockscap/mod.rs` 加 `pub mod transparent;`（唯一改动的既有源文件，+1 行）。`transparent` 不接入 `sockscap_start` 运行路径——是**待激活地基**，capabilities 仍报 `app_filter=false`/`system-proxy`。

## 验证记录（已通过）

- `cargo test -p sockscap-core`：**27 passed**（decision + control + ffi）。
- `cargo test --lib sockscap`：**61 passed**（原 55 + adapter 3 + selected_from_config 3）。
- `bash sockscap-core/tests/run_ffi_smoke.sh`：C 程序链接 `libsockscap_core.a`、经 C-ABI 调 decision，**OK (control protocol v1)** —— 真机 ABI 边界证明。
- `cargo check --workspace`：**0 error**，`sockscap-core` 与 `transparent` 无新警告。
- `rustfmt --edition 2024` 仅跑新增叶子文件；未跑项目级 `cargo fmt`（按 CLAUDE.md），既有文件零 churn。

## 后续（运行时接线）已完成

上面的"待激活地基"已接入引擎运行时——见 `claudedocs/sockscap-macos-phase6-runtime-plan.md`。要点：

- `transparent/adapter.rs` 的 `AF_UNIX` 控制服务改为 `#[cfg(unix)]` + tokio，**在 Linux 上真正编译+单测**（原先 macOS-gated，3 个 serve 测试从未在本机跑过）；新增 readiness watch + ApplyConfig 推送测试。
- `transparent/activation.rs`：纯 `resolve_extension_bundle`/`extension_present`（全平台单测）+ macOS-only `OSSystemExtensionRequest` shim（`build.rs` 用 `cc` 编 `activation_shim.m`，`sockscap_ne_shim` cfg 门控，无扩展也能链接）。
- `transparent/runtime.rs` + `provider_config.rs`：`choose_macos_backend`、`wait_for_provider`、`build_selection_json`、`ProviderConfig`（动态端口 + token + 自绕过），全部 Linux 单测。
- `capture/macos/transparent.rs`：`MacosTransparentCaptureHandle`（ingress + 控制服务 + 提交激活 + 有界等待 provider 连回），薄胶水；`start_macos_capture` 按扩展是否存在选后端，失败回落 system-proxy。orchestrator 增 macOS 槽 + teardown。
- `capabilities_for(app)`：装了扩展才报 `app_filter=true`/`ne-transparent`，否则 Phase 1。前端已按 `caps.appFilter` 放开 App 模式，无需改。
- Swift provider 已落到 `resources/macos-provider/`，**删本地判断改调 `sockscap_provider_decide`**（身份取 `sourceAppAuditToken`），控制协议客户端 + 动态端口 + loopback 排除。

验证（Linux）：`cargo test -p sockscap-core` 27 passed；`cargo test --lib sockscap` 131 passed（原 111 + 20 新）。

## 仍被账号卡住（ADR-0003 Blocked-on-infra，本轮无法验证）

Xcode 系统扩展 target 的构建、Developer ID 签名、公证、真机用户批准 / 版本升级验证、audit token→signing identifier 的实际内核派生，以及 **NE tunnel glue**（激活后用 `NEAppProxyProviderManager` 起 provider 并经 `sendProviderMessage` 下发 `ProviderConfig`——这是让 provider 连回控制 socket、把引擎翻到 Active 的最后一步；在它就绪前，Start 按设计回落 system-proxy）。所有此类文件均已撰写但标注 unverifiable（Swift provider、`activation_shim.m`、entitlements、Info.plist、module map、build 脚本）。
