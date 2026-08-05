# Local RDP Server 完善计划

> 范围：`src-tauri/src/servers/rdp/` + 前端 `RdpSettings`  
> 定位：内网/受控环境的本机桌面共享（mstsc / FreeRDP 客户端），**不是** Windows RDS / TeamViewer 替代  
> 制定日期：2026-07-19  
> 决策基线：当前实现、本文的平台裁决，以及根目录 `DESIGN.md`。
> 状态索引：根目录 `IMPLEMENTATION_PLAN.md`；本文件只维护 RDP 专项任务和验收边界。
> 栈：ironrdp-server 0.10、enigo、arboard、rcgen；Linux X11 捕获已实装

---

## 1. 一句话现状

**Linux X11 全链路可用**（连接 → 真桌面 → 键鼠 → 文本剪贴板 → TLS/NLA）。  
**Linux X11 全链路可用**；**macOS 已接 xcap 真桌面采集**（需屏幕录制权限）；**Linux 纯 Wayland** 走 xcap 门户回退。  
**Windows 捕获仍为占位**（本分支按产品优先级暂缓 DXGI）。输入/剪贴板/TLS 跨平台。

---

## 2. 平台裁决（沿用 dev plan，不可推翻）

| 能力 | Windows | Linux | macOS |
|------|---------|-------|-------|
| Console 桌面镜像 | 目标支持 | ✅ 已支持 (X11) | 目标支持 |
| 多用户独立会话 | ⛔ 客户端 SKU 不做 | 进阶可选 (xrdp 模型) | ⛔ 单 GUI 会话 |
| 登录屏 / UAC / greeter | 仅重投入 SYSTEM 服务时 | 虚拟会话可规避 | ⛔ |
| 无头 | ⛔ 不做 IddCx | 与独立会话同一机制 | ⛔ |

**产品口径**：  
- 「完整」= 三端 **console 镜像** 可用（捕获 + 输入 + 剪贴板文本 + NLA）。  
- Linux 进阶会话是加分项，不阻塞 Win/mac 主路径。

---

## 3. 现状盘点（摘要）

### 3.1 已完成 ✅

| 模块 | 状态 |
|------|------|
| 生命周期 / 取消桥接 / 预绑定 | ✅ |
| TLS 自签 + hybrid NLA / tls / none | ✅ |
| 强制凭据（除 none） | ✅ |
| Linux X11 捕获（SHM + Damage 脏区） | ✅ 实测 |
| 显示管线 + 合成占位回退 | ✅ |
| 输入 enigo actor（跨平台 Send） | ✅ 结构；Linux 实测 |
| 剪贴板文本 CLIPRDR | ✅ |
| 前端：用户名/密码/域/安全模式/viewOnly | ✅ |
| Local servers 独立窗口 | ✅ |

### 3.2 关键缺口

| 优先级 | 缺口 | 平台 |
|--------|------|------|
| **P0** | Windows 屏幕捕获（DXGI/WGC） | Win — **本分支暂缓** |
| **P0** | ~~macOS 屏幕捕获~~ | macOS — ✅ `xcap` |
| **P0** | ~~捕获失败 UI/日志明确~~ | 全平台 — ✅ R0 |
| **P1** | ~~macOS 键盘 scancode 表补全~~ | macOS — ✅ 扩展映射 |
| **P1** | Windows 输入运行时回归 | Win — 暂缓 |
| **P1** | ~~Linux 纯 Wayland 捕获~~ | Linux — ✅ xcap 门户回退 |
| **P1** | 硬件光标下发（X11 xfixes → RGBAPointer） | 仍待做 |
| **P2** | ~~`Synchronize` 锁定键~~ | ✅ 尽力脉冲 Caps/Num/Scroll |
| **P2** | 客户端 resize / 多显示器 | 全平台 |
| **P2** | 连接失败/权限引导（macOS 录屏权限、Win 高 DPI） | Win/mac |
| **P3** | Linux sesman 独立会话 + 无头（T-11） | Linux |
| **P3** | 音频 rdpsnd | 按需 |
| **P3** | 剪贴板图片/文件 | 明确可继续不做 |
| ⛔ | Win/mac 多会话、无头、mac 登录屏 | — |

---

## 4. 分阶段计划

### Phase R0 — 可观测性与产品诚实（约 0.5 人日）

**目标**：用户立刻知道当前平台能不能看桌面。

| 任务 ID | 内容 | 状态 |
|---------|------|------|
| R0-1 | 启动时 `create_capturer` 探测 + capability summary 日志 | ✅ |
| R0-2 | 前端 `RdpSettings` 按平台 i18n 能力说明 | ✅ |
| R0-3 | 占位帧改为高对比棋盘 + 移动色条 | ✅ |
| R0-4 | 本计划文档状态同步 | ✅ |

**依赖**：无  
**风险**：低

---

### Phase R1 — Windows 真桌面（约 3–6 人日） ⭐ 最高 ROI

**目标**：Windows 上 mstsc 看到并操控本机桌面。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| R1-1 | 新增 `capture/win.rs`：优先 **DXGI Desktop Duplication**（或 WGC）；输出 BGRA `Frame` | `create_capturer` Ok，分辨率正确 |
| R1-2 | 接入 `capture/mod.rs`；处理显示器拓扑变化（重枚举/重建） | 拔插显示器不永久黑屏 |
| R1-3 | 脏区：有 Desktop Duplication move/dirty rects 则用；否则全屏 + `diff` 瓦片裁剪 | CPU 空闲明显低于盲刷 |
| R1-4 | 权限/会话：当前用户 console 会话即可；文档说明「需已登录桌面」 | 锁屏是否可见按能力文档说明（不强制 R1 做锁屏） |
| R1-5 | 输入回归：键鼠、滚轮、扩展键；多显示器坐标与主屏 origin | mstsc 可点可选 |
| R1-6 | 手测清单：Win10/11 + mstsc + FreeRDP | 录屏或检查表勾选 |

**技术要点**：

- 捕获线程 `!Send` 约束与现有 display 线程模型对齐。  
- 避免引入 AGPL 依赖；可参考公开 DXGI 示例与 RustDesk 架构思路，不 vendor 其源码。  
- 与 LanChat 屏幕共享复用 `Capturer` trait 的路径保持兼容（`pub(crate) mod capture`）。

**依赖**：R0 建议并行  
**风险**：高（DXGI 设备丢失、全屏独占游戏、混合 DPI）

---

### Phase R2 — macOS 真桌面（约 3–6 人日）

**目标**：macOS 上 FreeRDP/微软客户端看到并操控桌面。

| 任务 ID | 内容 | 状态 |
|---------|------|------|
| R2-1 | `capture/mac.rs` + `xcap_backend`（CGDisplay 路径） | ✅ |
| R2-2 | 捕获失败错误文案引导 Screen Recording | ✅ |
| R2-3 | Retina：xcap 返回物理像素；坐标依赖 enigo（手测） | ⚠️ 手测 |
| R2-4 | 扩展 scancode→CGKeyCode + E0 方向键 | ✅ |
| R2-5 | enigo 初始化失败 view-only 日志（既有） | ✅ |
| R2-6 | 手测 macOS + FreeRDP | 待本机 |

**依赖**：R0  
**风险**：高（权限、Retina、SCK API 演进）

---

### Phase R3 — Linux 补强（约 2–4 人日）

**目标**：Wayland 主机可用；X11 体验打磨。

| 任务 ID | 内容 | 状态 |
|---------|------|------|
| R3-1 | Wayland：X11 失败后 `xcap` 门户回退 | ✅ |
| R3-2 | X11 硬件光标 → RGBAPointer | ⬜ 未做 |
| R3-3 | 多显示器：xcap/X11 先主屏 | ✅ 主屏 |
| R3-4 | 锁定键 `Synchronize` 尽力脉冲 | ✅ |

**依赖**：R1/R2 不阻塞；可与 R1 并行由不同人做  
**风险**：中–高（PipeWire 构建依赖、portal 用户授权）

---

### Phase R4 — 协议与体验打磨（约 1–3 人日）

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| R4-1 | 客户端 resize 协商（若 ironrdp-server 支持） | 改窗口不全花屏 |
| R4-2 | 连接指标：fps、带宽粗估打到日志（调试开关） | 性能问题可诊断 |
| R4-3 | 剪贴板图片（可选） | 按需；默认可不做 |
| R4-4 | 公网加固子集：失败认证节流、绑定非 0.0.0.0 推荐 | 与 plan §10 对齐 |
| R4-5 | 自签证书指纹展示到 UI | 客户端信任可对照 |

---

### Phase R5 — Linux 进阶 sesman（可选，约 5–10 人日）

> 对应 feature task **T-11** / dev plan §7+§9。一步同时拿下独立会话、规避锁屏隔离、无头。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| R5-1 | PAM 认证（或限制为仅当前用户 + 本地密码） | 策略文档清晰 |
| R5-2 | 每连接 fork Xvfb/Xorg-dummy/Weston headless | `probe()` 已具备前置检测 |
| R5-3 | 捕获/输入绑定到该 `DISPLAY`；断线回收 | 两客户端两桌面互不影响 |
| R5-4 | 前端 `headlessSession` 真正生效，去掉「仍镜像 console」话术 | 行为与日志一致 |

**仅 Linux**；Win/mac 保持 ⛔。  
**依赖**：R3 稳定后  
**风险**：很高（会话生命周期、权限、桌面环境差异）

---

### Phase R6 — 明确不做清单（写入产品说明）

| 项 | 原因 |
|----|------|
| Windows 无头（IddCx） | 驱动级投入 |
| Windows 客户端 SKU 多会话 | EULA / termsrv |
| macOS 登录窗口完整支持 | 无干净 API |
| 对标 AnyDesk 免配置公网 | 安全与产品范围 |
| 完整 RDS 许可功能 | 非目标 |

---

## 5. 「三端较完整」完成定义

同时满足：

1. **R1 + R2 完成**：Win / macOS / Linux(X11) 均可真实桌面镜像 + 键鼠 + 文本剪贴板 + NLA。  
2. **R0 完成**：能力与限制在 UI 可见。  
3. 手测矩阵通过（见 §6）。  
4. Wayland / sesman / 音频 **不作为**「较完整」门槛。

---

## 6. 手测矩阵

| 场景 | Windows | macOS | Linux X11 | Linux Wayland |
|------|:-------:|:-----:|:---------:|:-------------:|
| hybrid NLA 连接 | R1 后 | R2 后 | ✅ 现有 | R3 后 |
| 看到真实桌面 | R1 | R2 | ✅ | R3 |
| 鼠标点击准确 | R1 | R2 (Retina) | ✅ | R3 |
| 键盘（含方向/修饰） | R1 | R2 | ✅ | R3 |
| 剪贴板文本双向 | 现有 | 现有 | ✅ | 现有 |
| viewOnly | 现有 | 现有 | ✅ | 现有 |
| 启停 / autostop | 现有 | 现有 | ✅ | 现有 |

客户端建议：Windows `mstsc`；跨平台 FreeRDP。

---

## 7. 建议路线与工期（粗估）

```
R0 可观测性 ──┬── R1 Windows 捕获 ⭐ ──→  Win 可用
              ├── R2 macOS 捕获 ⭐ ────→  mac 可用  →  「三端较完整」
              └── R3 Wayland + 光标 ──→  Linux 增强
                         │
                         ▼
                    R4 体验打磨
                         │
                         ▼
                    R5 sesman（仅 Linux，按需）
```

| 里程碑 | 含阶段 | 粗估 |
|--------|--------|------|
| M1 诚实可用 | R0 | ≤1 天 |
| M2 Windows 可用 | R0+R1 | 1–1.5 周 |
| M3 三端 console 完整 | M2+R2 | 再 1–1.5 周 |
| M4 Linux 现代桌面 | R3 | +0.5–1 周 |
| M5 进阶会话 | R5 | 按需 1–2 周+ |

---

## 8. 关键文件

| 路径 | 角色 |
|------|------|
| `src-tauri/src/servers/rdp.rs` | 入口 / 安全模式 / 生命周期 |
| `src-tauri/src/servers/rdp/capture/` | 捕获后端（macOS、X11、Wayland 已有实现；Windows 原生后端待增） |
| `src-tauri/src/servers/rdp/display.rs` | 帧下发 |
| `src-tauri/src/servers/rdp/input.rs` | 键鼠 |
| `src-tauri/src/servers/rdp/clipboard.rs` | 剪贴板 |
| `src-tauri/src/servers/rdp/session.rs` | Linux 进阶探测 |
| `src-tauri/src/servers/rdp/tls.rs` / `auth.rs` | 证书与凭据 |
| `src/components/servers/settings/RdpSettings.tsx` | 表单 + 能力说明 |
| `DESIGN.md` | 仓库级架构与跨平台安全约束 |
| `IMPLEMENTATION_PLAN.md` | 当前工作流与交付状态索引 |

---

## 9. 与 SSH 计划的边界

- RDP 只做桌面共享；Shell/SFTP 见 `local-ssh-server-plan.md`。  
- 共享：Local servers 窗口、配置库、`ServerRegistry`、事件通道。  
- 捕获模块可能被 LanChat 屏幕共享复用——改 trait 时保持 `pub(crate)` 契约。

---

## 10. 实施原则

1. **先打通 Win/mac 捕获，再谈进阶**——否则「三端」口号不成立。  
2. **失败可见**：永不静默黑屏；占位 + 日志 + UI 提示三件套。  
3. **不破坏 Linux X11 已达标路径**：新后端热插，默认探测顺序保持 X11 优先。  
4. **平台裁决写进 UI/文档**，避免用户期待 mac 无头或多会话。  
5. 大功能（R1/R2/R5）各自独立 PR，便于回滚与评审。
