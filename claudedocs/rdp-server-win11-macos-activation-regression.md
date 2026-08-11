# Win11 mstsc -> macOS RDP Server 激活后断开分析

## 现象与范围

- Windows 11 使用 `mstsc` 连接 macOS 上 Taomni Local Server 启动的 RDP Server。
- NLA/TLS 已经走到本机控制确认弹窗；点击允许后，客户端立即报错并断开，桌面尚未显示。
- 本轮开发环境为 Linux，只进行代码分析、自动化验证和兼容策略修复；macOS/Win11 真机互操作保留为发布待办。

## 静态分析结论

### 1. 控制审批阻塞了 RDP 激活线程（高置信度）

IronRDP 会在连接激活期间回放客户端已经发送的初始输入事件。原实现从该同步输入回调进入 `ControlGate::ensure_approved`，并在 RDP Server 的单线程 Tokio runtime 上通过 `recv_timeout` 最多等待 30 秒。

因此审批弹窗等待并不只是“禁止输入”，而是暂停了整个连接 reactor：后续通道启动、显示 encoder 创建、首帧发送和 socket 读取都无法继续。点击允许后才恢复处理；此时 `mstsc` 可能已经耗尽激活超时或关闭连接，于是表现为“确认后立刻断开”。

修复后，第一次输入只注册审批并启动独立 waiter，随后立即返回。审批期间继续丢弃输入，但协议激活和桌面显示不再等待审批；只有同一连接的 request id 被明确批准后，后续输入才允许注入。

### 2. 已知不稳定的 EGFX/AVC420 被重新设为默认（高置信度）

提交 `840ab99` 曾因 Win11 兼容问题把 AVC420 改为 `TAOMNI_RDP_EXPERIMENTAL_AVC420=1` 显式开启；提交 `3fd3718` 又无条件向 macOS RDP Server 挂载 EGFX factory。这样 `mstsc` 会在首屏阶段进入 VideoToolbox H.264 路径。

当前 ACK/`totalFramesDecoded` 检测只能在客户端继续保持连接时，于 1.5 秒停滞后回退 bitmap。若客户端因首个 EGFX/AVC payload 或 surface 状态直接判定协议错误并断开，运行时回退来不及生效。提交 `ffdaf0b` 修正了 NAL 长度前缀，但在没有真实 Win11 互操作结果前，不能据此把整条 AVC420 链路视为发布默认值。

修复后 macOS 默认不挂载 EGFX channel，使用 bitmap 兼容路径；AVC420 实现继续保留，只有设置 `TAOMNI_RDP_EXPERIMENTAL_AVC420=1` 才参与协商。

### 3. 初始客户端尺寸缩放扩大了激活失败面（中置信度）

提交 `3fd3718` 新增“采用客户端请求尺寸”的初始协商，并在激活阶段调用 `SCStream::updateConfiguration`。builder 文档本身要求 display 必须成功采用该尺寸，否则已协商桌面尺寸与实际 framebuffer 尺寸不一致，客户端可能断开；当前 resize 是有超时且可失败的系统调用，因此不满足无条件成功的前提。

修复后默认继续使用服务端捕获尺寸，避免在初始激活路径重配 ScreenCaptureKit。该优化可用 `TAOMNI_RDP_EXPERIMENTAL_CLIENT_SIZE=1` 单独开启并做 A/B 真机验证。

## 代码侧修复

- 控制审批改为非阻塞 waiter，只门控输入，不阻塞连接 reactor。
- macOS 默认恢复 bitmap 图形兼容路径。
- macOS 默认恢复服务端捕获尺寸协商路径。
- 保留 ScreenCaptureKit 预热、latest-frame mailbox、静态桌面首帧重放、Retina/副屏输入映射等与协议激活无冲突的优化。
- 断开日志使用完整 `anyhow` 错误链，真机复测可看到失败阶段和底层原因。

## macOS + Win11 真机待办

基础通过条件：默认环境下，确认弹窗停留 1 秒、10 秒和 25 秒后分别允许，`mstsc` 都能进入桌面；审批前能看到桌面但不能控制，审批后键鼠生效。

验证矩阵：

| AVC420 | 客户端尺寸 | 目的 | 预期 |
|---|---|---|---|
| 关闭（默认） | 关闭（默认） | 发布兼容基线 | 必须稳定连接并显示桌面 |
| 开启 | 关闭 | 隔离 EGFX/AVC420 | 记录是否在首个 AVC 帧后断开 |
| 关闭 | 开启 | 隔离 ScreenCaptureKit resize | 记录请求尺寸、resize 结果和首帧尺寸 |
| 开启 | 开启 | 完整优化路径 | 仅前两项分别通过后测试 |

每次保存 Taomni Local Server 日志、Windows 客户端错误码、macOS/Windows 版本、显示器逻辑/物理尺寸和环境变量。至少覆盖首次连接、断开重连、审批拒绝、审批超时和静态桌面。

在默认基线通过且两个实验开关分别完成 Win11 `mstsc`、FreeRDP 和 macOS Microsoft Remote Desktop 互操作前，不应把实验路径恢复为默认。
