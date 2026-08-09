# VNC Client Linux 生产化实施与验证报告

## 1. 文档信息

- 日期：2026-08-09
- 环境：Linux Mint 22.3（Ubuntu 24.04 noble 基线）、X11、WebKitGTK 2.52.3、QEMU 10.2.0
- 依据：`claudedocs/vnc-client-production-readiness-plan.md`
- 范围：Linux 客户端及其共享 RFB/relay/frontend 链路

## 2. 发布结论

当前实现已达到“受控网络与已验证服务器范围内的 Linux VNC 生产候选”所需的主要代码质量：默认安全策略、超时和资源上限、relay 鉴权、有界背压、真实 rendered ACK、输入释放、剪贴板策略、网络路由、有限自动重连、凭据隔离及 QEMU 真实 RFB 互通均已实现并有自动测试。

当前仍不得标记为“无条件生产级 VNC client”，推荐产品标签保持为：

> VNC Beta：支持可信内网或 SSH tunnel 下的 RFB 3.3/3.7/3.8，VNCAuth、RA2/RA2ne，Raw/CopyRect/Hextile/ZRLE，以及显式允许的 None。

以下项目仍是扩大生产声明前的阻断项：

1. 尚未实现 VeNCrypt/TLS、系统信任链/主机名验证、私有 CA 和证书固定。因此 `require-encryption` 仅接受可保持加密的 RA2，不能连接只提供 VeNCrypt 的 TigerVNC 配置。
2. 尚未支持 Tight/JPEG，不能声明完整 TightVNC 或高带宽效率场景兼容。
3. Linux release deb/AppImage 的 GNOME Wayland/X11 真机输入法、selection owner、GPU/软件渲染、锁屏/休眠/网络切换以及长稳测试仍需受控实验室记录。
4. 当前环境能完成 QEMU RFB 协议验证，但不能用 Chromium 或 Rust 协议测试替代 Linux WebKitGTK release 包的真实像素、输入和系统剪贴板 E2E。

## 3. 已完成设计与实现

### 3.1 连接、超时和生命周期

- direct、HTTP CONNECT、SOCKS5、SSH jump 与连接测试复用同一网络解析和凭据解析路径。
- DNS/TCP 建连有 deadline；RFB 握手、稳态读写均配置超时。
- 同步 RFB I/O 只在 blocking worker 中执行，取消最长受稳态读超时约束。
- relay 只监听动态 loopback 端口；30 秒内未接入或 WebView 30 秒无心跳会回收。
- session reaper 在 relay 结束后删除状态；手动断开会同时发送控制消息并取消任务。
- 每次前端连接使用 generation 隔离。旧 `vncConnect` 结果及旧 WebSocket 的 open/message/error/close 回调不能覆盖重连后的新状态。
- 自动重连仅对可重试网络错误生效，使用 500 ms 起步、10 秒封顶的指数退避和 20% 抖动；认证、安全策略、无效配置和 capability 错误不重试，次数限制为 0-10。

### 3.2 安全策略

- `legacy-compatible` 为默认，只允许有认证的传统路径，不再隐式选择 None。
- `allow-none` 是连接 None 的唯一显式入口。
- `prefer-encryption` 按 RA2-256、RA2-128、RA2ne、VNCAuth 的强度顺序选择。
- `require-encryption` 只接受会话传输保持加密的 RA2，不向 VNCAuth/RA2ne/None 降级。
- fake server 回归覆盖默认拒绝 None、显式 allow-none、None + VNCAuth 时选择 VNCAuth，以及 shared/exclusive `ClientInit`。
- 成功连接显示实际 RFB 版本、安全类型、加密状态、尺寸和 view-only 状态。
- WebSocket relay 使用 256-bit 随机一次性子协议 token，校验 Tauri Origin，只接受首个授权客户端。
- WebSocket 入站 message/frame 上限为剪贴板硬上限加 JSON 余量；控制队列溢出 fail closed，不阻塞 Tokio worker。
- Tauri CSP 不再为空；动态 WebSocket 仅允许 loopback，禁用 object、base、form 和 frame ancestor。

### 3.3 凭据和隐私

- detach/reattach 不向 `localStorage` 写入 VNC password 或 vault ref。
- Rust 进程内 capability 使用 256-bit 随机 token、24 小时滑动 TTL、128 条容量限制和最旧项淘汰。
- capability 可在有效期内重复使用，过期或未知 token 明确拒绝；被淘汰凭据通过 `Zeroizing<String>` 清理。
- 日志只记录剪贴板方向、格式和长度，不记录 payload、preview、password 或 relay token。

### 3.4 解码与恶意输入边界

- framebuffer 单边最大 16384 px，总 RGBA 最大 256 MiB。
- server name/failure reason 最大 64 KiB，单次 rectangle 最大 4096 个。
- rectangle、CopyRect、Raw/Hextile/ZRLE 尺寸和算术使用边界/checked 校验。
- ZRLE 压缩输入、解压输出、zlib 无进展和跨 rectangle 持久流均有确定性测试。
- legacy/ExtendedClipboard 输入、解压和单格式输出最大 16 MiB，负长度处理防止 `i32::MIN` 溢出。
- 未请求或不支持的 encoding 会关闭当前会话，不尝试跳过未知长度造成协议失步。

### 3.5 帧流水线与性能保护

- 一次 FramebufferUpdate 作为带递增 `frame_id` 的逻辑帧批次传送。
- rectangle header 带 `frame_id`，帧结束标记带同一 id；前端完成 `putImageData` 后返回 rendered ACK。
- 后端只在有效、未重复的已交付 frame id ACK 后请求下一次增量更新。
- 画面 mailbox 只保留最新逻辑帧；控制消息具有独立的 256 项上限和更高优先级。
- 单逻辑帧最大 64 MiB。超限或被新帧替换后仍发送帧结束标记，收到 ACK 后强制 non-incremental 全量恢复，避免永久停帧或画面状态缺口。
- pointer move 在不改变按钮状态时合并；key/button 不按 move 规则丢弃。
- 隐藏 tab 暂缓绘制及 ACK，防止后台 tab 持续挤占主线程；重新可见后完成当前帧并恢复拉取。

### 3.6 resize、显示和输入

- DesktopSize 先在 Rust 端校验并原子替换权威 framebuffer，再发送包含相同 frame id 的 resize 消息。
- 前端清空旧尺寸待绘制 rectangle，同步 store/canvas 后再绘制新帧；远端坐标始终使用 RFB framebuffer 尺寸。
- 未实现 client SetDesktopSize，功能清单和 UI 不再把本地 fit/1:1 误称为远端 resize。
- 键盘映射覆盖左右 Ctrl/Alt/Shift/Meta、AltGr、F1-F24、导航键、锁定键、数字键盘和 Unicode keysym。
- blur、visibilitychange、隐藏、detach 和 effect cleanup 会释放全部已按下键和鼠标按钮。
- view-only 在 React 事件层和 Rust relay 两层阻止 key/pointer 控制。

### 3.7 Linux 剪贴板

- 支持 `disabled`、`client-to-server`、`server-to-client`、`bidirectional` 四种策略，后端强制执行。
- 默认文本双向；HTML/RTF 必须显式开启且受格式大小限制。
- Tauri native command 使用 arboard 作为主后端；Linux 读路径可回落 `wl-paste`、`xclip`、`xsel`，Wayland 写路径可使用 `wl-copy`。
- 前端 Web Clipboard API 只作为焦点/selection owner 场景的能力路径和 fallback。
- 收到的 HTML/RTF 只写系统剪贴板，不插入 DOM。
- capability probe 报告 display backend、WebKit API 预期和各 native helper 可用性，避免按 UA 猜测。

### 3.8 配置和路由

- Session Editor 可配置 security、shared、view-only、剪贴板方向、HTML/RTF、1/4/16 MiB 限制、自动重连及次数。
- 保存会话、QuickConnect `vnc://`、detach window 均复用 VNC panel 和后端连接链路。
- TC-106/TC-107 已从 passive scaffolding 更新为 production policy/session wiring 测试。

## 4. Linux 支持基线

| 项目 | 发布基线 | 本机结果 |
| --- | --- | --- |
| 发行版 | Ubuntu 24.04 LTS 或同 ABI 系（首批）；Ubuntu 22.04/Fedora 需单独 gate | Linux Mint 22.3 / noble |
| WebKitGTK | `webkit2gtk-4.1`，最低 2.44；每个 release 记录实际版本 | 2.52.3 |
| GTK | GTK 3 runtime | 已安装 |
| Display | GNOME X11 与 GNOME Wayland 均为目标 gate | 当前为 X11 `DISPLAY=:0` |
| 图形 | GPU 与 `LIBGL_ALWAYS_SOFTWARE=1` 两条路径 | Intel HD 530 / Mesa 25.2.8 GPU 路径可用 |
| Clipboard | arboard；Wayland 推荐 wl-clipboard，X11 可选 xclip/xsel fallback | 当前只有 arboard，helper 未安装 |
| VNC fixture | QEMU 必测；TigerVNC/GNOME/RealVNC 按声明矩阵 | QEMU 10.2.0 已通过 |

WebKitGTK 低于 2.44、非 `webkit2gtk-4.1` runtime、KDE Wayland 和非 glibc 发行版不在当前发布声明内，必须先进入兼容实验室。

## 5. 自动验证矩阵

| 验证 | 覆盖 | 当前状态 |
| --- | --- | --- |
| `pnpm test` | React、store、配置、键盘/wire helper、QuickConnect | 通过：235 files / 2000 tests |
| `pnpm build` | TypeScript strict + production frontend bundle + CSP 处理 | 通过：Vite production bundle |
| `pnpm tauri build --debug --no-bundle` | Linux Tauri debug 编译、Rust 链接和前端资源集成 | 通过：`src-tauri/target/debug/taomni` |
| `pnpm tauri build --debug --bundles deb --no-sign` | Linux Mint 可安装 deb 产物、依赖声明和 bundle preflight | 通过：`src-tauri/target/debug/bundle/deb/Taomni_0.4.13_amd64.deb` |
| `cargo test --lib` | Rust 全量单元测试 | 通过：1188 passed / 19 ignored |
| `cargo test --test integration` | 后端统一集成测试 | 通过：57 passed |
| VNC 定向 suite | 安全、RFB、编码、剪贴板、relay、队列、capability | 通过：38 passed / 1 ignored（外部 QEMU fixture） |
| QEMU 真实 fixture | RFB 协商、ServerInit、像素格式、真实 framebuffer rectangle | 通过：ignored test 显式启用后 1/1，QEMU 10.2.0 |
| qa-ui-auto lint/catalog/audit | F9.1/F9.6 声明、selector 和用例健康度 | 通过：130 cases、0 lint errors、catalog up to date、F9.1/F9.6 无 actionable gaps |
| TC-106 / TC-107 browser | production 配置、保存会话、认证/panel 路由 | 通过：2/2 |
| TC-117 Linux WebKitGTK native smoke | 构建后的 Tauri WebView 启动、CSP、基础页面 | 通过：GPU 与 `LIBGL_ALWAYS_SOFTWARE=1` 各 1/1 |

说明：不带 `--bundles` 的多格式 debug 打包在本机进入 RPM/AppImage 打包阶段后无继续输出，已停止该任务；Linux Mint 发布路径使用显式 `--bundles deb --no-sign` 重跑并成功。`--no-sign` 只用于本地验证，正式发布仍需注入受保护的 Tauri updater 私钥。

QA gate 备注：F9.1/F9.6 feature-focused audit、lint 和 catalog freshness 均通过；全局 `audit --gate`/`control_coverage --gate` 对当前工作树返回非零，是因为同一未提交工作树还包含邮件、主题、Ribbon 等非 VNC 特性，导致基线中的全局 shallow/orphan/coverage 漂移。未修改 coverage baseline 以掩盖这些无关回归。

## 6. 必须人工真机验证的 case

以下 case 依赖桌面、硬件、输入法、窗口管理器或长时间外部状态，不能由当前 browser/Rust fixture 诚实替代：

1. GNOME Wayland 与 GNOME X11：CLIPBOARD/PRIMARY owner 变化、中文/emoji/HTML/RTF 双向复制、应用退出后的 owner 生命周期。
2. ibus 与 fcitx5：中文/日文 IME、AltGr 布局、Compose/dead key、workspace 切换和失焦后无卡键。
3. GPU 与软件 Canvas：1080p/4K 输入到可见反馈 p95、CPU、RSS、连续滚动 10 分钟和 50 次 resize。
4. 窗口隐藏、最小化、锁屏、suspend/resume、NetworkManager 断网/切网、server restart 后状态与有限重连。
5. deb/AppImage 实际交付包：WebKitGTK 依赖、loopback CSP、系统 CA、代理、SSH tunnel、安装/升级/卸载。
6. 8 小时常规 soak 与候选发布 24 小时 soak；必须保存构建版本、WebKitGTK、server、分辨率、RSS/CPU/句柄曲线和最终关闭原因。
7. TigerVNC、RealVNC、GNOME Remote Desktop/Vino 的受控互通；商业软件结果需记录版本和许可条件。

## 7. 未完成任务与后续优先级

| 优先级 | 任务 | 完成条件 |
| --- | --- | --- |
| P0 | VeNCrypt/X509 TLS | TigerVNC fixture 加密连接；系统 CA/主机名校验；错证书不降级；私有 CA/指纹策略明确 |
| P0 | Linux release 真机 gate | deb/AppImage 在 WebKitGTK X11/Wayland 完成像素、输入、文本剪贴板、resize、断开 E2E |
| P0 | malformed/fuzz gate | 长度、zlib、encoding、clipboard corpus 进入 CI；有界 fuzz 无 panic/OOM/死循环 |
| P1 | Tight/JPEG 或成熟引擎 | Tight 基础模式、JPEG、bounds 和目标服务器 fixture 通过 |
| P1 | 结构化全阶段诊断 | DNS/proxy/SSH/TCP/TLS/RFB/auth/init/runtime 使用稳定 code/stage，不依赖前端字符串分类 |
| P1 | Linux 性能/长稳 | 1080p/4K、软件/GPU、8/24 小时 soak 达到原计划门槛 |
| P1 | 平台输入/剪贴板矩阵 | ibus/fcitx5、Wayland/X11、HTML/RTF 降级和 owner 生命周期有版本化报告 |

在这些任务完成前，发布说明必须保留第 2 节的范围限制，不能只依据自动单测通过删除 Beta 标记。
