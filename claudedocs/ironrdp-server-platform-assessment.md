# Taomni `ironrdp-server` 跨平台方案评估

## 文档信息

- 评估日期：2026-08-07
- 评估对象：Taomni 当前本地 RDP Server 实现
- 核心依赖：`ironrdp`、vendored `ironrdp-server`、`xcap`
- 目标平台：macOS、Windows、Linux
- 外网资料：通过 `http://192.168.0.110:31028` 代理核对
- 变更性质：架构评估文档，未修改实现代码

## 一、结论

### 结论摘要

对于 Taomni 当前定义的产品范围，即“受控内网中的本机桌面共享，并兼容 Windows mstsc、Windows App、macOS Microsoft Remote Desktop 和 FreeRDP 客户端”，`ironrdp-server` 是目前最匹配的共享协议内核，建议保留，不建议整体替换。

但它不是三平台的完整远程桌面主机方案。正确的架构应当是：

```text
Taomni 生命周期 / 配置 / UI
            |
      IronRDP RDP 协议层
            |
  平台适配层：采集 / 输入 / 编码 / 权限
            |
  平台原生服务或桌面会话管理（按场景选择）
```

因此最终判断是：

- 作为 Rust/Tauri 内嵌式 RDP 协议层：推荐，属于当前较优解。
- 作为 macOS、Windows、Linux 的统一完整服务器：不是最优解。
- 作为当前代码的生产实现：尚未达标，Windows 仍不能启动，Wayland 和独立会话需要单独处理。

### 关键区分

“共享当前控制台桌面”和“远程登录一个独立系统会话”不是同一需求。

- 控制台共享要求看到本地用户当前桌面，并把远程输入注入该桌面。
- 远程登录要求创建、认证、恢复和销毁独立用户会话，通常涉及系统服务、PAM、GDM、RDS 或会话管理器。

IronRDP 适合前者的协议部分，但不会自动提供后者的系统会话生命周期。

Taomni 当前计划已经明确产品不是 Windows RDS 或 TeamViewer 替代品，而是受控环境的本机桌面共享：[local-rdp-server-plan.md](/Users/zhyhang/code/person/taomni/claudedocs/local-rdp-server-plan.md:4)。在这个前提下，保留 IronRDP 是合理决策。

## 二、平台裁决

| 平台 / 场景 | 裁决 | 推荐实现 | 主要限制 |
|---|---|---|---|
| macOS 当前控制台共享 | 推荐保留 IronRDP | ScreenCaptureKit + Accessibility 输入 + VideoToolbox 编码 | 需要 Screen Recording 和 Accessibility 权限；锁屏、登录窗口和安全桌面不等价于普通 GUI |
| Windows 当前控制台共享 | 保留协议层，但必须补后端 | Windows Graphics Capture（WGC）优先，DXGI Desktop Duplication 兜底，SendInput 注入 | 当前捕获器直接报错；UAC secure desktop、锁屏、跨会话需要服务权限 |
| Windows 远程登录 / 独立会话 | 原生 Windows RDP 更优 | 使用系统 Remote Desktop Service | 通常要求 Pro/Enterprise；语义是远程登录，不等价于与本地用户同时共享控制台 |
| Linux X11 控制台共享 | 推荐保留 IronRDP | XShm/XDamage 捕获 + X11 输入 | 依赖 X server 和当前用户会话；高分辨率下需要硬件编码 |
| Linux Wayland 控制台共享 | 条件保留 | xdg-desktop-portal RemoteDesktop/ScreenCast + PipeWire；固定 GNOME 可用 GNOME Remote Desktop | 用户授权、合成器差异、输入协议和重连语义复杂；不能把 XWayland root 当成完整桌面 |
| Linux 无头 / 多用户 / 登录界面 | 不建议在 Taomni 内重建 | xrdp；GNOME 环境可用 GNOME Remote Desktop remote-login/headless | 涉及 PAM、GDM、Xorg/Wayland 会话、用户切换和进程回收 |

### macOS

macOS 是当前最适合继续使用 IronRDP 的平台。Taomni 已经采用 ScreenCaptureKit 主路径，并保留 `xcap` 兼容回退：[mac.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/mac.rs:1)。这比依赖 Apple 原生 Screen Sharing 更符合“标准 RDP 客户端”的要求。

如果产品不要求 RDP 兼容，Apple 原生 Screen Sharing/VNC 的系统集成会更简单；但它不能作为统一 RDP 方案替代 IronRDP。

建议后续重点放在：

1. 使用 VideoToolbox 直接服务 H.264/AVC420，减少 BGRA CPU 拷贝。
2. 处理 Screen Recording、Accessibility、显示器切换和睡眠唤醒权限状态。
3. 明确锁屏和登录窗口不属于普通用户态控制台共享能力。

### Windows

Windows 是当前最大的阻塞点。代码在创建捕获器时明确 `bail!`：[capture/mod.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/mod.rs:237)，而 `RdpDisplay::new` 会把该错误继续向上传播：[display.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/display.rs:65)。因此现状不是“低质量占位帧”，而是 RDP 服务不能正常启动。

建议采用两阶段实现：

1. 先启用并验证 `xcap 0.9.6` 已有的 WGC/DXGI/GDI 能力，快速覆盖单显示器、DPI、窗口移动、显示器热插拔和帧率场景。
2. 如果 RGBA 截图和 CPU 拷贝成为瓶颈，再实现直接 D3D11 texture 到编码器的专用后端。

Windows 原生 RDP 更适合“远程登录到系统会话”的场景。微软官方文档要求被连接的主机运行 Windows Pro（当前文档以 Windows 10/11 Pro 为例），客户端可以是其他版本或其他操作系统。它的会话和安全桌面集成明显强于用户态嵌入式服务器，但它不能提供 Taomni 自己定义的统一控制台镜像语义。

### Linux X11

Linux X11 是当前最接近完整链路的路径。XShm/XDamage 适合做区域级脏帧采集，IronRDP 只负责协议和显示更新，职责边界清晰。

建议保留该实现，并补充：

- XRandR 旋转、缩放和多显示器测试。
- XTest/uinput 输入失败时的明确错误提示。
- VAAPI/NVENC 等硬件编码路径。
- 当前 X11 会话断开、桌面锁定和客户端重连行为测试。

### Linux Wayland

当前 Wayland 路径存在策略风险：创建捕获器时先尝试 X11，只有 X11 不可用才走 Portal 回退；[capture/mod.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/mod.rs:216)。在带 XWayland 的桌面中，X11 root 通常只代表 X11/XWayland 内容，不能保证覆盖原生 Wayland 窗口。

建议：

- 检测到 Wayland 后优先使用 RemoteDesktop/ScreenCast Portal 和 PipeWire。
- 让屏幕捕获授权和输入注入共享同一个远程桌面授权上下文。
- 对 GNOME 直接评估 GNOME Remote Desktop；它使用 Mutter、PipeWire 和 libei，能覆盖 remote assistance、headless 和 remote-login。
- 对 KDE 或其他合成器只在经过实机互操作测试后宣布支持。

如果 Taomni 必须支持多种桌面环境，IronRDP + Portal 仍可作为统一应用层方案，但不能承诺与 X11 相同的可靠性。

### Linux 无头和多用户会话

Taomni 的 `session.rs` 当前只有能力探测和未来的 spawn 计划，并不是可用的 PAM/session gateway：[session.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/session.rs:14)。

这部分不应在 Taomni 内重复实现 xrdp 的多年积累。xrdp 已经提供 PAM 登录、Xorg/Xvnc 会话、重连、动态缩放、剪贴板、驱动器重定向等能力。固定 GNOME 环境下，GNOME Remote Desktop 也已经支持 remote login 和 headless 模式。

## 三、当前代码和依赖证据

### 依赖版本落后于上游

Taomni 当前使用 `ironrdp 0.15.0`，并通过 vendored/patch 方式使用 `ironrdp-server 0.11.0`：[Cargo.toml](/Users/zhyhang/code/person/taomni/src-tauri/Cargo.toml:105)。当前上游资料显示：

- `ironrdp-server 0.13.0`
- `ironrdp 0.17.0`

上游 `ironrdp-server 0.13.0` 要求 Rust 1.94。升级不能只修改版本号，需要重放 Taomni 对 vendored server 的本地修改，并重新验证 API、编译器版本和所有客户端。

值得评估的上游改进包括：

- 0.12：可选 NSCodec，改善部分 Windows App/macOS 客户端兼容性；新增 `CredentialValidator`。
- 0.13：客户端请求的初始桌面尺寸、Network Auto-Detect 修复、更多剪贴板文件操作接口。

### 单连接行为

当前 vendored server 在 `accept()` 后内联等待 `run_connection()` 完成：[server.rs](/Users/zhyhang/code/person/taomni/src-tauri/vendor/ironrdp-server/src/server.rs:663)。上游也存在对应的公开问题：第二个客户端可能完成 TCP 握手但一直得不到 RDP 协商响应。

如果 Taomni 只允许一个控制台客户端，应实现显式策略：

- `Reject`：立即返回“已有客户端连接”。
- `Preempt`：候选连接完成 TLS/NLA 认证后，才允许接管当前连接。
- `Queue`：只适合明确需要排队的场景。

默认静默挂起不适合作为产品行为。

### 认证和安全边界

当前认证是 Taomni 配置中的固定用户名/密码，而不是系统账户或 PAM：[auth.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/auth.rs:1)。这适合受控内网，但不具备多用户登录能力。

建议继续强制 Hybrid/NLA，并补充：

- 证书持久化、轮换和客户端信任策略。
- 登录失败限速、IP 临时封禁和审计日志。
- 默认只绑定 LAN 或明确配置的地址，不监听公网通配地址。
- 明确 view-only、控制审批和锁屏状态下的权限语义。

### 显示、剪贴板和自动化测试

- macOS AVC420/EGFX 当前是 opt-in 实验路径；其他平台主要仍是 bitmap 传输，高分辨率性能存在风险。
- 剪贴板目前仅支持 Unicode 文本，图片和文件不在范围内：[clipboard.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/clipboard.rs:1)。
- 浏览器自动化用例不会真正启动 RDP 服务，因此不能代表协议互操作覆盖：[TC-auto-F-Servers-1](/Users/zhyhang/code/person/taomni/qa-ui-auto-tests/cases/auto/TC-auto-F-Servers-1-servers-dialog.testcase.yaml:14)。

## 四、替代方案比较

| 方案 | 优势 | 不适合作为 Taomni 统一方案的原因 |
|---|---|---|
| `ironrdp-server` | Rust 原生、可嵌入 Tauri、协议与应用逻辑可组合、无需 C/FFI | 只是服务器骨架；采集、输入、编码、会话和系统权限需自行实现 |
| FreeRDP shadow server | C 生态成熟，协议和部分编码能力较完整 | FFI 和构建成本高；平台 shadow 后端不能直接提供干净的三平台统一嵌入方案 |
| xrdp | Linux 会话、PAM、重连和登录生命周期成熟 | Linux 专用，通常是独立系统服务，不适合直接嵌入 Tauri |
| Windows 原生 RDP | Windows 认证、会话、UAC/安全桌面集成最好 | Windows 专用；远程登录语义与控制台镜像不同；主机版本有限制 |
| Apple Screen Sharing/VNC | macOS 系统集成最好 | 不是 RDP；无法满足统一 mstsc/FreeRDP 客户端要求 |
| GNOME Remote Desktop | GNOME Wayland、PipeWire、libei 和 headless/login 集成好 | 依赖 GNOME/Mutter，不能作为所有 Linux 桌面统一实现 |
| RustDesk/WebRTC | 更适合公网穿透、远程协助、文件和音视频 | 放弃标准 RDP 客户端，产品范围和基础设施都会改变 |

按评价维度排序：

- Rust/Tauri 内嵌和跨平台协议复用：IronRDP 最优。
- 单个平台的系统会话集成：Windows 原生 RDP、Linux xrdp/GNOME Remote Desktop 更优。
- 公网远程协助：RustDesk/WebRTC 类方案更优。
- 三个平台统一且兼容标准 RDP 客户端：IronRDP + 原生平台适配层最平衡。

## 五、实施优先级

### P0：恢复真实跨平台可用性

1. 完成 Windows WGC/DXGI 捕获，并加入 GDI fallback。
2. 对 Wayland 改为 Portal/PipeWire 优先，验证 GNOME 和 KDE 至少各一套实机环境。
3. 为单连接实现显式 `Reject` 或认证后 `Preempt` 策略。
4. 使用 mstsc、Windows App、macOS Microsoft Remote Desktop、xfreerdp 做真实互操作测试。

### P1：提升性能和协议兼容性

1. 评估迁移到 `ironrdp-server 0.13` / `ironrdp 0.17`，重放本地 fork 修改。
2. 为 macOS、Windows、Linux 分别接入硬件编码。
3. 支持客户端初始尺寸、动态缩放、游标缓存和必要的 NSCodec/EGFX 能力。
4. 将剪贴板从文本扩展到图片和文件，前提是明确安全策略。

### P2：平台服务分流

1. Linux headless/multi-user 模式调用 xrdp 或 GNOME Remote Desktop。
2. Windows remote-login 模式调用系统 Remote Desktop Service。
3. 只有在产品明确要求统一控制台共享体验时，才继续扩展 Taomni 自己的嵌入式后端。

## 六、建议的最终架构决策

建议将架构决策写成以下口径：

> Taomni 保留 `ironrdp-server` 作为标准 RDP 协议和连接生命周期内核。控制台共享由 Taomni 的平台适配层提供屏幕捕获、输入注入、硬件编码和权限处理。Linux 独立会话、Windows 原生远程登录等系统会话场景，按平台委托给 xrdp、GNOME Remote Desktop 或 Windows Remote Desktop Service。Taomni 不将 `ironrdp-server` 宣称为完整的跨平台 RDS 实现。

这个决策既保留了 Rust/Tauri 的工程优势，也避免为了实现 PAM、GDM、RDS、Wayland compositor 和安全桌面而重新维护一套操作系统服务。

## 七、参考资料

- [IronRDP server README](https://github.com/Devolutions/IronRDP/tree/master/crates/ironrdp-server)
- [IronRDP server CHANGELOG](https://github.com/Devolutions/IronRDP/blob/master/crates/ironrdp-server/CHANGELOG.md)
- [IronRDP single-connection issue #1483](https://github.com/Devolutions/IronRDP/issues/1483)
- [xcap Windows implementation](https://github.com/nashaofu/xcap/tree/v0.9.6/src/windows)
- [Microsoft Remote Desktop requirements](https://support.microsoft.com/en-us/windows/how-to-use-remote-desktop-5fe128d5-8fb1-7a23-3b8a-41e636865e8c)
- [xrdp](https://github.com/neutrinolabs/xrdp)
- [GNOME Remote Desktop](https://gitlab.gnome.org/GNOME/gnome-remote-desktop)
- [Apple Screen Sharing](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac)

