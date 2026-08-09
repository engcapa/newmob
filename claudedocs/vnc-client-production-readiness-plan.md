# Taomni VNC Client 三端生产级优化完善设计与任务

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 评估对象 | Taomni VNC client，Windows / Linux / macOS |
| 代码基线 | 67d8a48（2026-08-08） |
| 评估日期 | 2026-08-09 |
| 当前定位 | 受控局域网 Beta / 技术预览 |
| 目标定位 | 可观测、可恢复、安全默认、具备明确兼容矩阵的生产级 VNC client |
| 相关实现 | src-tauri/src/vnc/、src/components/vnc/VncPanel.tsx、src/lib/clipboard.ts |

本文的完成度百分比是基于代码、测试和发布链路的工程判断，不代表协议认证结果。功能完成度回答“主要功能是否存在”，生产就绪度回答“是否能在真实故障、安全攻击、长时间运行和三端差异下稳定交付”。

## 2. 执行摘要

Taomni 当前不是三个独立 VNC client，而是三端共用一套实现：

1. Rust 自研 RFB 协议引擎负责握手、认证、编码解码和输入输出。
2. Rust loopback WebSocket relay 在 RFB TCP 与 WebView 之间转发画面和控制消息。
3. React VncPanel 使用 Canvas 渲染，并处理键鼠、剪贴板、缩放、截图和 detach。
4. Windows、Linux、macOS 的差异主要落在 WebView、系统剪贴板、键盘/输入法、DPI、休眠恢复、打包和真实环境验证。

当前已有 RFB 3.3/3.7/3.8、None/VNCAuth/RA2/RA2ne、Raw/CopyRect/Hextile/ZRLE、双向剪贴板、基础键鼠和 Canvas 显示，功能完成度约为 65%–70%。但传输阻塞、安全降级、无界资源、错误的 resize 声明、性能背压、凭据处理和真实 VNC 端到端测试均未达到生产要求，整体生产就绪度约为 40%。

三端判断如下：

| 平台 | 功能完成度 | 生产就绪度 | 当前判断 |
| --- | ---: | ---: | --- |
| Windows | 约 70% | 约 45% | 最接近可用；仍缺安全默认、长稳、DPI/IME 和真实服务器矩阵 |
| Linux | 约 68% | 约 40% | 协议层可复用；WebKitGTK、X11/Wayland 剪贴板和发行版差异未闭环 |
| macOS | 约 62% | 约 35% | WKWebView、Retina、Command/IME、NSPasteboard、睡眠唤醒验证不足 |

结论：

- 当前版本适合可信网络、已知服务器、短时使用的受控 Beta。
- 在完成本文 P0 前，不应宣称“公网安全”“自动分辨率适配”“企业级兼容”或“三端生产可用”。
- 三端受控局域网生产范围预计需要 12–18 工程师周，日历周期约 7–10 周。
- 若目标包括 RealVNC/TigerVNC/TightVNC/macOS Screen Sharing 等广泛兼容、TLS、代理/跳板和 4K 长稳，预计还需追加 4–6 人月。

## 3. 当前实现盘点

### 3.1 当前数据链路

连接链路为：

用户会话配置 → Tauri vnc_connect → RfbConnection TCP 握手/认证 → 127.0.0.1 动态端口 WebSocket → VncPanel → Canvas。

反向控制链路为：

键鼠/剪贴板/resize → WebSocket 控制消息 → RfbWriter → VNC server。

主要模块：

| 模块 | 当前职责 | 评价 |
| --- | --- | --- |
| src-tauri/src/vnc/rfb.rs | RFB 握手、认证、消息读写、framebuffer 状态 | 协议骨架完整，但同步阻塞、边界校验和安全策略不足 |
| src-tauri/src/vnc/encodings.rs | Raw、CopyRect、Hextile、ZRLE 解码 | 有单元测试；缺 Tight/JPEG、资源上限和压力基准 |
| src-tauri/src/vnc/clipboard.rs | Legacy 与 ExtendedClipboard | 功能较丰富；解压上限、平台落盘和隐私保护不足 |
| src-tauri/src/vnc/ws.rs | 本地 relay、任务调度、控制转发 | 职责过重；无界队列、无 relay 鉴权、阻塞读影响取消 |
| src-tauri/src/vnc/mod.rs | Tauri command 与 session 注册 | API 简单；状态、诊断、网络设置和错误模型不足 |
| src/components/vnc/VncPanel.tsx | WebSocket、Canvas、输入、剪贴板、缩放、截图 | 功能集中在单组件；渲染和输入需要平台适配层 |
| src/lib/clipboard.ts | Web/系统剪贴板桥接 | RTF 接收路径明确跳过，浏览器 API 行为依赖 WebView |
| src/lib/detachedSession.ts | 独立窗口 handoff | VNC 一次性明文密码可能短时进入 localStorage |

### 3.2 已实现能力

- RFB 3.3、3.7、3.8 协议版本协商。
- None、VNC password、RealVNC RA2/RA2ne 128/256 认证。
- Raw、CopyRect、Hextile、ZRLE 解码。
- DesktopSize 服务端通知的后端 framebuffer 更新。
- Legacy ClientCutText/ServerCutText。
- ExtendedClipboard caps/request/peek/notify/provide，文本、HTML、RTF 数据模型。
- 鼠标按键、移动、滚轮、pointer capture。
- 基础 X11 keysym 映射、组合键和粘贴时序处理。
- Canvas fit / 1:1、截图、GIF、浮动工具栏、断开后手动重连。
- 标签常驻、detach/reattach 基础链路。
- Rust 解码与剪贴板辅助逻辑单元测试。

### 3.3 已确认的生产阻断项

#### P0-1：阻塞 I/O 无超时，取消不能可靠生效

src-tauri/src/vnc/rfb.rs:53 使用 std::net::TcpStream::connect，未设置 connect/read/write timeout。src-tauri/src/vnc/ws.rs:361 在 Tokio task 内直接调用阻塞 read_server_message。网络黑洞、半开连接或服务端不再发送数据时，任务可能长期占用 Tokio worker；CancellationToken 只有在阻塞调用返回后才能被检查。

影响：连接卡死、断开不及时、退出拖延、并发会话相互影响，无法满足生产故障恢复要求。

#### P0-2：安全类型选择允许静默降级

src-tauri/src/vnc/rfb.rs:156 当前优先选择 None，其后才是 RA2ne、VNCAuth 和 RA2。服务端同时提供明文与加密类型时，客户端会优先选择无认证或弱保护方式。当前也没有 VeNCrypt/TLS、证书校验/指纹固定和“必须加密”策略。

影响：不适合非可信网络；用户看不到实际协商结果；存在降级和中间人风险。

#### P0-3：服务端可控长度缺乏统一上限

协议中的失败原因、server name、framebuffer 尺寸、rectangle 数量、ZRLE 压缩长度等可触发分配。src-tauri/src/vnc/encodings.rs:280 按服务端给定长度直接分配 ZRLE buffer；src-tauri/src/vnc/clipboard.rs:143 对 ExtendedClipboard 解压数据 read_to_end。

影响：恶意或损坏服务端可触发内存耗尽、解压炸弹、CPU 高占用或进程崩溃。

#### P0-4：resize 行为与文档不一致

qa-ui-auto-tests/feature-list.md 声明“DesktopSize + 自动 SetDesktopSize 回写”，但 src-tauri/src/vnc/ws.rs:529 丢弃 Resize 的宽高，只发送一次非增量 framebuffer update。服务端 DesktopSize 更新后端尺寸，但没有完整、显式地同步前端 canvas/store 状态。

影响：功能声明错误；窗口 resize、Retina/高 DPI 和远端分辨率变化可能出现比例错位、黑边、坐标错误或刷新不完整。

#### P0-5：relay 缺少会话鉴权

relay 绑定 127.0.0.1:0，降低了外部网络暴露，但 WebSocket upgrade 没有一次性 token、Origin 校验或明确 path。tauri.conf.json 当前 CSP 关闭。

影响：同机其他进程或可执行 Web 内容有机会探测并接入 relay；一旦 WebView 内容边界被突破，会扩大攻击面。

#### P0-6：凭据与剪贴板日志存在泄露面

VNC detach handoff 会把包含 password 的 payload 写入 localStorage，正常情况下短时消费，但在崩溃或异常路径下可能残留。relay 中存在剪贴板 preview 和 ExtendedClipboard payload 调试日志。

影响：本地取证、日志采集或 WebView 注入场景可能泄露凭据和用户数据。

### 3.4 主要 P1 缺口

- 两条 mpsc 通道均为 unbounded；快服务端/慢 WebView 下会积压内存。
- Hextile/ZRLE 基本按 rectangle/tile 形成 WebSocket 帧，缺帧批处理和 drop-oldest 策略。
- Canvas 主线程使用 putImageData；ACK 早于真正显示完成，不能形成真实渲染背压。
- 缺 Tight/JPEG，复杂桌面和高分辨率弱网带宽效率不足。
- 键盘映射不完整，IME、dead key、数字键盘、系统键和左右修饰键缺少三端验证。
- blur、visibilitychange、WebView 失焦时没有可靠的全键释放，远端可能出现 Ctrl/Alt/Shift 卡住。
- incoming RTF 在 src/lib/clipboard.ts:112 的 Web 路径明确不写入。
- 会话编辑器能保存 proxy/SSH jump 配置，但 MainLayout.openVncTab 没有传递或使用。
- QuickConnect 能解析 vnc://，MainLayout.handleQuickConnect 未把 VNC 纳入连接分支。
- 缺 view-only、shared mode、剪贴板方向策略、安全策略、编码/质量偏好和自动重连设置。
- 缺按阶段记录的连接诊断、协商结果、吞吐、丢帧、解码/绘制时延与结构化错误码。

### 3.5 测试现状

基线验证结果：

| 检查 | 结果 | 局限 |
| --- | --- | --- |
| pnpm build | 通过 | 只证明类型检查和前端构建 |
| cargo test --lib vnc:: | 19 通过，0 失败 | 主要是解码、剪贴板和控制辅助逻辑 |
| qa-ui-auto audit --feature F9.6 | selector 覆盖检查通过 | 不连接真实 VNC server，不证明行为 |
| TC-106 / TC-107 | scaffolding-only | 只验证模块/面板/认证入口存在 |

当前真实 VNC E2E 覆盖为零。浏览器 CI 不运行 Rust VNC backend；macOS CI 即使运行 Chromium，也不能代表 WKWebView。

## 4. 生产范围与非目标

### 4.1 建议的第一阶段生产范围

为了在可控周期内上线，第一阶段应明确收敛到：

- RFB 3.8 优先，兼容 3.3/3.7。
- 可信内网或通过 Taomni 已有 SSH tunnel/proxy 进入目标网络。
- VNCAuth、RA2/RA2ne；None 必须显式允许。
- Raw、CopyRect、Hextile、ZRLE；Tight 可作为 P1 后续兼容项。
- 单显示器 framebuffer，支持服务端 DesktopSize；客户端 SetDesktopSize 仅在服务器声明能力后启用。
- 文本剪贴板为必需，HTML 为条件支持，RTF 按平台能力降级。
- 1080p/60 Hz 目标不应理解为始终 60 FPS；生产门槛以交互延迟、内存稳定和不掉线为准。
- Windows 11、Ubuntu LTS X11/Wayland、macOS 当前和前一主版本作为首批矩阵。

### 4.2 第一阶段非目标

- VNC 文件传输扩展。
- 音频重定向、USB/磁盘/打印机重定向。
- 多显示器扩展桌面和物理显示拓扑控制。
- 移动端和浏览器纯 Web 直连。
- 对所有私有 VNC 安全类型和厂商扩展作兼容承诺。
- 在未部署 TLS/SSH tunnel 时把传统 VNCAuth 描述为公网安全。

## 5. 目标架构设计

### 5.1 分层边界

将当前集中在 rfb.rs、ws.rs、VncPanel.tsx 的职责拆为稳定边界：

| 层 | 建议组件 | 职责 |
| --- | --- | --- |
| 会话编排 | VncSessionManager / VncSession | 状态机、取消、重连、指标、生命周期 |
| 网络传输 | AsyncRfbTransport | DNS、connect/read/write deadline、proxy/tunnel、TLS |
| 协议 | RfbProtocol | 版本、安全协商、消息编码解码、能力协商 |
| 安全策略 | VncSecurityPolicy | 最低安全级别、允许类型、证书/指纹、实际协商报告 |
| 资源治理 | DecodeLimits | framebuffer、rectangle、压缩/解压、剪贴板和队列上限 |
| 帧流水线 | FrameAssembler / FrameMailbox | 合并 rectangle、帧序号、drop-oldest、关键全帧 |
| WebView relay | AuthenticatedLoopbackRelay | 一次性 token、Origin/path、有限队列、协议版本 |
| 前端会话 | useVncSession | 状态、错误、重连、控制 API，脱离具体 UI |
| 渲染 | VncRenderer | 帧合并、Canvas/worker 能力选择、绘制 ACK |
| 输入 | VncInputAdapter | DOM 事件规范化、keysym、IME、按键释放 |
| 剪贴板 | VncClipboardAdapter | 策略、格式转换、平台原生读写、大小限制 |
| 诊断 | VncDiagnostics | 阶段耗时、协商结果、吞吐、丢帧、错误码 |

不要求一次性完成形式上的大重构。P0 应先通过小模块提取引入 deadline、limits、policy 和有界队列，再随 P1 把 UI/平台适配分离。

### 5.2 异步传输与会话状态机

目标会话状态：

Idle → Resolving → Connecting → Negotiating → Authenticating → Initializing → Connected → Reconnecting/Disconnecting → Closed/Failed。

设计要求：

- 使用 tokio::net::TcpStream，或把全套同步 RFB I/O 放入专属 blocking worker；不得在普通 Tokio worker 中无限期阻塞。
- DNS、TCP connect、协议 banner、安全协商、认证、ServerInit 分别设置 deadline。
- 每次读写支持 CancellationToken；用户断开后 2 秒内任务和 socket 必须释放。
- 读循环与写循环所有权清晰，避免长时间持有同一 AsyncMutex。
- 错误返回稳定 code、stage、retryable、sanitized_message，UI 不依赖字符串解析。
- 自动重连只对 retryable 网络错误生效；认证失败、证书不匹配、策略拒绝不得循环重试。
- 重连采用带抖动指数退避，并设置次数/总时长上限。

### 5.3 安全策略

会话配置新增 securityPolicy：

| 策略 | 行为 |
| --- | --- |
| require-encryption | 只允许具有传输加密且满足身份校验策略的类型 |
| prefer-encryption | 选择客户端与服务端共同支持的最强类型；弱类型前显式提示 |
| legacy-compatible | 允许 VNCAuth；UI 明确显示“未加密” |
| allow-none | 仅用户显式开启；不得作为默认 |

安全类型必须按安全强度选择，不能按服务端列表或当前硬编码顺序静默降级。连接成功页/诊断信息要显示协议版本、认证类型、是否加密、服务端身份验证状态。

VeNCrypt/TLS 目标能力：

- 支持常见 VeNCrypt 版本与 TLS 子类型，具体子类型由兼容性 spike 确认。
- 默认验证系统信任链和主机名。
- 私有 CA 可由用户显式配置。
- TOFU/指纹固定必须展示指纹、持久化变更检测并阻止静默替换。
- 敏感字段使用 vault reference；禁止进入日志、URL、localStorage 和前端持久化 store。

### 5.4 资源限制和恶意输入防护

建立统一 DecodeLimits，默认值可配置但必须有硬上限：

| 资源 | 建议默认上限 |
| --- | ---: |
| framebuffer 宽/高 | 各 16384 px |
| framebuffer RGBA 内存 | 256 MiB |
| 单次 rectangle 数 | 4096 |
| 单 rectangle 压缩数据 | 64 MiB |
| 单 rectangle 解压数据 | 128 MiB，且不得超过几何尺寸推导上限 |
| server name / failure reason | 64 KiB |
| clipboard 单格式 | 16 MiB |
| clipboard 解压总量 | 32 MiB |
| relay 单消息 | 64 MiB |
| 帧队列 | 2–3 个逻辑帧 |
| 控制队列 | 固定容量；pointer move 合并，key/button 不丢 |

所有长度计算使用 checked arithmetic。非法尺寸、越界 CopyRect、未知编码、zlib 无进展和超限数据应返回协议错误并关闭单个会话，不能 panic 或影响其他会话。

### 5.5 帧流水线和渲染背压

后端把一次 FramebufferUpdate 组装成带 frame_id 的逻辑帧：

- 同一更新内的 rectangles 合并为一个批次，减少 WebSocket 消息数量。
- 帧头包含协议版本、frame_id、framebuffer 尺寸、rectangle 数和 payload 长度。
- 队列满时对像素帧采用 drop-oldest，保留最新状态；控制、resize、clipboard、disconnect 使用独立有界高优先级通道。
- CopyRect 依赖历史 framebuffer，后端继续维护权威 framebuffer；丢帧后发全量更新恢复一致性。
- 前端完成实际绘制后回传 rendered(frame_id)，后端据此请求增量更新。
- 连续慢渲染触发自适应降频/降质，不持续堆积。
- 优先实测 ImageBitmap、OffscreenCanvas、worker 和主线程 putImageData 在三种 WebView 的支持与收益，再决定渲染路径；必须保留可靠 fallback。

目标指标：

| 场景 | 门槛 |
| --- | --- |
| 1080p 办公桌面，局域网 | p95 输入到可见反馈 ≤ 150 ms |
| 4K 办公桌面，局域网 | p95 输入到可见反馈 ≤ 250 ms |
| 静止画面 30 分钟 | RSS 不持续增长，稳定区间波动 ≤ 10% |
| 快速滚动/视频 10 分钟 | 队列始终有界，无 OOM，无 UI 冻结超过 2 秒 |
| resize 连续 50 次 | canvas、坐标和远端尺寸最终一致，无断连 |

### 5.6 resize 与显示状态协议

区分两个方向：

1. Server → client DesktopSize：服务端改变 framebuffer，后端先验证和调整权威 buffer，再发送 resize(frame_id, width, height)，前端原子更新 canvas、缩放和输入坐标。
2. Client → server SetDesktopSize：仅在服务端通过相关伪编码声明支持时发送；需要 request_id、期望尺寸、超时和结果状态。

如果第一阶段不实现 SetDesktopSize，应从 feature-list 和 UI 移除对应声明，只保留本地 fit。不能继续把本地 Canvas resize 等同于远端桌面 resize。

Retina/高 DPI 下明确区分：

- remote logical size：RFB framebuffer 坐标。
- canvas backing size：像素缓冲尺寸。
- CSS display size：页面布局尺寸。
- devicePixelRatio：只影响本地绘制清晰度，不直接改写远端坐标。

### 5.7 输入设计

VncInputAdapter 维护 pressed key/button 集合，并将 KeyboardEvent.code、key、location、modifier 状态映射为 RFB keysym。

必须覆盖：

- 左右 Ctrl/Alt/Shift/Meta、CapsLock、NumLock、ScrollLock。
- F1–F24、Insert/Delete/Home/End/Page、方向键、数字键盘和 Enter。
- Windows 键、macOS Command/Option 的明确映射策略。
- AltGr、dead key、组合字符和常见中文/日文输入法。
- key repeat；keyup 不得因粘贴拦截而丢失。
- window blur、document visibilitychange、WebView 失焦、detach 和断开时发送所有已按下键/按钮的 release。
- view-only 模式在后端与前端双重禁止输入，不只隐藏 UI。
- 特殊组合键通过明确按钮/命令发送，避免被本机系统拦截。

IME 无法可靠转换为按键序列时，使用“提交文本 → 更新远端剪贴板 → 受控粘贴”的能力路径，并让用户可关闭。

### 5.8 剪贴板设计

新增 clipboardPolicy：

- disabled
- client-to-server
- server-to-client
- bidirectional

另设 textOnly、allowHtml、allowRtf、maxBytes。默认生产配置建议双向文本，HTML/RTF 由管理员或用户显式开启。

平台原生适配器应负责真实系统剪贴板能力，Web API 仅作为 fallback：

- Windows：CF_UNICODETEXT、CF_HTML、可选 RTF。
- Linux：X11 selection 与 Wayland clipboard 的明确支持矩阵；处理 selection owner 生命周期。
- macOS：NSPasteboard UTF-8/HTML/RTF。

日志只记录 format、字节数、方向、结果和 hash 前缀（若确有诊断需要），不得记录 preview 或 payload。接收远端 HTML/RTF 时按不可信输入处理，不在 DOM 中渲染。

### 5.9 网络、代理和 SSH tunnel

VNC 应复用 Taomni 现有 network settings 解析和连接基础设施，而不是在 UI 保存后忽略：

- direct、HTTP CONNECT、SOCKS5。
- SSH jump / local tunnel。
- DNS 在本地还是代理端解析的明确选项。
- 连接测试与正式连接必须走同一网络路径和安全策略。
- 错误中区分 DNS、代理认证、tunnel、TCP、TLS、RFB、认证和初始化阶段。
- 禁止把代理密码和 VNC 密码拼入可记录的 URL。

### 5.10 relay 与 WebView 边界

- vnc_connect 返回 ws_port、随机 128-bit 以上一次性 token、session protocol version。
- WebSocket 使用不可预测 path 或 Authorization/子协议承载 token；首次成功 upgrade 后 token 失效。
- 校验 Origin；只接受一个预期 WebView client，额外连接直接拒绝。
- 配置窄化 CSP，只允许应用自身和动态 loopback 连接所需范围。
- WebSocket 与 RFB 两侧均有消息大小和速率限制。
- detach/reattach 不复制密码；使用后端 session capability 或短时内存 token 认领已有会话。
- session 关闭时 listener、socket、task、buffer 和 capability 一并释放。

### 5.11 可观测性和诊断

每个会话生成不含凭据的 correlation_id，记录：

- 各连接阶段开始、耗时、结果。
- RFB 版本、安全类型、加密状态、server name 的安全摘要。
- 请求和实际 framebuffer 尺寸、编码列表。
- bytes in/out、frame/rectangle 数、decode/render p50/p95、drop 数、队列高水位。
- resize、clipboard 和 reconnect 次数及结果。
- 最终关闭原因、错误码、是否用户触发。

生产日志默认 info 不包含 host 以外的敏感字段；诊断包导出前二次脱敏。指标按会话聚合并设置上限，避免高频 frame 日志本身造成性能问题。

## 6. 协议兼容目标矩阵

| 能力 | 当前 | 第一阶段生产目标 | 后续企业目标 |
| --- | --- | --- | --- |
| RFB 3.3/3.7/3.8 | 已实现 | 回归测试并固定行为 | 持续兼容 |
| None | 自动优先，风险高 | 默认拒绝，仅显式允许 | 管理策略可禁用 |
| VNCAuth | 已实现 | 明确标记未加密，限可信网络/tunnel | 持续兼容 |
| RA2/RA2ne | 已实现 | 修正强度排序，补真实 RealVNC 测试 | 持续兼容 |
| VeNCrypt/TLS | 缺失 | 选型并至少支持主流 TLS 路径 | 证书、私有 CA、指纹固定 |
| Raw | 已实现 | conformance + limits | 持续兼容 |
| CopyRect | 已实现 | 边界与丢帧恢复测试 | 持续兼容 |
| Hextile | 已实现 | conformance + fuzz | 持续兼容 |
| ZRLE | 已实现 | 解压上限、长稳、跨 rectangle 回归 | 持续兼容 |
| Tight/JPEG | 缺失 | 可延期，但不宣称 TightVNC 完整兼容 | P1 必做 |
| DesktopSize 接收 | 部分 | 后端/前端状态原子同步 | 持续兼容 |
| SetDesktopSize | 实际缺失 | 正确实现或删除声明 | 能力协商后启用 |
| ExtendedDesktopSize | 缺失 | 可延期 | 多显示/复杂 resize 时实现 |
| Cursor shape/position | 未形成完整能力 | 评估系统光标 fallback | 服务器矩阵需要时实现 |
| ExtendedClipboard | 已实现基础协议 | bounds、native adapter、策略 | 厂商互通完善 |
| ContinuousUpdates/Fence | 缺失 | 非阻断 | 性能与同步需要时实现 |

## 7. 三端专项设计

### 7.1 Windows

目标环境：Windows 11，WebView2 Evergreen；企业离线环境另行验证 Fixed Version Runtime。

专项工作：

- 基于 WebView2 验证 WebSocket、ClipboardItem、ImageBitmap/OffscreenCanvas 能力，不假设 Chromium 浏览器结果等于 Tauri WebView2。
- 使用 Windows 原生剪贴板适配，解决焦点、权限、CF_UNICODETEXT/CF_HTML/RTF 和大内容问题。
- 覆盖 100%/125%/150%/200% 缩放、多显示器移动和运行中 DPI change。
- 验证 Win/Alt/AltGr、左右修饰键、数字键盘、中文/日文 IME。
- 系统锁屏、RDP 登录到本机、睡眠/唤醒、网络切换后会话状态必须可恢复或明确失败。
- release 包在签名安装版本上运行 VNC smoke，不能只测开发模式。

Windows 当前最接近生产，但不应因 WebView2 较成熟而跳过原生剪贴板和 DPI 测试。

### 7.2 Linux

目标环境至少包括 Ubuntu 24.04 LTS 的 X11/Wayland；根据产品支持范围增加 Ubuntu 22.04、Fedora 当前稳定版。

专项工作：

- 固定并记录最低 WebKitGTK 版本，建立 feature detection，不按浏览器 UA 猜测能力。
- X11 PRIMARY/CLIPBOARD 与 Wayland clipboard 行为分开验证；优先使用 Tauri/Rust 原生适配。
- 验证 ibus/fcitx5、AltGr、Compose/dead key、中英文输入法。
- 覆盖 GNOME/Wayland、GNOME/X11，KDE 仅在承诺支持时进入 gate。
- 验证窗口隐藏、workspace 切换、锁屏、suspend/resume、网络管理器切换。
- 在 deb/AppImage 等实际交付包中验证 WebKitGTK 依赖、CA 证书、代理和 loopback CSP。
- GPU/软件渲染分别测试，避免 Canvas 路径在无硬件加速环境下不可用或 CPU 失控。

Linux 的主要风险不在 RFB 协议，而在 WebKitGTK 版本离散、Wayland/X11 剪贴板与输入法差异。

### 7.3 macOS

目标环境：当前和前一主版本 macOS，Intel/Apple Silicon 是否都支持需由产品矩阵明确。

专项工作：

- 在真实 WKWebView 中验证 binary WebSocket、Canvas、ImageBitmap/worker 和 clipboard 能力。
- 使用 NSPasteboard 原生适配文本、HTML、RTF，不依赖浏览器权限模型作为主路径。
- 明确 Command 作为本地快捷键还是远端 Meta，提供可配置映射；覆盖 Option、Fn、dead key 和中文/日文 IME。
- 区分 Retina backing pixel 与 RFB 坐标，覆盖内建屏/外接非 Retina 屏移动。
- 处理 App Nap、窗口最小化、睡眠/唤醒、网络接口切换和 lid close 后的状态。
- 在签名、hardened runtime、notarized 应用中验证 loopback 连接、证书和剪贴板。
- 验证 macOS Screen Sharing server 的 Apple 特有认证/兼容行为；未支持的类型必须给出可理解错误，不能泛化为密码错误。

macOS 当前验证最弱，不能用 Chrome 自动化结果代替 WKWebView 和系统级行为测试。

## 8. 实施任务清单

估算单位为工程师日，包含开发、自测和 code review，不包含跨团队等待。P0 是生产发布阻断；P1 是稳定性、兼容性或主要体验要求；P2 是增强项。

### 8.1 共享协议与架构任务

| ID | 优先级 | 任务 | 依赖 | 估算 | 验收条件 |
| --- | --- | --- | --- | ---: | --- |
| VNC-COMMON-P0-01 | P0 | 引入可取消的异步 transport 与分阶段 deadline | 无 | 5–7 | 黑洞地址、半开 socket、停止发送的 fixture 均在配置超时内结束；disconnect 后 2 秒内所有 task 退出 |
| VNC-COMMON-P0-02 | P0 | 建立显式 session 状态机和结构化错误 | P0-01 | 3–4 | UI 可区分 DNS/TCP/TLS/RFB/auth/init/runtime；状态转换有单测，不通过字符串解析 |
| VNC-COMMON-P0-03 | P0 | 实现安全策略与最强类型选择 | P0-02 | 3–4 | 默认不选 None；协商结果可见；策略拒绝有明确错误；降级用例自动化通过 |
| VNC-COMMON-P0-04 | P0 | VeNCrypt/TLS 技术验证与最小实现 | P0-01、P0-03 | 5–8 | 至少与选定 TigerVNC/其他 fixture 完成加密连接；校验证书/主机名；错误不可降级为明文 |
| VNC-COMMON-P0-05 | P0 | 统一 DecodeLimits 和 checked arithmetic | 无 | 4–6 | 所有服务端长度/尺寸有上限；超限只关闭当前会话；恶意 corpus 无 panic/OOM |
| VNC-COMMON-P0-06 | P0 | ZRLE/clipboard 有界解压和无进展检测 | P0-05 | 3–4 | 解压炸弹、截断流、超限流、无进展流均确定性失败；内存峰值受限 |
| VNC-COMMON-P0-07 | P0 | relay 一次性 token、Origin/path 校验与消息上限 | 无 | 3–4 | 无 token/错 Origin/第二客户端连接均拒绝；token 不写日志；超大消息关闭会话 |
| VNC-COMMON-P0-08 | P0 | 替换无界 channel，拆分控制和画面优先级 | P0-02 | 4–5 | 队列容量固定；慢消费者 30 分钟内存稳定；key/button 不丢，pointer move 可合并 |
| VNC-COMMON-P0-09 | P0 | 修复 DesktopSize 同步和 SetDesktopSize 声明 | P0-02 | 4–6 | 服务端 resize 后 canvas/坐标一致；若未实现 client resize，文档/UI 不再声称支持 |
| VNC-COMMON-P0-10 | P0 | 移除前端持久化明文密码和敏感日志 | 无 | 2–3 | localStorage/sessionStorage 无 VNC 密码；剪贴板内容不入日志；自动测试扫描通过 |
| VNC-COMMON-P0-11 | P0 | 收紧 VNC 所需 CSP 和 relay 生命周期 | P0-07 | 2–3 | release 配置 CSP 生效；只允许所需 loopback；关闭/失败/detach 无残留 listener/task |
| VNC-COMMON-P1-01 | P1 | 帧批处理、frame_id、rendered ACK 和 drop-oldest mailbox | P0-08、P0-09 | 6–8 | 4K 压测队列不增长；ACK 对应实际绘制；丢帧后能全量恢复一致 |
| VNC-COMMON-P1-02 | P1 | Tight/JPEG 解码或成熟引擎接入 | 引擎 ADR | 8–12 | 选定 TightVNC/TigerVNC fixtures 的 Tight 基础模式通过；畸形输入有 bounds |
| VNC-COMMON-P1-03 | P1 | 完整 input adapter 和失焦全释放 | P0-02 | 5–7 | 键盘矩阵通过；blur/visibility/detach 后远端无卡键；view-only 后端拒绝输入 |
| VNC-COMMON-P1-04 | P1 | clipboard policy、native adapter API 和格式限制 | P0-05 | 4–6 | 四种方向策略生效；超限拒绝；HTML/RTF 不进入 DOM；能力降级可诊断 |
| VNC-COMMON-P1-05 | P1 | 接入 proxy/SOCKS5/SSH jump 网络路径 | P0-01 | 5–8 | connection test 与正式连接路径一致；direct/SOCKS5/SSH jump fixtures 通过 |
| VNC-COMMON-P1-06 | P1 | 自动重连、退避、网络恢复和会话重初始化 | P0-01、P0-02 | 4–6 | 断网/重启 server 可恢复；auth/cert 错误不重试；次数和总时长受限 |
| VNC-COMMON-P1-07 | P1 | 拆分 useVncSession、renderer 与 input/clipboard adapter | P0 稳定后 | 5–7 | VncPanel 不再直接承担全部协议状态；核心 hook/adapter 有聚焦测试 |
| VNC-COMMON-P1-08 | P1 | 连接配置与诊断 UI | P0-02、P0-03 | 4–6 | 可配置 view-only/shared/security/clipboard/resize/reconnect；展示实际协商结果 |
| VNC-COMMON-P1-09 | P1 | 修复 QuickConnect VNC 路由 | P0-02 | 1–2 | vnc:// 与保存会话共用认证、网络、安全和错误链路；有 UI 自动化用例 |
| VNC-COMMON-P2-01 | P2 | Cursor shape、ContinuousUpdates/Fence 可行性与实现 | P1 性能基线 | 5–8 | 仅在真实兼容/性能收益明确后进入；能力协商与 fallback 完整 |

### 8.2 Windows 专项任务

| ID | 优先级 | 任务 | 依赖 | 估算 | 验收条件 |
| --- | --- | --- | --- | ---: | --- |
| VNC-WIN-P0-01 | P0 | WebView2 release 环境真实 VNC smoke | QA fixture | 2–3 | 签名安装包连接、输入、剪贴板、resize、断开均通过 |
| VNC-WIN-P1-01 | P1 | Windows native clipboard adapter | COMMON-P1-04 | 3–5 | Unicode/HTML/RTF 按矩阵双向通过；剪贴板占用时有重试和明确错误 |
| VNC-WIN-P1-02 | P1 | DPI 与多屏坐标适配 | COMMON-P0-09 | 3–4 | 100%–200% 缩放和跨屏移动后显示/点击坐标一致 |
| VNC-WIN-P1-03 | P1 | Win/AltGr/IME 输入矩阵 | COMMON-P1-03 | 3–4 | 中英文 IME、AltGr、数字键盘和左右修饰键无卡键/误映射 |
| VNC-WIN-P1-04 | P1 | 锁屏、睡眠、网络切换恢复 | COMMON-P1-06 | 2–3 | 状态准确；能恢复则恢复，不能恢复则有限时失败并可手动重连 |

### 8.3 Linux 专项任务

| ID | 优先级 | 任务 | 依赖 | 估算 | 验收条件 |
| --- | --- | --- | --- | ---: | --- |
| VNC-LINUX-P0-01 | P0 | 定义 WebKitGTK/发行版支持基线 | 无 | 2 | 文档和 CI 明确最低版本、Ubuntu LTS X11/Wayland gate 与已知限制 |
| VNC-LINUX-P0-02 | P0 | deb/AppImage 真实 VNC smoke | QA fixture | 2–3 | 交付包连接、输入、文本剪贴板、resize、断开均通过 |
| VNC-LINUX-P1-01 | P1 | X11/Wayland native clipboard adapter | COMMON-P1-04 | 4–6 | GNOME X11/Wayland 文本双向必过；HTML/RTF 按声明降级，无 silent loss |
| VNC-LINUX-P1-02 | P1 | ibus/fcitx5/AltGr/Compose 输入矩阵 | COMMON-P1-03 | 3–5 | 主流输入法和布局通过；失焦、workspace 切换无卡键 |
| VNC-LINUX-P1-03 | P1 | GPU/软件 Canvas 性能与 fallback | COMMON-P1-01 | 3–4 | 两种渲染环境均可用；软件路径达到定义的 CPU/延迟门槛 |
| VNC-LINUX-P1-04 | P1 | suspend/lock/network manager 恢复 | COMMON-P1-06 | 2–3 | 休眠和网络切换后状态一致，无后台僵尸会话 |

### 8.4 macOS 专项任务

| ID | 优先级 | 任务 | 依赖 | 估算 | 验收条件 |
| --- | --- | --- | --- | ---: | --- |
| VNC-MAC-P0-01 | P0 | WKWebView + notarized 包真实 VNC smoke | QA fixture | 3–4 | release 包连接、输入、文本剪贴板、resize、断开均通过 |
| VNC-MAC-P1-01 | P1 | NSPasteboard native adapter | COMMON-P1-04 | 3–5 | UTF-8/HTML/RTF 按矩阵双向通过；无浏览器权限依赖 |
| VNC-MAC-P1-02 | P1 | Command/Option/Fn/IME 输入策略 | COMMON-P1-03 | 3–5 | 映射可配置；系统保留快捷键行为明确；中英文 IME 无卡键 |
| VNC-MAC-P1-03 | P1 | Retina/外接屏坐标适配 | COMMON-P0-09 | 3–4 | Retina 与非 Retina 跨屏后画面清晰，指针坐标准确 |
| VNC-MAC-P1-04 | P1 | App Nap、睡眠/唤醒和网络切换 | COMMON-P1-06 | 2–3 | 后台/唤醒无假连接；恢复或失败均在规定时间内完成 |
| VNC-MAC-P1-05 | P1 | macOS Screen Sharing 兼容性验证 | 引擎 ADR、安全实现 | 3–5 | 支持组合被自动化；不支持的 Apple 安全类型返回专用错误与说明 |

### 8.5 QA、安全与发布任务

| ID | 优先级 | 任务 | 依赖 | 估算 | 验收条件 |
| --- | --- | --- | --- | ---: | --- |
| VNC-QA-P0-01 | P0 | 建立可重复 VNC server fixtures | 无 | 4–6 | CI 可启动至少 TigerVNC 与协议故障 fixture；配置和凭据临时生成 |
| VNC-QA-P0-02 | P0 | Rust 协议 conformance integration suite | QA-P0-01 | 5–7 | 版本、认证、四种编码、resize、clipboard、断开场景自动化 |
| VNC-QA-P0-03 | P0 | malformed corpus、property test 与 fuzz target | COMMON-P0-05 | 4–6 | 长度、尺寸、zlib、CopyRect、clipboard corpus 无 panic/OOM；CI 有有界回归集 |
| VNC-QA-P0-04 | P0 | 三端 Tauri smoke gate | QA-P0-01 | 5–8 | Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView 均连接真实 fixture 并验证像素/输入 |
| VNC-QA-P0-05 | P0 | 安全回归套件 | COMMON-P0-03、P0-07 | 3–4 | downgrade、错证书、错 token、错 Origin、超大消息和日志脱敏均自动化 |
| VNC-QA-P1-01 | P1 | 多服务器兼容实验室 | P0 suite | 5–8 | TigerVNC、RealVNC、TightVNC、macOS Screen Sharing、GNOME/KDE/QEMU 按声明矩阵出报告 |
| VNC-QA-P1-02 | P1 | 1080p/Retina/4K 性能基准 | COMMON-P1-01 | 4–6 | 指标自动采集；达到第 5.5 节门槛；结果可比较并阻止显著回退 |
| VNC-QA-P1-03 | P1 | 8 小时/24 小时 soak 与故障注入 | P1 稳定 | 4–5 | 无持续内存/句柄增长；断网、丢包、server restart、sleep/wake 结果符合策略 |
| VNC-QA-P1-04 | P1 | 更新 qa-ui-auto F9.1/F9.6 用例和 feature-list | QA-P0-04 | 3–4 | TC-106/107 不再仅 scaffolding；功能声明与实际实现一致 |
| VNC-REL-P0-01 | P0 | 建立 VNC 发布 gate 和已知限制模板 | P0 测试 | 2–3 | 未达安全、三端 smoke、malformed、soak 门槛时 CI 阻止 release |
| VNC-OBS-P1-01 | P1 | 会话指标、诊断包和隐私审计 | COMMON-P0-02 | 4–6 | 可定位连接/性能阶段；导出不含密码、clipboard 内容或 token |

## 9. 测试与兼容性矩阵

### 9.1 服务端矩阵

| 服务端 | 用途 | 第一阶段 | 企业目标 |
| --- | --- | --- | --- |
| TigerVNC | 标准 RFB、VeNCrypt、编码基线 | 必测 | gate |
| RealVNC Server | RA2/RA2ne、ExtendedClipboard | 必测已支持路径 | gate |
| TightVNC | Tight 编码和 legacy 行为 | 基础互通 | Tight 完整 gate |
| macOS Screen Sharing | Apple 平台兼容 | 探测并记录 | 按支持声明 gate |
| GNOME Remote Desktop / Vino | Linux clipboard/legacy 行为 | 至少一项 | 按发行版 gate |
| KDE/Krfb | Linux 桌面互通 | 可选 | 承诺 KDE 时 gate |
| QEMU VNC | 虚拟机控制台常见场景 | 必测 | gate |
| 故障/恶意 fixture | 超时、截断、畸形、超限 | 必测 | gate |

商业服务器进入 CI 时需确认许可；无法自动部署的 RealVNC/macOS 项目放入受控 nightly 实验室，不以人工口头验证替代记录。

### 9.2 组合维度

- 协议：3.3、3.7、3.8。
- 安全：None 拒绝/显式允许、VNCAuth、RA2、RA2ne、VeNCrypt/TLS、证书错误、降级攻击。
- 编码：Raw、CopyRect、Hextile、ZRLE、Tight。
- 尺寸：800×600、1920×1080、2560×1600 Retina、3840×2160。
- 网络：低延迟、100 ms RTT、1% 丢包、限速、黑洞、半开、代理认证失败、SSH jump 中断。
- 生命周期：连接、认证失败、服务端关闭、手动关闭、detach/reattach、隐藏/显示、锁屏、睡眠/唤醒、网络切换、自动重连。
- 输入：US、AltGr 布局、数字键盘、左右修饰键、IME、dead key、粘贴、失焦释放。
- 剪贴板：ASCII、中文、emoji、大文本、HTML、RTF、禁用、单向、超限、恶意压缩内容。

### 9.3 画面自动断言

测试 server 输出确定性图案和 frame sequence，客户端截图后做像素级或容差内断言：

- 四角颜色验证 stride、endianness 和尺寸。
- 移动方块验证 CopyRect。
- tile 调色板验证 Hextile/ZRLE。
- resize 后新边界和点击坐标回显。
- 输入回显区验证 keysym、按下/释放和 pointer 坐标。
- clipboard 回显区验证方向和 Unicode。

浏览器 selector 自动化只能作为 UI wiring 检查，不能替代上述真实 Tauri + RFB 测试。

## 10. 生产发布门槛

所有 P0 完成后，仍需同时满足以下 gate：

### 10.1 安全

- 默认拒绝 None，不发生静默降级。
- 非加密连接有不可误解的状态提示和策略控制。
- relay 具有一次性鉴权、Origin 校验、消息上限和收紧 CSP。
- 密码、token、剪贴板 payload 不进入持久化前端存储和日志。
- malformed/fuzz 回归集无 panic、OOM、越界和无限循环。

### 10.2 稳定性

- 任一连接阶段均有 timeout；用户断开 2 秒内释放资源。
- 8 小时常规 soak 必过；候选发布执行 24 小时 soak。
- 快服务端/慢 WebView 下队列与 RSS 有界。
- resize、detach、sleep/wake、server restart 不产生僵尸会话。

### 10.3 功能与兼容

- 支持矩阵中的“必测”组合全部通过。
- 三端 release 包真实连接测试通过，不能以 dev server 或 Chromium 代替。
- 输入、文本剪贴板、resize、断开/重连均有端到端断言。
- feature-list、用户文档和 UI 声明与实际能力一致。

### 10.4 性能

- 达到第 5.5 节 1080p/4K 延迟和内存门槛。
- 关键交互无超过 2 秒的主线程冻结。
- 连续更新下不会因 WebSocket/Canvas 积压导致进程 OOM。
- 性能基准记录构建版本、平台、WebView、服务端、分辨率和网络条件。

### 10.5 可运维性

- 用户可导出脱敏诊断信息。
- 错误能定位到 DNS、代理、TCP、TLS、安全协商、认证、初始化、解码或 WebView。
- 连接成功可查看实际协议、安全、编码和尺寸。
- 已知限制和兼容矩阵随发布版本固化。

## 11. 分阶段计划与资源

### 阶段 0：范围冻结与引擎 ADR，1–2 周

- 冻结第一阶段 server/安全/平台矩阵。
- 完成 VNC-ADR-01 引擎选型 spike。
- 建立 TigerVNC/QEMU/故障 fixture。
- 确认三端 release 测试资源和商业服务器许可。

交付物：ADR、兼容矩阵 v1、fixture、基准数据。

### 阶段 1：P0 传输、安全和资源治理，3–4 周

- 异步 transport、deadline、状态机、结构化错误。
- 安全策略、VeNCrypt/TLS 最小路径。
- DecodeLimits、有界解压、有界 channel。
- relay 鉴权/CSP、凭据/日志整改。
- DesktopSize 同步或删除不实 SetDesktopSize 声明。

交付物：本文识别的 P0 安全/卡死/无界资源问题关闭，Rust conformance 与安全回归通过。

### 阶段 2：三端真实链路和发布 gate，3–4 周

- Windows WebView2、Linux WebKitGTK、macOS WKWebView release smoke。
- 文本剪贴板、基础键盘、DPI/Retina、生命周期测试。
- qa-ui-auto 从 scaffold 升级为真实 fixture 用例。
- 8 小时 soak 和发布 gate。

交付物：可限定矩阵发布的受控局域网生产候选。

### 阶段 3：P1 性能、平台体验和网络能力，4–6 周

- frame batching/backpressure、4K 优化。
- 输入/IME、原生剪贴板适配。
- proxy/SSH jump、自动重连、QuickConnect。
- Tight/JPEG 或选定成熟引擎集成。
- 多服务器实验室和 24 小时 soak。

交付物：面向更广泛服务器和企业网络的生产版本。

建议人员配置：

| 角色 | 投入 |
| --- | --- |
| Rust/协议工程师 | 1–2 人，负责 transport、security、decoder、relay |
| 前端/Tauri 工程师 | 1 人，负责 session UI、renderer、输入和三端 WebView |
| 平台工程师 | 0.5–1 人，负责 native clipboard、DPI/IME、签名包 |
| QA/自动化 | 1 人，负责 fixture、三端 lab、性能与 soak |
| 安全 review | 阶段 1 和发布前各一次 |

任务表中的平台 P0 smoke 是 VNC-QA-P0-04 的分端实施项，平台兼容验证也与 QA 矩阵部分重叠，汇总排期时不得重复相加。在此口径下：

- 三端、已知服务器、受控局域网生产范围约 12–18 工程师周，建议团队的日历周期约 7–10 周。
- 广泛企业兼容在前述基础上还需约 4–6 人月，总投入约 7–10 人月，团队日历周期约 11–16 周。

实际时间取决于三端机器、商业 VNC server、签名/公证环境和网络 fixture 是否可并行使用。协议或安全 spike 若否定当前引擎路线，应在 ADR 后重估，不能沿用本表估算。

## 12. 引擎选型 ADR

当前自研引擎代码量可控，已经完成核心编码和 RealVNC RA2/RA2ne 认证流程，短期 P0 加固比立即重写风险低。但广泛兼容意味着继续实现 VeNCrypt、Tight、厂商差异、fuzz 和长期维护，不能默认自研一定更省成本。

创建 VNC-ADR-01，限时 5–8 工程师日比较：

| 方案 | 优点 | 主要风险 |
| --- | --- | --- |
| 加固当前 Rust 引擎 | 与现有 relay/UI 契合；Rust 内存安全；改动可渐进 | 协议兼容和安全扩展维护成本高 |
| libvncclient | 成熟、多编码和多服务器兼容积累 | C FFI、安全边界、三端编译/签名、线程和回调集成成本 |
| noVNC protocol core | Web/VNC 生态成熟，WebSocket 模式自然 | 需要评估前端协议层、WebView 性能、代理边界和现有 Rust 逻辑迁移 |

统一用同一批 fixtures 比较：

- 连接成功率和协议覆盖。
- 1080p/4K CPU、内存、带宽、输入延迟。
- 取消/超时/重连可控性。
- malformed 输入安全性和 fuzz 可行性。
- Windows/Linux/macOS 构建、签名、包体和许可证。
- 接入现有 vault、proxy/SSH jump、clipboard、diagnostics 的工作量。

决策建议：

- 若第一阶段只承诺已知服务器和受控内网，继续加固当前 Rust 引擎。
- 若产品在首个生产版就要求广泛 Tight/VeNCrypt/厂商扩展兼容，应优先评估成熟引擎，不要把所有协议补齐工作隐含进普通 bugfix 排期。
- 无论选择哪种引擎，session state、security policy、resource limits、relay 鉴权、平台适配和真实三端测试仍然必须建设。

## 13. 完成定义

VNC client 只有同时满足以下条件，才可标记为“三端生产可用”：

1. 支持范围和非目标公开、准确，实际能力与 feature-list 一致。
2. 默认安全策略不静默降级，凭据和剪贴板内容不泄露。
3. 所有网络和协议阶段可超时、可取消、可诊断。
4. 服务端控制的输入、解压和队列全部有界。
5. Windows WebView2、Linux WebKitGTK、macOS WKWebView 的 release 包均通过真实 VNC E2E。
6. 目标 server/security/encoding/resize/input/clipboard 组合有自动化或受控实验室记录。
7. 1080p/4K、8/24 小时 soak、断网、休眠和慢消费者测试达到门槛。
8. 发布 gate 能阻止安全、兼容、性能和长稳回退。

在这些条件完成前，合理的产品标签是“VNC Beta（受控网络与已验证服务器）”，而不是无条件的生产级 VNC client。
