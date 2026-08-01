# SocksCap macOS：mitmproxy Redirector Transparent-Only 方案

> 状态：P0–P2 代码切片已落地；真实双架构故障注入、selected/unselected 与 soak gate 尚待执行
>
> 日期：2026-08-01
>
> 适用范围：macOS SocksCap 全局捕获、application 捕获、IPC bridge、生命周期、发布与恢复
>
> 取代：本文旧版“Taomni 自建 `NETransparentProxyProvider`”方案，以及 Phase 6 中的 system-proxy fallback 设计
>
> 验证依据：[`sockscap-macos-mitmproxy-redirector-ipc-poc.md`](./sockscap-macos-mitmproxy-redirector-ipc-poc.md)
>
> 当前代码审计、P0/P1/P2 待办和发布 gate：[`sockscap-macos-redirector-implementation-analysis.md` §8–§10](./sockscap-macos-redirector-implementation-analysis.md#8-当前恢复机制审计)
>
> 上游 protocol v2 提案：[`sockscap-redirector-protocol-v2-proposal.md`](./sockscap-redirector-protocol-v2-proposal.md)

## 1. 已锁定的产品决策

以下约束同时适用于 Global 和 Applications，不保留并行实现：

1. **完全移除 macOS system proxy backend。**
   - 不再调用 `/usr/sbin/networksetup`。
   - 不再修改、保存或恢复 macOS Network → Proxies 设置。
   - 不把 system proxy 作为 legacy、fallback、degraded backend 或隐藏开关。
   - Redirector 不可用、未批准或启动失败时，SocksCap 明确失败并保持系统普通直连。
2. **捕获引擎固定为上游已签名、公证的 mitmproxy Redirector。**
   - Taomni 不再构建、签名或嵌入自己的 Network/System Extension。
   - Redirector 作为独立第三方 app 原样安装，Taomni 通过 Unix Socket IPC 驱动它。
   - 不修改、重签或拆散 Redirector 的 app/extension 签名边界。
3. **QUIC 与 Windows/Linux 保持相同产品语义。**
   - `block_quic=true` 继续作为会话级默认值。
   - 对 SocksCap in-scope 流量阻断 UDP/443，使应用回退到 TCP。
   - 当前不实现 SOCKS5 UDP ASSOCIATE；非 443 UDP 由 bridge 直连放行。
4. **Applications 是同一引擎上的增量能力。**
   - 先完成 Global 生产接入，再开放 Applications capability。
   - 两者共享 Redirector、IPC、relay、QUIC、恢复和发布路径。
   - application 方案在本文中完整设计，不再预留另一种 Network Extension。

### 1.1 当前代码进度（2026-08-01）

已完成：

- 删除 macOS `networksetup` system-proxy backend、fallback、sudo UI 和自建 Network Extension / `sockscap-core` 构建链。
- 正式模块已接入固定 protobuf framing、Global/Applications scope compiler、非空 inert stop、TCP shared relay、非 443 UDP direct 和 in-scope UDP/443 drop。
- Global capability 只在 `/Applications/Mitmproxy Redirector.app` 通过嵌套 codesign、Team/bundle identity 与 v0.12.11 可执行文件 hash 校验后开放。
- release workflow 固定下载 wheel、校验 wheel/app tar hash、原样 stage signed universal app tar 与 MIT notice；GitHub Runner 不编译 Xcode extension。
- 独立 bridge 模式已持有 Provider control，使用 version/session/generation/request-id 管理协议、父进程/心跳 watchdog 与 signal inert cleanup；Provider 和 bridge flow 两端均校验 Darwin peer PID/audit token，Provider control 额外校验固定签名和可执行文件 hash。
- write-ahead recovery journal、启动 readiness barrier、dirty recovery-only、独立 `/usr/bin/nc` 直连证明和 `RecoveryRequired` UI/诊断已经接通；v1 仍只能证明 frame 完整写入，不能声称 Provider ACK。
- Applications 已接入 `.app` Picker、Security.framework seal/designated-requirement 校验、启动前重验/移动与升级连续性、bundle family 和 fail-open 二次匹配，macOS `app_filter=true`。
- bundled tar 安装/升级 UI 已实现固定 hash、签名、版本、entitlement、双架构、Gatekeeper 校验、授权 staging/backup/rollback 和同名冲突拒绝。
- UDP direct 已增加 idle/并发/速率限制与 datagram、QUIC、scope mismatch 统计；P2 protocol v2 的 typed selector、ACK 和 atomic EOF 提案已形成仓库内草案。

尚未完成、因此当前不能标记 production-ready：

- Intel/Apple Silicon 上的完整异常注入、Application selected/unselected 与长期 soak/性能矩阵。
- 对 System Extension 与 Network Configuration 批准状态做稳定、可区分的系统 API 探测；当前安装状态只能可靠识别 extension 是否 `[activated enabled]`，Start 超时信息覆盖两种批准入口。
- Taomni 自身 Developer ID 签名、公证及 release blocking gate 的实际发布凭据验证。
- mitmproxy 上游接受 protocol v2 并发布重新签名的 Redirector；本仓库不能替代上游完成该项。

## 2. 已验证基线与生产边界

### 2.1 固定的第三方组件

第一版固定以下供应链基线：

| 项目 | 固定值 |
|---|---|
| PyPI 包 | `mitmproxy-macos==0.12.11` |
| wheel SHA-256 | `63349d9b46514ca679547651f7c0548f9222892edfbcba087b82b3244fbae859` |
| 上游 tag/commit | `mitmproxy_rs/v0.12.11` / `40f1dfb5dca7b03ff7793d3c90f23b8bdf873889` |
| app bundle id | `org.mitmproxy.macos-redirector` |
| extension bundle id | `org.mitmproxy.macos-redirector.network-extension` |
| Team ID | `S8XHQB96PW` |
| 架构 | universal `arm64 + x86_64` |
| 许可证 | MIT，分发时保留许可证与归属声明 |

上游结构和 IPC 说明：

- [Redirector README](https://github.com/mitmproxy/mitmproxy_rs/blob/v0.12.11/mitmproxy-macos/redirector/README.md)
- [InterceptConf.swift](https://github.com/mitmproxy/mitmproxy_rs/blob/v0.12.11/mitmproxy-macos/redirector/network-extension/InterceptConf.swift)
- [TransparentProxyProvider.swift](https://github.com/mitmproxy/mitmproxy_rs/blob/v0.12.11/mitmproxy-macos/redirector/network-extension/TransparentProxyProvider.swift)
- [MIT License](https://github.com/mitmproxy/mitmproxy_rs/blob/v0.12.11/LICENSE)

任何版本更新都必须重新固定 wheel hash、签名身份和协议测试向量，不能在 release job 中隐式获取 latest。

### 2.2 已完成真机验证

当前 PoC 已证明：

- TCP 和 UDP flow 可以从真实 System Extension 经 Unix Socket 到达 Rust bridge。
- curl、DNS UDP、UDP/443 阻断、application path scope 均通过。
- Chrome 150 的 UDP/443 被阻断后，同目标 TCP 建连并成功加载页面。
- 未列入 application scope 的进程保持系统直连。
- 验证前后 `HTTPEnable`、`HTTPSEnable`、`SOCKSEnable` 均为 `0`。
- bridge 正常退出前先禁用捕获，可恢复普通直连。

这些结果证明数据面可行，不等于当前 PoC 已满足生产生命周期和性能要求。

### 2.3 已确认的上游约束

生产设计必须正面处理以下事实：

1. IPC 是 mitmproxy 内部协议，不是承诺稳定的公共 SDK。
2. Provider 的 process scope 只支持：
   - 十进制 PID 精确匹配；
   - process path 的大小写敏感 `contains` 匹配；
   - 前缀 `!` 表示排除。
3. `InterceptConf` 没有 version、generation 或应用成功 ACK。
4. `NewFlow` 只携带 PID 和进程路径，不携带 bundle ID、Team ID 或 signing ID。
5. Provider 对控制通道普通 EOF 没有可靠的停止/清空语义；PoC 已观察到规则残留导致匹配应用超时。
6. 上游 `InterceptConf` 解析会读取 `actions[0]`，因此生产代码**禁止发送空 actions**。PoC 中“发送空配置”的做法不能直接进入生产；停用时必须发送非空、永不匹配的 include sentinel，并补做真机故障测试。

其中第 5、6 项是 Global 上线前的 P0；第 2、4 项决定了 application v1 是“经签名校验的路径族捕获”，而不是 Provider 内的 signing-ID 强隔离。

## 3. 目标与非目标

### 3.1 目标

- 不依赖应用是否遵循系统代理，透明捕获 macOS 出站 TCP。
- 把 Redirector flow 转成现有 `CapturedFlow`，继续复用 Direct、HTTP、SOCKS5、SSH 和 Xray egress。
- Global 和 Applications 使用同一套作用域编译器与本地二次校验。
- 只阻断 in-scope UDP/443；非 443 UDP、out-of-scope 和异常归属 flow 安全直连。
- 正常 Stop、Taomni 崩溃、bridge 重启和下次启动恢复均不能长期留下断网规则。
- 安装包能够在 GitHub Runner 固定、校验并携带上游已签名 Redirector。
- application profile 能确定性映射到现有 priority、rule 和 upstream 体系。

### 3.2 非目标

- 不代理任意 UDP，不实现 SOCKS5 UDP ASSOCIATE。
- 不把 UDP DNS 强制送入 TCP 上游；非 443 UDP 当前 direct-pass。
- 不使用 `NEPacketTunnelProvider`、PF、路由表、Content Filter 或 KEXT 作为 fallback。
- 不修改上游 `.systemextension`；需要 Provider 改动的能力通过 upstream PR 和新签名版本获得。
- application v1 不宣称 bundle/signing identity 在 Provider 内强制执行；其匹配边界是经过 Taomni 校验后生成的绝对路径。
- Taomni 没有 Developer ID 时，不宣称 Taomni DMG 自身已获得 Apple 公证；这与 Redirector 自身的有效签名、公证分开判断。

## 4. 目标架构

```text
                         ┌─────────────────────────────────────┐
Profiles / App Picker ──▶│ AppCatalog + CaptureScopeCompiler   │
                         │ actions + immutable ScopeSnapshot   │
                         └───────────────┬─────────────────────┘
                                         │ control: InterceptConf
                                         ▼
macOS application ──▶ signed Mitmproxy Redirector System Extension
                                         │
                                         │ one Unix socket per TCP/UDP flow
                                         ▼
                         taomni-redirector-bridge sidecar
                         ├─ verify peer / parse NewFlow
                         ├─ mirror scope check + profile mapping
                         ├─ UDP/443: DROP when in-scope
                         ├─ other UDP: DIRECT datagram relay
                         └─ TCP: CapturedFlow + shared Rust relay/egress
                                         │
                                         ▼
                              upstream connections
                         ┌───────────────┼────────────────┐
                         ▼               ▼                ▼
                       DIRECT          SOCKS5          HTTP/SSH/Xray
```

这里的 SOCKS5 仅是用户配置的上游协议。macOS 捕获入口、Redirector IPC 和本地 flow 通道均不使用系统 SOCKS 设置。

## 5. Redirector IPC 合同

### 5.1 启动与连接

1. bridge 在 `/tmp` 直属路径创建随机 Unix listener，设置严格权限。
2. 启动 `/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector <socket>`。
3. Redirector 激活其 System Extension、保存 `NETransparentProxyManager` 并启动 Provider。
4. Provider 建立第一条控制连接；bridge 发送 `InterceptConf`。
5. 每个匹配的 TCP/UDP flow 建立一条新的 Unix Socket 连接。

所有 protobuf 消息使用 `4-byte big-endian length + payload`，最大帧长度由 Taomni 明确限制。

### 5.2 数据模型

Taomni 固定并测试以下上游消息快照：

```text
InterceptConf { repeated string actions }

NewFlow {
  oneof {
    TcpFlow { remoteAddress, TunnelInfo { pid, processName } }
    UdpFlow { localAddress,  TunnelInfo { pid, processName } }
  }
}

UdpPacket { data, remoteAddress }
```

TCP 在 `NewFlow` 后直接复制原始字节；UDP 始终使用 framed `UdpPacket`。

### 5.3 IPC 安全

- socket 文件名包含高熵随机值，不只使用 PID；绑定后、启动 Redirector 前设置 `0600`。
- 使用 Darwin Unix peer credential/peer PID，解析对端可执行文件并校验其 Team ID 和 bundle identity；无法验证时不接受为控制/flow 连接。
- 第一条连接只有通过签名校验后才被认定为 control，避免同用户进程抢占。
- 所有 flow 连接重复做 peer 校验、帧长限制、地址/端口校验和读写超时。
- 不允许 UI、配置文件或命令行传入原始 action 字符串；actions 只能由 `CaptureScopeCompiler` 生成。
- 默认日志记录 profile、PID、basename 和统计；完整进程路径只进入受控 debug 日志。

## 6. 第三方组件安装与发布

### 6.1 构建期 staging

新增固定脚本，例如 `scripts/fetch-mitmproxy-redirector-macos.sh`：

1. 下载 `mitmproxy-macos==0.12.11` 的精确 wheel URL。
2. 校验固定 SHA-256。
3. 只提取 `mitmproxy_macos/Mitmproxy Redirector.app.tar`。
4. 把原始 tar 作为不透明资源放入 `src-tauri/resources/sockscap/macos/redirector/0.12.11/`。
5. 同时 stage MIT license、版本和 hash manifest。

使用 tar 而不是把 `.app` 目录直接嵌入 Taomni，避免 bundler 或签名步骤修改第三方嵌套签名。现有 `tauri.conf.json` 已包含 `resources/sockscap/**/*`，无需让 GitHub Runner 编译 Xcode extension。

### 6.2 运行期安装器

`RedirectorInstaller` 执行以下检查：

- 解包到独立临时目录，不直接覆盖 `/Applications` 中的对象。
- 校验 app 和 extension bundle id、Team ID、版本、universal 架构、entitlement、`codesign --verify --deep --strict`、stapled notarization/Gatekeeper。
- 目标不存在时，原子安装完整 app bundle。
- 目标为同 bundle id、同 Team ID 的受支持旧版本时，走可回滚升级。
- 目标同名但签名、Team ID 或 bundle id 不匹配时拒绝覆盖，并提示用户处理冲突。
- 目标已是正确版本时不重复写入。

标准管理员用户安装到 `/Applications` 后，日常运行 IPC 不需要 `sudo`。标准非管理员或受 MDM 管理的机器可能需要系统授权或管理员预安装；不能通过保存用户密码绕过系统策略。

### 6.3 GitHub Actions 能力边界

Hosted macOS Runner 可以完成：

- arm64/x86_64 Taomni 构建；
- Redirector 下载、hash、归属、签名和静态协议校验；
- DMG/updater artifact 生成。

Hosted Runner 不能完成首次 System Extension 人工批准或可靠的持久化真机 E2E。运行态回归使用预批准的 self-hosted Mac 或发布前人工测试。

`TAURI_SIGNING_PRIVATE_KEY` 只负责 Tauri updater，不等于 Apple Developer ID。Taomni 的正式 Gatekeeper 分发使用 GitHub Secrets `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD` 和 `APPLE_TEAM_ID` 完成 Developer ID 签名与公证。无 tag 的 workflow artifact 可以不使用正式 Apple 凭据；tag/GitHub Release 缺少任一 updater/Apple 必需 secret 时必须提前失败，不发布需要用户手动放行的降级包。Redirector 始终保持独立的上游签名、公证和固定 hash。

## 7. CaptureScopeCompiler

### 7.1 上游 action 语义

Redirector 以第一条 action 决定默认行为：

- 第一条不以 `!` 开头：默认不捕获；普通 action 做 include。
- 第一条以 `!` 开头：默认捕获；`!pattern` 做 exclude。
- 数字 pattern 匹配 PID；其他 pattern 对完整 process path 执行大小写敏感 `contains`。
- action 顺序会影响 include/exclude 结果，compiler 必须使用规范化顺序。

### 7.2 Global 编译

Global 使用“默认捕获 + 排除自身”模式，actions 全部是规范化的绝对路径排除项：

```text
[
  "!<canonical Taomni executable>",
  "!<canonical taomni-redirector-bridge executable>",
  "!<canonical xray/core executable>",
  "!/Applications/Mitmproxy Redirector.app/"
]
```

要求：

- 第一条必须是有效、非空的 `!self-path`，从而令 Provider 默认捕获其他进程。
- Taomni、bridge、Redirector 和所有 Taomni 启动的 egress sidecar 必须排除，避免递归。
- target endpoint/CIDR bypass 不能在上游 action 层表达；它们进入 bridge 后由 PolicyEngine 选择 Direct。
- Provider 无法解析进程信息时通常会自行 pass-through；若仍向 bridge 交付缺少身份的 flow，Global 按当前全局会话处理并记录，Applications 则 fail-open direct。

### 7.3 Applications 编译

Applications 使用“默认不捕获 + app bundle 路径族 include + 自身 exclude”：

```text
[
  "/Applications/Google Chrome.app/",
  "/Applications/Firefox.app/",
  "<validated supplemental executable full path>",
  "!<canonical Taomni executable>",
  "!<canonical bridge/core/Redirector paths>"
]
```

规则：

- 至少一个有效 include；否则 Start 失败。
- include 按规范化绝对路径去重，禁止 basename、用户任意 substring、空字符串和纯数字持久化 selector。
- app root 保留尾部 `/`，使主 executable、Framework、Helper、XPC 和 WebKit 子进程只要位于该 bundle 内就共同命中。
- exclude 永远排在所有 include 之后，确保 self/upstream 不会被重新包含。
- PID action 只用于诊断或一次性“捕获当前进程”，不持久化；PID 重用使它不适合作为产品身份。
- Provider 和 bridge 使用同一份不可变 `ScopeSnapshot` 和相同的 `contains` 语义，不能一边按 basename、一边按完整路径。

### 7.4 停用配置

禁止发送 `InterceptConf { actions: [] }`。停用时发送每次会话随机生成、保证不与合法进程路径相交的非空 include：

```text
["/__taomni_no_process__/<128-bit-random>/"]
```

发送成功后保持控制连接一段 drain 时间，再关闭数据面。该方式必须通过真实 Provider 的正常 Stop、控制 EOF、bridge `SIGTERM`、Taomni 崩溃和下次启动恢复测试后，才能替代当前 PoC 的空配置行为。

第一版 active session 的 scope、app 列表和 `block_quic` 设为不可变；修改配置显示“重启 SocksCap 后生效”。上游没有 generation ACK，在缺少可靠确认前不做无缝热切换。

## 8. Global 数据面

Global 的处理顺序如下：

1. Redirector 捕获 self exclusions 以外的新 TCP/UDP flow。
2. bridge 校验 `NewFlow`，构建 `CapturedFlow { destination, process_path, pid, origin }`。
3. TCP 通过 `UnixStream` adapter 接入现有 relay；不保留 PoC 的 direct-only TCP 实现。
4. PolicyEngine 决定 Direct、Proxy 或 Block，并选择 HTTP、SOCKS5、SSH、Xray 等 egress。
5. UDP/443 根据会话策略阻断；其他 UDP 直接 relay 到原目标。

Global 下即使目标最终被判定 Direct，TCP 也先进入 bridge/PolicyEngine。这与 Windows/Linux Global 的产品语义一致，并保留统一统计和规则解释。

必须验证以下递归边界：Taomni、bridge、Redirector、Xray/core、本地代理、远端 upstream、loopback、LAN 和 IPv4/IPv6。任何新增 egress sidecar 都必须先加入 self-exclusion inventory 才能在 macOS 启用。

## 9. QUIC 与其他 UDP

Redirector 会把匹配进程的 TCP 和 UDP 都送入 bridge，因此 UDP 策略按每个 datagram 执行：

```text
if !scope_snapshot.matches(process):
    DIRECT
else if block_quic && remote.port == 443:
    DROP_AND_CLOSE_FLOW
else:
    DIRECT_UDP_RELAY
```

约束：

- Global 的 in-scope 集合是 self exclusions 以外的进程。
- Applications 的 in-scope 集合是已验证路径族的并集。
- 同一 scope 下 TCP capture 集合必须与 UDP/443 drop 集合相同。
- UDP flow 的远端可能逐包变化，每个 `UdpPacket` 都重新检查端口，不能只检查第一包。
- `block_quic=false` 时 UDP/443 也直连，不进入 TCP egress。
- 纯 QUIC、没有 TCP fallback 的客户端会失败，UI 必须明确说明。

统计至少包括 `quicFlowsDropped`、`udpDirectDatagrams`、`lastQuicDropAt`、process/profile 和 drop reason，不记录 UDP payload。

## 10. Application 方案

### 10.1 能力定义

application v1 的产品定义是：

> 用户选择一个 macOS `.app`；Taomni 在每次 Start 前解析并校验该 bundle 的代码签名，然后把其规范化 bundle root 和经批准的补充 executable 编译成 Redirector path actions。Provider 从 audit token 解析真实 PID/path，bridge 再用同一 snapshot 二次校验并完成 profile 路由。

这比仅保存 app 名称或 bundle ID 可靠，也能覆盖 Chrome/Firefox 等 bundle 内多进程应用，但不是 Provider 内 signing-ID enforcement。恶意本地进程若能占据相同路径，理论上可被捕获；签名校验和 bundle seal 可降低风险，不能改变上游 path matcher 的本质。

### 10.2 持久化模型

扩展现有 `AppSelector`，保留 `path/bundleId/name` 的跨平台兼容字段，并增加默认可反序列化的 macOS identity：

```text
MacosAppIdentity {
  bundlePath                 // 用户选择时路径；每次 Start 重新解析
  canonicalBundlePath        // 上次验证结果，不作为唯一发现依据
  mainExecutablePath
  bundleId
  teamId                     // signed app
  signingId
  designatedRequirement      // 用于允许同一发布者的正常升级
  lastValidatedCdHash        // 诊断字段；更新后允许变化
  supplementalExecutables[]  // bundle 外 helper，必须为完整绝对路径
  allowUnsigned              // 默认 false；显式风险确认后才能启用
}
```

不持久化 PID。`cdhash` 不作为跨版本主键；正式签名 app 主要使用 bundle ID、Team ID、signing ID 和 designated requirement 验证升级连续性。

### 10.3 App Picker 与身份解析

Picker 流程：

1. 只允许选择 `.app` 或显式的 executable advanced mode。
2. 读取 `Info.plist` 的 display name、bundle ID 和 `CFBundleExecutable`。
3. 解析 symlink 后得到规范化 bundle root 和 main executable。
4. 使用系统 Security.framework 校验 static code、Team ID、signing ID、designated requirement 和 bundle seal。
5. signed app 保存完整 identity；unsigned/ad-hoc app 默认拒绝，用户显式选择“路径模式”后才保存 `allowUnsigned=true`。
6. UI 展示捕获范围：主程序、bundle 内 Helper/XPC，以及单独列出的 bundle 外 helper。

每次 Start 重新定位并校验：

- 原路径仍存在且 identity 连续：更新 canonical path/CDHash 后继续。
- app 移动：可按 bookmark/LaunchServices 与 bundle ID 找回，但只有签名 identity 一致才自动重绑定。
- app 升级：designated requirement 通过时允许 CDHash 变化。
- Team/signing ID 改变、bundle seal 无效或出现多个冲突候选：该 profile 启动失败，不静默降级为字符串匹配。
- unsigned 路径模式：路径改变即要求用户重新确认。

### 10.4 多进程与 Helper

- app root pattern 自动覆盖该 bundle 内的 `Contents/MacOS`、Framework、Helper、XPC 和 WebKit 子进程。
- bundle 外 helper 不自动按名称包含；用户或内置兼容目录必须提供完整 canonical executable，并单独校验签名。
- 对版本号位于 bundle 内路径的 Chromium Framework，不保存版本目录，统一匹配稳定 app root。
- 后台 agent、登录项若位于另一个 app/helper bundle，作为独立 family member 展示和保存。
- 可在后续增加“捕获当前运行实例”的临时 PID action，但不能替代路径族持久化。

### 10.5 Flow 到 profile 的归属

`ScopeSnapshot` 同时保存 provider actions 和 profile matcher。bridge 收到 `NewFlow` 后：

1. 用与 Redirector 一致的 process-path `contains` 规则确认是否 in-scope。
2. 找出所有匹配的 active application profiles。
3. 继续沿用现有稳定 priority：数值较小者先；相同 priority 按配置中的稳定顺序，禁止依赖 HashMap 顺序。
4. 将完整 `process_path`、PID 和选定 `profile_id_hint` 放入 `CapturedFlow`。
5. PolicyEngine 仍负责该 profile 内的 user rule、GFWList、default action 和 upstream；Swift Provider 不承载业务路由。

混合 profile 语义保持确定性：所有 active profiles 统一按 priority 排序，首个匹配者胜出；Global 匹配任意进程，Apps 只匹配其 family。UI 对“高优先级 Global 遮蔽低优先级 Apps”给出冲突提示，而不是暗中改变 priority 规则。

如果 path 缺失、snapshot 不匹配或 profile 已被移除：

- Applications：TCP/非 443 UDP direct-pass，UDP/443 不阻断，记录 `scope_mismatch_fail_open`。
- Global：按 Global 处理，但 self/upstream identity 异常时优先防递归并报错。

已建立的 flow 保持启动时选定 profile 直到连接关闭，不因配置编辑迁移到另一 upstream。

### 10.6 application v1 的发布门槛

只有以下条件全部满足，macOS `capabilities.app_filter` 才能设置为 `true`：

- Picker、identity 持久化和每次 Start 重验证完成。
- action compiler 只生成规范化绝对路径，Provider/bridge matcher 有共享测试向量。
- `NewFlow.processName/pid` 已进入 `CapturedFlow` 和 stats。
- profile overlap、Global/Apps 混合、helper family 和 priority 已有单测。
- Chrome、Safari、Firefox、Electron、普通单进程 app 均有 selected/unselected 真机用例。
- selected app 的 UDP/443 被阻断并回退 TCP，unselected app 的 UDP/443 保持直连。
- app 升级、移动、签名改变、bundle 外 helper、unsigned opt-in 均有测试。
- application-only 会话的未知/错配 flow 已验证 fail-open，不会误伤其他应用。

### 10.7 application v2 上游增强

建议向 mitmproxy 上游提交兼容扩展，由上游签名发布新 Redirector：

- `ProcessInfo`/`NewFlow` 增加 bundle ID、Team ID、signing ID 或 audit-token 派生 identity。
- `InterceptConf` 增加 typed selector：exact path、bundle ID、signing ID、PID，不再依赖裸 substring。
- 增加 protocol version、generation、applied ACK、显式 disable/stop。
- control EOF 时原子切换到 no-intercept/fail-open，并停止或重建 manager。

Taomni 在检测到新协议版本时可从 path-verified v1 升级为 signing-identity enforced v2；不需要更换 capture engine 或 relay。由于 Provider 是上游签名组件，这些修改必须由 mitmproxy 发布，Taomni 不能本地 patch 后继续使用原签名。

## 11. Bridge 生命周期与恢复

### 11.1 独立 sidecar

生产 bridge 使用独立 `taomni-redirector-bridge` sidecar，而不是让 Tauri UI 进程直接持有 Redirector control socket：

- sidecar 负责 listener、control、flow accept、scope snapshot 和 graceful disable。
- Tauri backend 通过受限的本地管理 IPC 下发已校验配置、临时解析的凭据并读取状态；管理 IPC 同样校验 peer、限制权限，且不落盘明文 secret。
- sidecar 监控父进程/管理心跳；Taomni 正常退出或崩溃时先发送 inert sentinel，再 drain/退出。
- sidecar 编译复用现有 PolicyEngine/relay，并负责 native Direct/HTTP/SOCKS5/SSH 连接；它自身被强制排除。Xray 等外部 core 同样由 compiler 强制排除。

这样可以覆盖 Tauri UI/backend 崩溃，但不能自动证明 bridge 自身 `SIGKILL` 安全；该场景必须单独解决和验证。

### 11.2 状态机

```text
ArtifactMissing
InstallRequired
ApprovalRequired
Ready             // Redirector 可用，未捕获或已下发 inert spec
Starting          // listener ready，启动 Redirector，等待 control
Active            // control connected，非空 scope 已成功写入
Stopping          // inert spec -> drain -> close flows/control
RecoveryRequired  // 检测到旧 manager/socket/rule，正在恢复
Error             // 无 fallback，附可操作原因
```

上游没有 applied ACK，因此 `Active` 只能表示 control 已连接且完整 frame 写入成功，不能伪装成 generation acknowledged。UI 同时显示 `lastFlowAt` 和 health 状态；协议 v2 出现 ACK 后再增强 Active 条件。

### 11.3 Start

1. 校验 Redirector artifact/安装状态和签名。
2. 校验配置、active profiles、app identities 和 self-exclusion inventory。
3. 构建不可变 `ScopeSnapshot`；Applications 没有有效 selector 时失败。
4. 创建随机 `/tmp` socket、设置权限并启动 sidecar。
5. 启动官方 Redirector，等待 control；需要用户批准时进入 `ApprovalRequired`。
6. 发送**非空** actions，记录 config hash 和 session id。
7. control 写入成功后进入 Active；不触发 system proxy。

### 11.4 Stop

1. 停止接受新的业务请求，但保持 control 和 listener 存活。
2. 发送非匹配 inert sentinel，等待规定 drain 时间。
3. 新到达的异常 flow 只 direct-pass，不再进入代理 egress。
4. 结束已有 flow，关闭 control/listener，清理 socket 和 journal。
5. 复测普通直连；失败则进入 `RecoveryRequired/Error`，绝不切换 system proxy。

需要推动上游提供显式 manager stop。v1 若只能保持一个“已启用但所有 flow pass-through”的 manager，UI 和卸载文档必须如实说明，不能把它描述为 extension 已卸载。

### 11.5 崩溃恢复

- Tauri 崩溃：sidecar 通过 parent/heartbeat 检测并下发 inert sentinel。
- 正常 sidecar `SIGTERM`：执行与 Stop 相同的 inert → drain 顺序。
- sidecar `SIGKILL`、机器重启、socket 被删除：下次启动先进入恢复模式，禁止直接发送业务 scope。
- 恢复流程先创建 listener、重新启动/连接 Redirector，并只发送 inert sentinel；确认普通 TCP 可用后才允许用户再次 Start。
- 若无法重新取得 control 或确认网络恢复，明确提示用户在系统设置中关闭 mitmproxy transparent proxy，并提供诊断日志。

以下 fault injection 全部通过前不能称为 production-ready：Tauri `SIGKILL`、bridge `SIGKILL`、control 普通 EOF、Redirector launcher 崩溃、Provider crash、sleep/wake、网络切换、注销/登录和系统重启。

## 12. 与现有 Rust relay 的集成

PoC 的 direct TCP relay 只用于验证，生产实现应抽象共享入口：

```text
serve_captured_stream<S>(stream: S, flow: CapturedFlow, ctx: RelayContext)
where S: AsyncRead + AsyncWrite + Unpin
```

- Windows/Linux 现有 `TcpStream` 和 macOS `UnixStream` adapter 复用同一 PolicyEngine/egress。
- macOS `CapturedFlow` 填充 `dest_ip/dest_port/process_path/pid/profile_id_hint`。
- 原目标通常是 IP；域名规则继续依赖现有 DNS map/SNI best-effort 恢复，不虚构 hostname。
- 保留半关闭、背压、连接超时、取消、并发上限和 stats。
- Direct/native egress 由已排除的 bridge sidecar 发起；Xray egress 由已排除的 core 发起，避免 Redirector 递归捕获。
- UDP direct relay 独立于 TCP egress，并限制 flow 数、idle timeout、单包大小和每源速率。

## 13. 完全移除旧实现

实施时至少完成：

- 删除 `src-tauri/src/sockscap/capture/macos/system_proxy.rs`。
- 删除 `/usr/sbin/networksetup`、sudo password、proxy restore、`SystemProxyScope` 和 loopback SOCKS capture。
- 删除 `MacosBackend::SystemProxy`、`choose_macos_backend`、动态 fallback 和对应测试。
- 将 `capture/macos` 改为单一 `mitmproxy-redirector` facade。
- 移除/归档 Taomni 自建 Provider 的 `resources/macos-provider`、activation shim、build-extension 脚本和 `sockscap/transparent` 中只服务自建 extension 的代码。
- 移除 `build.rs` 中自建 macOS NE shim 编译逻辑；保留 Taomni 其他功能实际需要的 entitlements。
- capabilities 改为基于 Redirector artifact、安装/审批和 bridge 状态，不再探测 Taomni bundle 内 `.systemextension`。
- 删除 macOS admin password preflight 和相关 UI/i18n。
- 删除所有“fallback to system-proxy”“Global via system SOCKS”文案。
- 保留数据库客户端“忽略外部系统代理”的独立防护；它不是 SocksCap capture backend。

验收搜索：

```text
rg "SystemProxyScope|system-proxy|networksetup|fallback to system-proxy" \
  src-tauri/src/sockscap src/components/sockscap src/lib/sockscap.ts
```

运行时代码结果应为空；历史文档若保留，顶部必须明确标记已被本文取代。

## 14. 分阶段实施

### Phase 0：旧 backend 清理与协议固定

- 删除 system proxy、fallback、sudo 和自建 NE 构建路径。
- 把 PoC protobuf 升级为版本固定的 `redirector_ipc` 模块和 fixture tests。
- 修正停用逻辑：禁止空 actions，增加 inert sentinel 真机验证。
- capabilities 暂时报告 Global/Applications unavailable，直到对应 gate 完成。

完成标准：macOS 不再修改系统 Proxies；仓库不再要求编译 Taomni Network Extension。

### Phase 1：Artifact、Installer 与 CI

- 实现固定下载/stage、license manifest 和 build-time hash 检查。
- 实现签名、Team ID、bundle id、版本、架构、Gatekeeper 校验。
- 实现冲突安全安装、升级和用户批准状态。
- GitHub Actions 构建 arm64/x86_64 包并执行静态供应链校验。

完成标准：全新 Mac 可以由用户批准官方 Redirector，Taomni 不需要自己的 NE entitlement。

### Phase 2：Global bridge 与 relay

- 实现独立 sidecar、IPC peer verification、scope compiler 和 UnixStream relay adapter。
- Global TCP 接入 PolicyEngine/egress/stats。
- 非 443 UDP direct-pass，UDP/443 按 session scope 阻断。
- 完成 self/upstream/core exclusions 和递归测试。

完成标准：Safari、Chrome、curl 和忽略系统代理的 socket client 均能按 Global profile 路由，系统代理设置不变。

### Phase 3：生命周期与发布加固

- 实现 inert Stop、parent heartbeat、recovery journal 和启动前恢复。
- 对 sidecar/provider crash、EOF、sleep/wake、网络切换和重启做 fault injection。
- 完成并发、吞吐、CPU、内存和 soak test。
- 解决或明确阻断 bridge `SIGKILL` 后的 fail-open；优先推动上游 EOF/stop 修复。

完成标准：所有 P0 恢复场景通过后，Global 才可标记 production-ready。

### Phase 4：Applications

- 扩展 AppSelector、Picker、Security.framework identity 校验和 bundle family resolver。
- 实现 Applications action compiler、bridge 二次 scope 和 profile priority 映射。
- 覆盖 helper/XPC、app 升级/移动、签名变化、unsigned opt-in 和 profile overlap。
- selected/unselected TCP 与 UDP/443 真机矩阵全部通过后设置 `app_filter=true`。

### Phase 5：上游协议增强

- 提交 typed selector、signing identity、ACK/generation 和 fail-open stop PR。
- 固定并验证上游新签名版本。
- 保持 v1 path-family 配置迁移，优先使用 v2 signing identity。

## 15. 测试计划

### 15.1 单元测试

- protobuf golden fixtures、4-byte framing、未知字段和最大帧拒绝。
- Global actions 第一条必须是 exclusion；Applications 第一条必须是 include。
- 空 actions 永远拒绝；inert sentinel 非空且不会匹配已知 executable corpus。
- include/exclude 顺序、大小写、路径 contains、PID、去重和非法 selector。
- Global/Apps/mixed profile priority、重叠 app family、未知 path fail-open。
- selected UDP/443 drop、unselected/非 443/block-off direct。
- app identity 升级连续性、Team ID 改变、unsigned opt-in 和多候选冲突。
- peer identity、畸形帧、非法地址、超时和连接数限制。

### 15.2 本地 IPC 集成测试

- fake Provider control + TCP/UDP flow，多 flow 并发和 backpressure。
- UnixStream adapter → PolicyEngine → Direct/HTTP/SOCKS5/SSH/Xray。
- scope snapshot 与 provider actions 使用同一测试向量。
- Tauri 管理 IPC 中断后 sidecar 自动 inert。
- Stop 顺序、stale socket、普通文件不删除、journal 恢复。

### 15.3 签名真机 E2E

- 首次批准、拒绝后重试、已批准重启、升级替换和签名冲突。
- Start/Stop 前后 `scutil --proxy` 完全一致。
- Global：Safari、Chrome、curl、自建 socket client、IPv4/IPv6。
- Applications：selected/unselected Chrome/Safari/Firefox/Electron/普通 app。
- Chrome/Safari Helper、XPC、bundle 外 helper 和 app 更新路径变化。
- QUIC：selected/global 回退 TCP，unselected 和 `block_quic=false` 保持 UDP。
- Direct/Proxy/Block、多个 upstream、Xray/core 和 local proxy 无递归。
- Tauri/bridge/launcher/Provider crash、EOF、sleep/wake、网络切换和重启。

### 15.4 性能与稳定性

至少测量：

- 1/32/256 并发 TCP 的吞吐与连接建立 p50/p95/p99。
- 大量短连接、每秒新建 flow 和 1,000–5,000 并发连接。
- DNS UDP 延迟、丢包、flow idle 回收和 UDP flood 限流。
- Global 与 Applications 在不同 action 数量下的 CPU/RSS。
- Intel 和 Apple Silicon 上 1–4 小时 soak、睡眠和网络切换。

建议初始门槛为 TCP 吞吐不低于直连的 85%–90%、捕获层额外建连延迟 p99 小于 10 ms；最终阈值以产品基准机实测后锁定，不能把 PoC 的小流量结果当作性能结论。

## 16. 发布验收条件

Global production release 必须同时满足：

- runtime 中不存在 system proxy backend、fallback 和 `networksetup` 调用。
- Redirector 版本/hash/Team ID/bundle IDs/entitlement/Gatekeeper 全部固定并校验。
- 不发送空 `InterceptConf`；正常 Stop 和全部 P0 crash recovery 已真机通过。
- Active 只在 control 连接和完整非空配置写入成功后显示，并如实表达“无上游 ACK”。
- Global TCP 覆盖忽略系统代理的应用，Direct/Proxy/Block/各 egress 正常。
- `block_quic=true` 只阻断 in-scope UDP/443；其他 UDP direct-pass。
- self/upstream/core 无递归；系统 Proxies 前后不变。
- Intel/Apple Silicon 的功能、性能、稳定性和升级路径通过。
- DMG 包含第三方许可证和版本清单；Taomni 自身签名/公证状态不与 Redirector 混淆。

Applications release 还必须满足 §10.6，随后才能报告 `app_filter=true`。

## 17. 主要风险与决策

| 风险 | 等级 | 缓解/决策 |
|---|---:|---|
| control EOF/bridge crash 后旧规则残留 | P0 | 独立 sidecar、inert sentinel、恢复 journal、fault injection；优先要求上游 fail-open/stop 修复。 |
| 空 actions 触发上游越界行为 | P0 | compiler 永久拒绝空数组；停用使用随机非匹配 include，并做真机回归。 |
| IPC 是内部协议且无 ACK/version | P0 | 固定版本/hash/protobuf fixtures；v1 session scope 不热切换；更新必须回归。 |
| path `contains` 不是强身份匹配 | P1 | 只生成 canonical full-path/bundle-root；每次 Start 校验代码签名；推动 typed/signing selector。 |
| app 更新、移动和多进程 helper 漏捕获 | P1 | bundle family root、designated requirement 重绑定、补充 helper 模型和真机矩阵。 |
| self/Xray/upstream 递归 | P0 | compiler 强制 exclusions；bridge 二次 scope；每种 egress 上线前递归测试。 |
| 第三方 app 安装/升级冲突 | P1 | 精确签名 allowlist、禁止覆盖未知同名 app、可回滚升级。 |
| Taomni 无 Developer ID | 发布风险 | 可生成用户手动确认的 DMG；不影响上游 Redirector 签名，但不能宣称 Taomni 已公证。 |
| 大量 app actions 或 flow 的性能退化 | P1 | 显式数量上限、动作去重、matcher 索引、基准与 soak gate。 |
| non-443 UDP 直连产生泄漏语义 | 已接受 | UI/文档明确当前只阻断 QUIC，不宣称全 UDP 代理或 kill switch。 |

最终判断：mitmproxy Redirector 可以成为 Taomni macOS SocksCap 的唯一透明捕获引擎，并在不具备 Taomni Network Extension 签名能力的前提下支持 Global 和 application path-family 捕获。进入生产的关键不在数据面可行性，而在于关闭 control/bridge 崩溃后的残留规则风险、固定第三方协议与供应链，以及把 application v1 的路径匹配边界如实建模和验证。
