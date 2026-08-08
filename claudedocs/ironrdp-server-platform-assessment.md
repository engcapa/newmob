# Taomni `ironrdp-server` 跨平台方案评估

## 文档信息

- 评估日期：2026-08-07
- 最近更新：2026-08-07（macOS 原生链路实施完成）
- 评估对象：Taomni 当前本地 RDP Server 实现
- 核心依赖：`ironrdp 0.17`、`ironrdp-tokio 0.10`、vendored `ironrdp-server 0.13`、`ironrdp-egfx 0.3`
- 目标平台：macOS、Windows、Linux
- 外网资料：通过 `http://192.168.0.110:31028` 代理核对
- 实施基线：`3fd37189`（`feat(rdp): optimize the native macOS capture pipeline`）
- 变更性质：架构评估及实施结果记录；本轮已落地 macOS 原生捕获、输入、编码和权限链路

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
- 作为 macOS 当前控制台共享的实现：核心链路已在代码和自动化测试层达标，发布前仍需真实客户端互操作和性能基准。
- 作为三平台统一的生产实现：协议与平台捕获代码已具备发布候选基础；Windows/Wayland 的真实客户端互操作、真机长稳和量化性能仍需发布前验证，独立会话不属于本实现范围。

### 关键区分

“共享当前控制台桌面”和“远程登录一个独立系统会话”不是同一需求。

- 控制台共享要求看到本地用户当前桌面，并把远程输入注入该桌面。
- 远程登录要求创建、认证、恢复和销毁独立用户会话，通常涉及系统服务、PAM、GDM、RDS 或会话管理器。

IronRDP 适合前者的协议部分，但不会自动提供后者的系统会话生命周期。

Taomni 当前计划已经明确产品不是 Windows RDS 或 TeamViewer 替代品，而是受控环境的本机桌面共享：[local-rdp-server-plan.md](/Users/zhyhang/code/person/taomni/claudedocs/local-rdp-server-plan.md:4)。在这个前提下，保留 IronRDP 是合理决策。

## 二、平台裁决

| 平台 / 场景 | 当前支持状态 | 当前实现 / 推荐实现 | 验证状态与主要限制 |
|---|---|---|---|
| macOS 当前控制台共享 | **核心链路已实现，发布候选** | IronRDP + ScreenCaptureKit + CoreGraphics/Accessibility + VideoToolbox AVC420；`xcap` 捕获回退 | macOS 本机构建和自动化回归已通过；仍需 mstsc、Windows App、macOS 客户端和 FreeRDP 真机矩阵。需要 Screen Recording 与 Accessibility 权限，不覆盖登录窗口和安全桌面 |
| Windows 当前控制台共享 | **代码层已实现，发布候选待真机验证** | IronRDP + Windows Graphics Capture 连续捕获；原生 GDI BitBlt 兼容回退；latest-frame mailbox；显示器拓扑重建与恢复 | 自动化编译/单测已通过；仍需 mstsc、Windows App、FreeRDP 真机互操作、DPI/多显示器/锁屏和长稳性能矩阵 |
| Windows 远程登录 / 独立会话 | **不由 Taomni 内嵌服务器提供** | 使用系统 Remote Desktop Service | 通常要求 Pro/Enterprise；语义是远程登录，不等价于与本地用户同时共享控制台 |
| Linux X11 控制台共享 | **代码与自动化门槛已达标** | XShm/XDamage 区域捕获 + XRandR 几何监听 + `enigo`/XTest 输入 + bitmap 更新 | SHM resize 重建、GetImage 降级、resize-before-frame 和边界测试已通过；仍需真机多屏/旋转/缩放、锁屏及高分辨率性能矩阵 |
| Linux Wayland 控制台共享 | **代码与自动化门槛已达标** | Wayland 会话优先使用同一个 RemoteDesktop Portal 授权屏幕与键鼠，通过持久 PipeWire stream 捕获并通过 Portal 注入输入 | 像素格式/stride/负 stride、坐标映射、流关闭和 mailbox 已覆盖；仍需 GNOME/KDE 真机授权、合成器兼容性、睡眠唤醒和长稳验证 |
| Linux 无头 / 多用户 / 登录界面 | **不支持** | 委托 xrdp；固定 GNOME 环境可评估 GNOME Remote Desktop remote-login/headless | Taomni 没有 PAM/GDM/session gateway，不应在应用内重建系统会话生命周期 |

### macOS

macOS 是当前最适合继续使用 IronRDP 的平台。Taomni 已经采用 ScreenCaptureKit 主路径，并保留 `xcap` 兼容回退：[mac.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/mac.rs)。这比依赖 Apple 原生 Screen Sharing 更符合“标准 RDP 客户端”的要求。

如果产品不要求 RDP 兼容，Apple 原生 Screen Sharing/VNC 的系统集成会更简单；但它不能作为统一 RDP 方案替代 IronRDP。

本次已完成：

1. 捕获线程在服务就绪前预热 ScreenCaptureKit，并用 latest-frame mailbox 替换过期全帧，避免编码慢时反压原生捕获回调。
2. 保留原生 `CVPixelBuffer`/IOSurface 直到 VideoToolbox 编码；bitmap 回退才按需读回 BGRA，并在帧克隆间共享读回缓存。
3. 协商客户端初始桌面尺寸，通过 `SCStream::updateConfiguration` 在采集源缩放；发布新尺寸首帧后才确认尺寸，输入映射同步使用已确认尺寸。
4. Retina 与副屏坐标从 RDP 像素空间映射到 Quartz 全局逻辑坐标；鼠标事件改用 CoreGraphics，键盘继续由专用输入线程处理。
5. 设置页同时展示并请求 Screen Recording 与 Accessibility 权限；输入线程周期性检查 Accessibility 撤销并停止注入。
6. 协商成功时默认使用 EGFX/AVC420 与 VideoToolbox；编码、输出通道、ACK 或解码进度异常时删除 surface，并自动回退到 bitmap 全帧恢复。

仍需完成：真实客户端兼容矩阵、显示器热插拔、睡眠唤醒、锁屏行为和量化性能基准。登录窗口与安全桌面明确不在普通用户态控制台共享范围内。

### Windows

Windows 控制台共享的捕获链路已补齐。`xcap 0.9.6` 的 Windows Graphics Capture 作为连续帧主路径，原生 GDI BitBlt 截图作为兼容回退；WGC 的 frame pool/session 支持显式关闭，停止时先释放零容量帧接收端，避免阻塞的原生回调卡住关闭流程。服务就绪前会同步预热并验证首帧，捕获线程通过 latest-frame mailbox 保持有界背压。显示器选择、拓扑变化、尺寸变化、WGC 断线/异常帧恢复、512 MiB 帧上限和静态桌面首帧均在平台适配层收口。Windows 扩展键改为原生 `SendInput`，将 `0xE0` 标志与硬件扫描码分离，避免第三方输入库把完整 `0xE0xx` 错传给 `wScan`。实现位置为 [capture/win.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/win.rs)、[capture/mod.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/capture/mod.rs)、[display.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/display.rs) 和 [input.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/input.rs)。

当前仍需两类发布验证：

1. 使用 Windows mstsc、Windows App 和 FreeRDP 覆盖单显示器、DPI、窗口移动、显示器热插拔、输入和重连场景。
2. 对 RGBA 拷贝、CPU/GPU、稳定 FPS、端到端时延和 WGC/GDI 回退比例做真机基准；若 bitmap 路径成为瓶颈，再实现直接 D3D11 texture 到编码器的专用后端。

Windows 原生 RDP 更适合“远程登录到系统会话”的场景。微软官方文档要求被连接的主机运行 Windows Pro（当前文档以 Windows 10/11 Pro 为例），客户端可以是其他版本或其他操作系统。它的会话和安全桌面集成明显强于用户态嵌入式服务器，但它不能提供 Taomni 自己定义的统一控制台镜像语义。

### Linux X11

Linux X11 是当前最接近完整链路的路径。XShm/XDamage 适合做区域级脏帧采集，IronRDP 只负责协议和显示更新，职责边界清晰。

本轮已增加 XRandR 事件监听和根窗口几何检查。显示尺寸变化时会重建 MIT-SHM 缓冲；重建失败则降级到 GetImage。显示层先发送 `DisplayUpdate::Resize`，下一次更新才发送新尺寸全帧，避免客户端以旧几何解释像素。

仍需补充：

- XRandR 旋转、缩放和多显示器测试。
- XTest/uinput 输入失败时的明确错误提示。
- VAAPI/NVENC 等硬件编码路径。
- 当前 X11 会话断开、桌面锁定和客户端重连行为测试。

### Linux Wayland

Wayland 路径已改为以会话类型为准：检测到 Wayland 时不会被可用的 XWayland `DISPLAY` 覆盖，而是直接创建 RemoteDesktop Portal session。屏幕源、键盘和指针权限共享同一授权上下文，Portal 返回的 PipeWire FD 由持久 stream 消费。

本轮已完成：

- latest-frame mailbox，只保留最新 PipeWire 帧，慢编码端不会反压捕获回调。
- BGRA/RGBA/BGR/RGB、行 padding、正负 stride 和尺寸上限处理。
- 键盘 keycode/keysym、指针绝对/相对移动、按钮和滚轮 Portal 注入；绝对坐标按 compositor logical size 映射。
- 服务启动时预热并跨认证复用 Portal/PipeWire session，避免每个客户端重复弹授权框。
- PipeWire 线程退出时关闭 mailbox 并唤醒显示端，避免连接停在最后一帧。

仍需：

- 对 GNOME 直接评估 GNOME Remote Desktop；它使用 Mutter、PipeWire 和 libei，能覆盖 remote assistance、headless 和 remote-login。
- 对 KDE 或其他合成器只在经过实机互操作测试后宣布支持。

如果 Taomni 必须支持多种桌面环境，IronRDP + Portal 仍可作为统一应用层方案，但不能承诺与 X11 相同的可靠性。

### Linux 无头和多用户会话

Taomni 的 `session.rs` 当前只有能力探测和未来的 spawn 计划，并不是可用的 PAM/session gateway：[session.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/session.rs)。

这部分不应在 Taomni 内重复实现 xrdp 的多年积累。xrdp 已经提供 PAM 登录、Xorg/Xvnc 会话、重连、动态缩放、剪贴板、驱动器重定向等能力。固定 GNOME 环境下，GNOME Remote Desktop 也已经支持 remote login 和 headless 模式。

## 三、当前代码和依赖证据

### 依赖升级已完成

Taomni 已升级到 `ironrdp 0.17.0`、`ironrdp-tokio 0.10.0`、vendored `ironrdp-server 0.13` 和 `ironrdp-egfx 0.3`：[Cargo.toml](/Users/zhyhang/code/person/taomni/src-tauri/Cargo.toml)。项目 Rust 最低版本同步为 1.94。

升级时已经重放 Taomni 的本地定制：

- server socket 启用 `TCP_NODELAY`，减少输入响应和小块更新等待后续包的机会。
- vendored connector 继续使用关闭默认 features 的 `picky 7.0.0-rc.23`。
- 接入上游初始桌面尺寸能力，并在 macOS 捕获层真正采用客户端请求尺寸。
- 通过直接依赖启用 server EGFX feature，接入 `ironrdp-egfx` AVC420 图形通道。

升级消除了原评估中的版本缺口，但不等于完成客户端兼容认证；所有目标客户端仍需真实握手、输入、resize、静态桌面和连续运动画面测试。

### 单连接行为

vendored server 保持一个 RDP display/input/channel 状态机，但在主连接运行期间继续轮询 listener：[server.rs](/Users/zhyhang/code/person/taomni/src-tauri/vendor/ironrdp-server/src/server.rs)。第二个 TCP 连接现在会被立即接受并关闭，同时通过 `ConnectionHandler::on_busy` 记录日志并发出 `rejected` 会话事件，不再留在 backlog 中静默等待 RDP 协商。当前产品策略明确为 `Reject`；未实现 `Preempt` 或排队，避免未经认证的新连接影响已建立的控制台会话。

### 认证和安全边界

当前认证是 Taomni 配置中的固定用户名/密码，而不是系统账户或 PAM：[auth.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/auth.rs:1)。这适合受控内网，但不具备多用户登录能力。

内嵌 server 继续强制 Hybrid/NLA；出站 RDP client 对新配置和缺失字段默认启用 NLA，显式 `nla: false` 仅作为旧 TLS-only 主机兼容开关。仍需补充：

- 证书持久化、轮换和客户端信任策略。
- 登录失败限速、IP 临时封禁和审计日志。
- 默认只绑定 LAN 或明确配置的地址，不监听公网通配地址。
- 明确 view-only、控制审批和锁屏状态下的权限语义。

### 显示、剪贴板和自动化测试

- macOS 在客户端协商 EGFX/AVC420 成功且 VideoToolbox 可用时默认走系统 H.264 编码；不支持或运行中停滞时自动回退 bitmap。当前实现没有强制或记录 VideoToolbox 是否选中硬件编码器，因此不能把实际硬件加速视为已验证。Windows/Linux 仍主要使用 bitmap，高分辨率性能风险未消除。
- 剪贴板目前仅支持 Unicode 文本，图片和文件不在范围内：[clipboard.rs](/Users/zhyhang/code/person/taomni/src-tauri/src/servers/rdp/clipboard.rs:1)。
- 浏览器自动化用例不会真正启动 RDP 服务，因此不能代表协议互操作覆盖：[TC-auto-F-Servers-1](/Users/zhyhang/code/person/taomni/qa-ui-auto-tests/cases/auto/TC-auto-F-Servers-1-servers-dialog.testcase.yaml:14)。

## 四、本次实施结果与达标情况

### 已完善的内容

| 目标 | 状态 | 实现结果 |
|---|---|---|
| 保持 IronRDP 协议内核并升级到当前版本 | **已达标** | 完成 server、connector、Tokio 和 EGFX 依赖升级，保留本地兼容修改 |
| macOS 原生低时延捕获 | **代码层已达标** | ScreenCaptureKit 预热、自驱动采帧、latest-frame mailbox、静态桌面 idle 与捕获失败分离 |
| 客户端尺寸与 Retina/副屏一致性 | **代码层已达标** | 初始尺寸协商、源端原生缩放、新尺寸首帧后确认、动态输入坐标映射 |
| macOS 可控输入与权限边界 | **代码层已达标** | CoreGraphics 鼠标、Accessibility 预检/请求/撤销检测、无权限时保持可查看但停止控制 |
| macOS VideoToolbox H.264 | **代码层已达标** | AVC420 默认协商、VideoToolbox 异步编码、原生 pixel buffer 生命周期管理；实际硬件/软件编码器选择待增加观测 |
| 有界背压和自动降级 | **已达标** | 编码在途帧上限为 2；编码硬超时 250 ms；ACK/解码停滞时销毁 EGFX surface 并恢复 bitmap |
| Linux X11 动态显示 | **代码层已达标** | XRandR 监听、根窗口几何检测、SHM 重建/GetImage 降级、resize 先于新尺寸全帧 |
| Linux Wayland 捕获与控制 | **代码层已达标** | Wayland 优先路由、RemoteDesktop Portal 联合授权、持久 PipeWire stream、Portal 输入与流失败收口 |
| RDP client 慢消费者背压 | **已达标** | session 与 WebSocket 两层均使用有界控制队列和 latest-complete-frame 批次，旧完整帧可被新帧替换 |
| 单连接忙碌策略 | **已达标** | 活跃会话期间继续 accept 并立即关闭额外连接；记录 rejected 会话事件，不再静默挂起 |
| 自动化回归 | **已达标** | RDP server 32 个测试、RDP client 204 个测试（7 个 live fixture 忽略）、集成 58 个测试、前端 232 个文件/1986 个测试均通过 |
| macOS 生产发布门槛 | **部分达标** | 编译与回归通过；缺真实客户端兼容矩阵、真机长稳和量化性能数据 |
| Windows/Linux 达到同等原生性能 | **代码层部分达标** | Windows WGC/GDI 与 Linux 捕获/授权链路已完成；Windows/Linux 仍主要使用 bitmap，尚无硬件编码和真机量化性能数据 |

### 性能表现

本次可以确认的是热路径和背压模型已经改善，不能把这些结构性结果直接等同于真机 FPS、CPU 或带宽成绩。

| 维度 | 当前实现带来的确定效果 | 尚未测量 / 不能宣称的内容 |
|---|---|---|
| 捕获时延 | ScreenCaptureKit 自己节流，不再被外层重复 sleep；新全帧覆盖 mailbox 中的旧全帧，客户端优先拿到较新的画面 | 尚无端到端输入到显示延迟的 p50/p95 数据 |
| 捕获开销 | ScreenCaptureKit 变更流不再对每个 Retina 全帧做额外去重哈希 | 尚无不同分辨率下 CPU 占用对比 |
| 像素拷贝 | 对齐尺寸下，AVC 路径把原生 `CVPixelBuffer` 直接交给 VideoToolbox，不生成整帧 BGRA 副本；非 16 对齐时直接逐行写入 padding buffer；bitmap 读回只发生在需要时且跨 clone 缓存 | 不能称为全链路“绝对零拷贝”；VideoToolbox、RDP 打包和回退仍可能产生内部缓冲 |
| 编码吞吐 | VideoToolbox AVC420 取代 macOS 高频全帧 bitmap；编码与捕获异步，最多保留 2 个在途输入，避免无界积压 | 尚未记录 VideoToolbox 实际选择硬件还是软件编码器，也没有 1080p/Retina/4K 的稳定 FPS、CPU/GPU 和码率数据 |
| 小更新交互 | RDP TCP socket 启用 `TCP_NODELAY`，降低输入响应和小更新被 Nagle 延迟的风险 | 不是网络 RTT 保证，也没有公网/弱网数据 |
| 尾帧与故障恢复 | 尝试配置 `MaxFrameDelayCount=1`；不支持时在 75 ms idle 后 flush，单帧等待超过 250 ms 切换 bitmap；ACK 或 `totalFramesDecoded` 连续停滞 1.5 s 后删除 EGFX surface 并回退 bitmap | 250 ms 是内部编码等待预算，不是端到端延迟上限；降级期间可能短暂降低画质或帧率 |
| 分辨率缩放 | 客户端请求较小桌面时由 ScreenCaptureKit 在源端输出目标尺寸，减少后续每帧像素数量和编码输入规模 | 节省比例取决于客户端请求尺寸和画面内容，尚未做实测对照 |

因此当前性能结论应表述为：**macOS 已具备低延迟 VideoToolbox 编码所需的正确数据流和有界队列，预期优于原来的逐帧 BGRA + bitmap 路径；是否命中硬件编码器以及实际提升幅度尚待真机观测和基准确认。**

建议发布前至少记录以下矩阵：1080p、Retina 原生尺寸和 4K；静态桌面、文本滚动、窗口拖动和视频播放；分别采集 capture/encode/send p50/p95、端到端延迟、稳定 FPS、CPU/GPU、内存、码率、丢帧/替换帧数和 bitmap fallback 次数。客户端至少覆盖 Windows mstsc、Windows App、macOS Microsoft Remote Desktop 和 FreeRDP。

### 验证记录

截至 2026-08-08，本工作区已通过：

- `cargo check --lib`
- `cargo test --lib servers::rdp:: --quiet`：43 passed
- `cargo test --lib rdp:: --quiet`：218 passed，7 ignored（需要 live RDP fixture）
- `cargo test --lib`：1165 passed，18 ignored
- `cargo test --test integration`：57 passed
- `pnpm build`
- `pnpm test`：232 files、1985 tests passed
- `git diff --check`

本轮 Windows 捕获完善后追加验证：

- `cargo check --lib --target x86_64-pc-windows-msvc --quiet`：通过（仅已有编译警告）
- `cargo test --lib servers::rdp:: --quiet`：32 passed
- `cargo test --manifest-path vendor/ironrdp-server/Cargo.toml --lib --quiet`：10 passed
- `cargo test --lib rdp:: --quiet`：206 passed，7 ignored（该名称过滤器也包含 2 个 Windows server helper 测试）
- `cargo test --test integration --quiet`：58 passed
- `pnpm test`：232 files、1986 tests passed
- `pnpm build`：通过

这些结果覆盖编译、状态机、Wayland PipeWire 像素转换和 stream 关闭、X11 resize/边界、Windows 帧上限和扩展扫描码拆分、捕获 mailbox、resize 顺序、坐标映射、client/WebSocket 慢消费者背压、编码超时/停滞判断和权限设置 UI；它们不替代真实 RDP 客户端、GNOME/KDE 真机图像与输入、硬件编码器和长时间会话验证。

## 五、替代方案比较

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

## 六、后续实施优先级

### P0：完成发布验证并恢复真实跨平台可用性

1. 对 macOS 使用 mstsc、Windows App、macOS Microsoft Remote Desktop 和 FreeRDP 完成真实互操作、长稳和性能基准。
2. 对已完成的 Windows WGC/GDI 捕获完成 mstsc、Windows App、FreeRDP 真机互操作、长稳和性能基准。
3. 在已完成 Portal/PipeWire 优先实现的基础上，验证 GNOME 和 KDE 至少各一套实机环境。

### P1：提升性能和协议兼容性

1. 在 Windows 和 Linux 接入硬件编码；macOS VideoToolbox 链路已完成，但还要记录并验证实际编码器类型。
2. 补动态会话中途 resize、游标缓存和必要的 NSCodec 兼容路径；macOS 初始尺寸与 EGFX 已完成。
3. 将剪贴板从文本扩展到图片和文件，前提是明确安全策略。
4. 增加可长期采样的 capture/encode/send、帧龄、队列替换、EGFX ACK/解码进度和 fallback 指标。

### P2：平台服务分流

1. Linux headless/multi-user 模式调用 xrdp 或 GNOME Remote Desktop。
2. Windows remote-login 模式调用系统 Remote Desktop Service。
3. 只有在产品明确要求统一控制台共享体验时，才继续扩展 Taomni 自己的嵌入式后端。

## 七、建议的最终架构决策

建议将架构决策写成以下口径：

> Taomni 保留 `ironrdp-server` 作为标准 RDP 协议和连接生命周期内核。控制台共享由 Taomni 的平台适配层提供屏幕捕获、输入注入、硬件编码和权限处理。Linux 独立会话、Windows 原生远程登录等系统会话场景，按平台委托给 xrdp、GNOME Remote Desktop 或 Windows Remote Desktop Service。Taomni 不将 `ironrdp-server` 宣称为完整的跨平台 RDS 实现。

这个决策既保留了 Rust/Tauri 的工程优势，也避免为了实现 PAM、GDM、RDS、Wayland compositor 和安全桌面而重新维护一套操作系统服务。

## 八、参考资料

- [IronRDP server README](https://github.com/Devolutions/IronRDP/tree/master/crates/ironrdp-server)
- [IronRDP server CHANGELOG](https://github.com/Devolutions/IronRDP/blob/master/crates/ironrdp-server/CHANGELOG.md)
- [IronRDP single-connection issue #1483](https://github.com/Devolutions/IronRDP/issues/1483)
- [xcap Windows implementation](https://github.com/nashaofu/xcap/tree/v0.9.6/src/windows)
- [Microsoft Remote Desktop requirements](https://support.microsoft.com/en-us/windows/how-to-use-remote-desktop-5fe128d5-8fb1-7a23-3b8a-41e636865e8c)
- [xrdp](https://github.com/neutrinolabs/xrdp)
- [GNOME Remote Desktop](https://gitlab.gnome.org/GNOME/gnome-remote-desktop)
- [Apple Screen Sharing](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac)
