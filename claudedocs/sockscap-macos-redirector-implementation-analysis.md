# SocksCap macOS Redirector 实施分析

> 日期：2026-08-01
>
> 状态：P0–P2 代码切片已实现；Redirector v0.12.11 是当前受支持且固定的生产基线版本；真实双架构故障注入/soak 等仍是 release gate，上游 v2 是非阻塞路线图
>
> 目标方案：[`sockscap-macos-transparent-only-plan.md`](./sockscap-macos-transparent-only-plan.md)
>
> 协议 v2 草案：[`sockscap-redirector-protocol-v2-proposal.md`](./sockscap-redirector-protocol-v2-proposal.md)

## 1. 改造前实现结论

仓库当前同时存在三条 macOS 路径：

1. `capture/macos/system_proxy.rs` 是实际可运行主路径，通过 `networksetup` 修改系统 SOCKS 代理。
2. `capture/macos/transparent.rs`、`sockscap/transparent/*`、`resources/macos-provider/*` 是 Taomni 自建 Network Extension 的未完成路径，失败后回退 system proxy。
3. `src/bin/mitmproxy-redirector-poc` 已在当前 Mac 上验证第三方已签名 Redirector 的真实 TCP/UDP IPC，但尚未接入正式 relay。

这三条路径与已锁定的产品决策冲突。实现不能继续在旧 transparent abstraction 上打补丁，应删除前两条并把 PoC 中被验证的上游协议提炼为唯一 macOS backend。

## 2. 关键代码差距

| 区域 | 当前状态 | 本轮目标 |
|---|---|---|
| backend 选择 | 自建 NE 优先，失败回退 system proxy | 只有 `mitmproxy-redirector`，失败明确返回 |
| 构建 | `build.rs` 编译 Objective-C activation shim；workspace 包含 `sockscap-core` staticlib | 删除自建 NE 构建依赖，不要求 Xcode/NE entitlement |
| capabilities | 无自建 extension 时仍报告 system-proxy Global 可用 | 依据官方 Redirector artifact/安装状态报告 |
| TCP 数据面 | system proxy → SOCKS ingress；PoC 只 direct | Redirector `UnixStream` → 通用 `CapturedFlow` relay |
| UDP | system proxy 不捕获；PoC 可 direct/阻断 443 | in-scope UDP/443 阻断，其余 direct |
| Applications | 自建 NE 设计按 signing ID，未运行 | 经 Security.framework 重验的 canonical bundle path-family；Provider 内 typed identity 待 v2 |
| Stop | 旧自建协议假设控制断开即 fail-open | 独立 bridge watchdog → 非空 inert → drain；bridge SIGKILL 由 dirty 启动恢复闭环处理 |
| 发布 | 不携带官方 Redirector | 固定 wheel/hash、原始 app tar、MIT notice、静态签名校验 |

## 3. 已发现的协议风险

- 上游 `InterceptConf` 通过 `actions[0]` 判断默认行为；空数组不是合法停用配置。
- process selector 是 PID 或对完整路径的大小写敏感 `contains`，不是 bundle/signing ID。
- 控制协议没有 version、generation 或 ACK。
- 普通控制 EOF 不保证清空旧 spec；PoC 已观察到残留规则。
- 第一条 Unix connection 被约定为 control，IPC 本身没有 token，需要随机 socket、权限和 peer 校验补强。

“禁止空 actions”和作用域 compiler 已成为代码不变量；独立 bridge、强 peer signing 校验和 bridge `SIGKILL` 后的 dirty 启动恢复也已落地。真实异常注入仍是 production gate。

## 4. 第一实施切片

### 4.1 Phase 0 清理

- 删除 `system_proxy.rs`、`MacosBackend::SystemProxy` 和所有 fallback。
- 删除 Taomni 自建 Provider、activation shim、`sockscap-core` staticlib/workspace 依赖。
- 移除 macOS sudo password/system-proxy UI 和测试语义；Linux sudo 保持不变。
- macOS recovery 不再调用 `networksetup`。

### 4.2 正式 Redirector core

- 新增版本固定的 protobuf types 与 length-prefixed codec。
- 新增 `CaptureScopeCompiler`：Global exclusions、Applications includes/excludes、inert sentinel。
- 新增 flow bridge：TCP 进入现有 PolicyEngine/egress；UDP/443 drop，其他 UDP direct。
- 重构 relay 接受任意 `AsyncRead + AsyncWrite`，让 TCP `UnixStream` 不经过本地 SOCKS 伪装。

### 4.3 capability gate

- 固定 Redirector 校验通过后开启 `global_tcp`。
- Applications compiler、profile mapping、App Picker identity 和启动前签名重验证完成后，代码 capability 已开启 `app_filter`；selected/unselected 双架构矩阵仍作为发布 gate，而非伪装成已执行。
- Redirector 缺失/签名不匹配时 Start 失败，不回退任何系统代理。

## 5. 验证策略

1. 纯单测：protobuf framing、action 顺序、空数组拒绝、inert sentinel、Global/Apps scope、UDP policy。
2. Rust 集成：fake Unix provider → TCP echo/PolicyEngine、UDP direct/drop。
3. 当前 Mac：官方 `0.12.11` Redirector 的 Global curl、DNS、QUIC→TCP、Stop 后直连。
4. upstream：使用 `http://192.168.0.110:31028` 作为 HTTP upstream，验证被捕获 TCP 经现有 HTTP CONNECT egress；需要下载固定资料时也可临时设置 `HTTP_PROXY/HTTPS_PROXY`。
5. 回归：`cargo test --lib`、前端 SocksCap 聚焦测试、`pnpm build`；只格式化本轮修改的 Rust 文件。

## 6. 第一切片当时未完成的项目（历史记录）

- bridge 进程级 sidecar/管理 IPC。
- Darwin Unix peer PID + code-signing verification。
- Redirector 自动安装/升级的完整授权 UI。
- bridge `SIGKILL` 后的可靠 provider 重置。
- application App Picker、Security.framework identity 和 bundle family 重绑定。
- Apple Developer ID 下的 Taomni 签名/公证。

这些是第一切片结束时的缺口；当前处理结果和仍未执行的真机 gate 以 §8–§10 为准。

## 7. 第一切片实施结果

截至 2026-08-01，本分析对应的第一切片已落到代码：

- macOS backend 选择收敛为 `mitmproxy-redirector`，Redirector 不存在或校验失败时 capability 不开放，Start 明确失败。
- 已删除所有 `networksetup` 调用路径、旧 system-proxy 恢复逻辑、自建 Provider/activation shim 与 `sockscap-core` workspace。
- 正式 IPC codec 禁止空 `InterceptConf.actions`；Stop 使用随机、不匹配的非空 include sentinel。
- TCP `UnixStream` 直接进入通用 `CapturedFlow` relay，因此复用现有 HTTP/SOCKS5/SSH/Xray egress 和 PolicyEngine。
- UDP 当前只实现产品要求：in-scope UDP/443 drop 以触发 QUIC→TCP，其他 UDP direct relay。
- scope compiler 同时建模 Global exclusions 与 Applications bundle-path family，并稳定映射 profile priority；后续切片已经接通 application identity、运行入口和 capability。
- 已增加固定 wheel/app tar/可执行文件 hash、codesign、Team/bundle identity、universal arch 的 staging/check 脚本，并接入 macOS release job。

第一切片当时的验证结果：Redirector 聚焦 Rust 测试 14/14 通过；前端 Vitest 全量 1806/1806 通过；固定资源在当前 Mac 上通过 hash、nested codesign 与双架构检查。P0–P2 本轮的最新验证结果见交付记录；旧的数量不用于替代新增测试。

## 8. 当前恢复机制审计

当前代码已经把正常停机和异常恢复拆成两个可验证闭环：

- Taomni 以同一已签名可执行文件的隐藏 bridge 模式启动独立进程；bridge 独占 Provider control，主进程只接收经 bridge 转发的 flow。两侧使用继承的 stdin/stdout 管理管道和随机 `0600` Unix socket，协议带 version、session、generation、request ID，并限制单条消息为 1 MiB。
- bridge 监控父 PID、管理管道 EOF 和 10 秒 heartbeat，处理 `SIGINT`/`SIGTERM`/`SIGHUP`；任何触发都执行 `inert -> 300 ms drain -> flow/control close`。bridge/provider 异常通过 telemetry 使 orchestrator 转为 `RecoveryRequired`。
- Provider control peer 必须同时通过 Darwin `LOCAL_PEERPID`、audit token、System Extension bundle/Team codesign 和固定 executable hash；每个 Provider flow 必须来自同一 PID。bridge 与主进程的 flow socket也双向校验预期 PID。
- Start 在业务 scope 前 durable 写入 `Preparing`，之后记录 `Active`；Stop 先写 `Stopping`，只有 inert teardown 与 journal clean/remove/fsync 都成功才进入 Idle。启动期间 readiness barrier 阻止 Start 与异步 boot repair 竞态。
- dirty recovery 会持有跨进程模块锁，启动新的已验证 Redirector，只发送随机非空 inert 并正常关闭 listener/control；这与正常 Stop 使用相同的硬完成边界。随后由明确未 self-exclude 的 `/usr/bin/nc` 子进程做普通 TCP 直连诊断，可用 `SOCKSCAP_RECOVERY_PROBE_ADDR` 指定逗号分隔的 numeric `IP:port`。公网不可达只记录告警，不再把离线/受限网络误判为 Redirector 恢复失败；控制连接、身份校验或 inert 下发失败仍保留 journal 和 `RecoveryRequired`。
- 启动恢复仅删除当前用户、固定命名、类型为 Unix socket 且已经无法连接的遗留节点；不会删除普通文件、外来 owner 或活跃 socket。
- UI 提供 Recover、macOS 系统设置手动关闭步骤和去敏诊断复制；恢复失败会阻止 Start、更新和静默宣称成功。若当前进程仍持有捕获锁也会阻止普通退出；仅启动时发现遗留 dirty journal、当前进程没有活动捕获时允许退出并保留 journal，避免离线用户被困在应用内。

仍有一个无法在 Taomni v1 适配层内消除的上游边界：Redirector v0.12.11 没有 Provider applied ACK、typed identity selector 或 control EOF atomic fail-open。因此本地 `Applied/Active` 只表示 bridge 已把完整 v1 frame 写入经验证的 Provider control；真正 Provider ACK 需要上游 protocol v2。

这里的“强应用身份隔离”是指 Provider 在每条新 flow 进入时，依据系统观察到的 audit token、bundle ID、Team ID、signing ID/designated requirement 独立验明进程身份，而不是仅判断可执行文件路径是否包含某段字符串。当前 v0.12.11 路径由 Taomni 在 Start 前验签、编译 canonical app path-family，并由 bridge 对 flow 再匹配；它能够支持当前 Application 功能，但不等同于 Provider 内部的不可伪造身份授权。

“任何崩溃均原子 fail-open”是指 control EOF、Provider/bridge crash 或进程被 `SIGKILL` 的同一状态转换中，Provider 立即停止把新连接导向旧 listener，让新连接直接联网，不存在中间残留拦截窗口。当前实现对正常退出、可处理信号、父进程消失和心跳中断执行 `inert -> drain -> close`，并用 dirty journal 在下次启动恢复；但 v0.12.11 不承诺 control EOF 原子 fail-open，所以极端 crash 到下次恢复/手动关闭之间仍可能存在残留窗口。

这些是 v0.12.11 的已知协议边界，不阻塞当前固定版本发布。当前 production release gate 是完整异常注入、双架构/Application 真机矩阵、稳定性、供应链和 Taomni 自身签名公证；如果产品未来要求 Provider 级强身份授权或协议层零残留窗口，再推进 protocol v2。

## 9. 后续待办清单

### 9.1 P0：先消除“假恢复”

- [x] 在真实 macOS recovery 完成前，dirty journal 必须使运行态保持 `RecoveryRequired`；`recover_system()` 空操作不得清除 journal。
- [x] 调整 `boot_repair()` 和 `sockscap_recover()` 的平台契约：只有 macOS recovery 通过已验证控制通道完成 inert apply/stop，才能 `force_idle()` 和 `mark_clean_and_clear()`；独立公网探针只作诊断，避免离线或目标受限造成假失败。
- [x] 恢复失败时禁止新的 Start/更新；当前进程仍持有捕获锁时禁止静默退出，只有无活动捕获的遗留 journal 状态允许保留记录后退出；UI 显示可操作原因，不得仅显示“已恢复”。
- [x] 提供可观察的手动兜底：指引用户在 macOS 系统设置中关闭 Mitmproxy Redirector network configuration/system extension，并导出诊断信息。

### 9.2 P0：独立 bridge 与进程生命周期

- [x] 实现独立 bridge 进程模式，由它持有 Redirector control/listener、scope snapshot 和 TCP/UDP flow；Tauri 主进程不再直接持有 Provider control socket。
- [x] 设计受限的 Tauri ↔ bridge 管理 IPC，覆盖 Start、Stop、Status、心跳和错误；继承的匿名管道协议包含 version、session/generation 和请求响应关联，不经过可抢占的管理 socket，也不传 upstream secret。
- [x] bridge 监控父进程与管理心跳；Taomni 消失或管理 IPC 断开时自动执行 `inert -> drain -> close`。
- [x] bridge 处理 `SIGINT`/`SIGTERM`/`SIGHUP`，全部复用同一 graceful disable 路径；`SIGKILL` 由下次启动恢复路径处理。
- [x] 统一 Stop 状态机：不接收新业务配置 → 发送 inert → drain → 终止新 flow → 结束存量 flow → 关闭 control/listener → 清理 socket/journal。
- [x] bridge 任务或 Redirector launcher 非预期退出时主动通知 orchestrator，从 `Active` 转为 `RecoveryRequired`；不得继续显示虚假 Active。

### 9.3 P0：真实启动前恢复闭环

- [x] 把 journal 改为 write-ahead：启动 Redirector/下发业务 scope 前先持久化 dirty `Preparing`，然后按 `Active -> Stopping -> Clean` 更新；不得留下“业务 scope 已生效但 journal 尚未写入”的崩溃窗口。
- [x] 扩展 recovery journal，记录恢复所需的 backend/version、session id、scope hash、bridge/owner PID 和生命周期阶段；不落盘 token 或 upstream 明文凭据，并使用限权、原子替换和必要的 sync 语义覆盖掉电场景。
- [x] 在应用启动期间增加 recovery readiness barrier；`boot_repair()` 未完成前 command 层不允许 Start，避免异步 boot task 与用户 Start 竞态。
- [x] 发现 dirty journal 后先获取跨进程模块锁，进入 recovery-only 模式，禁止直接下发业务 scope。
- [x] 恢复模式创建新的随机 `0600` Unix listener，重新启动并连接已签名 Redirector，只发送非空 inert sentinel。
- [x] 在协议无 ACK 的现状下定义可验证的恢复条件：control frame 完整写入、规定 drain 完成，以及 listener 关闭后由明确不在 self-exclusion 中的 probe process 执行普通 TCP 直连。
- [x] 恢复超时、Redirector 无法回连、签名变化或直连仍失败时保留 journal 和 `RecoveryRequired`，并给出手动关闭方案。
- [x] 处理遗留 socket/bridge：跨进程锁内只删除当前 owner、固定名称、socket 类型且无法连接的节点；bridge 由父 PID/EOF/heartbeat 回收，不按 journal PID 盲杀进程。

### 9.4 P0：IPC 安全、自捕获与协议边界

- [x] 实现 Darwin Unix peer PID/audit token 解析和 code-signing 验证；第一条 Unix connection 只能由预期 Redirector 身份成为 control，flow 连接校验同一 Provider PID；bridge/main flow socket 双向校验预期 PID。
- [x] 管理 IPC 使用继承的匿名 stdin/stdout 管道和会话/generation/request 关联；Provider/flow socket 使用随机路径与 `0600`，明文 upstream secret 不进入 bridge 协议。
- [x] scope compiler 强制排除 Taomni、bridge、Redirector、Xray/core 及其它 Taomni 启动的 egress sidecar，并同时保留 lexical/canonical 路径变体。
- [ ] 对 Direct、HTTP、SOCKS5、SSH、Xray、loopback、LAN、IPv4/IPv6 做递归与泄漏矩阵；新增任何 egress sidecar 前先更新 exclusion inventory。
- [x] 固定 Redirector v0.12.11 协议 golden fixture，覆盖 framing、未知字段、空/超大 frame、非法地址、连接上限和 timeout；Redirector 升级必须先跑兼容性回归。
- [x] 明确 v1 `Active` 只表示 control 已连接且 frame 已写入，不得表示 Provider 已 ACK；scope/app/`block_quic` 在会话期间保持不变，修改后要求重启 SocksCap。

### 9.5 P0 验收：异常注入矩阵

以下场景必须在已批准 System Extension 的真实 Intel 和 Apple Silicon Mac 上验证，且每个场景后普通 TCP 不能长期被导向已消失的 listener：

- [ ] 正常 Stop 和正常退出。
- [ ] Tauri 主进程 `SIGTERM`、`SIGKILL`、panic 和 abort。
- [ ] bridge `SIGTERM`、`SIGKILL` 和管理心跳中断。
- [ ] control 普通 EOF、socket 被删除和畸形/中断 frame。
- [ ] Redirector launcher 退出、Provider crash/restart 和系统扩展被禁用。
- [ ] 睡眠/唤醒、Wi-Fi/有线切换、断网重连、注销/登录和系统重启。
- [ ] 另一 Taomni 实例正在捕获时启动/恢复，不得抢占或清理其资源。
- [ ] 所有失败路径都验证 journal、状态机、UI 提示、诊断日志和手动兜底；全部通过后才能开放 Global production gate。

### 9.6 P1：Application 级支持

Application v1 的真实能力边界是“经签名重验证的 canonical app path-family”，不是 Provider 内的 bundle/signing-ID 强隔离。

- [x] 扩展 `AppSelector` 的 macOS identity：`bundlePath`、canonical bundle/main executable、bundle ID、Team ID、signing ID、designated requirement、last CDHash、supplemental executables 和显式 `allowUnsigned`。
- [x] 实现 macOS App Picker：默认只允许 `.app`，解析 `Info.plist`/`CFBundleExecutable`，解析 symlink，并在 UI 显示实际覆盖的 main/Helper/XPC 路径族。
- [x] 通过 Security.framework 校验 static code、bundle seal、Team/signing ID 和 designated requirement；unsigned/ad-hoc 默认拒绝，只允许显式 opt-in 的绝对路径+固定 hash 模式。
- [x] 每次 Start 重新定位并验签：支持 app 升级后 CDHash 变化、签名连续性重绑定和 app 移动找回；Team/signing ID 改变、bundle seal 失效或多候选冲突启动失败。
- [x] 完成 bundle family resolver：app root 覆盖包内 Framework/Helper/XPC/WebKit；配置模型保留 supplemental executable，但包外 helper 的独立 UI/逐项身份模型仍列为后续增强。
- [x] 把已有 Applications action compiler 接入运行入口，去掉 active Apps profile 的 Start gate；仍保留空/relative/basename/纯数字 selector 拒绝。
- [x] bridge 使用同一份不可变 `ScopeSnapshot` 做二次匹配；Applications 遇到 path 缺失、scope mismatch 或未知归属时 TCP/UDP 均 fail-open direct，且不阻断 UDP/443。
- [x] 实现稳定 profile 归属：priority 小者优先，同 priority 依配置顺序；Apps 重叠和 Global/Apps 混合沿用既有稳定顺序。
- [x] 完善 process path、PID、profile id、scope mismatch 和 QUIC drop 的统计/诊断，不记录 payload。
- [ ] 完成 selected/unselected 真机矩阵：Chrome、Safari、Firefox、Electron、普通单进程 app，以及 Helper/XPC、app 升级/移动、签名改变、包外 helper、unsigned opt-in、TCP 和 UDP/443。
- [x] identity、fail-open 和 priority 代码 gate 完成后将 macOS `capabilities.app_filter` 设为 `true`；selected/unselected 双架构真机矩阵未完成前仍不得作为 production release gate 通过。

### 9.7 P1：Redirector 安装、升级与供应链

- [x] 实现运行时 `RedirectorInstaller`，从固定资源解包到独立临时目录，不直接覆盖 `/Applications` 中的对象。
- [x] 同时验证 app/extension 的 version、SHA-256、bundle ID、Team ID、entitlement、universal arch、nested `codesign --deep --strict` 和 Gatekeeper Notarized Developer ID；stapler 在 staging/release 环境可用时校验，CI 缺失即失败。
- [x] 已安装正确版本时幂等；同签名旧版本使用随机 stage/backup 和失败回滚升级；同名但 bundle/Team/签名不匹配时拒绝覆盖并提示冲突。
- [ ] 把“缺失”、“待 System Extension 批准”、“待 Network Configuration 批准”、“签名错误”和“版本不支持”建模为不同状态和 UI 操作，而不是统一 Start 错误。
- [x] 在 staging/release 脚本的固定下载、hash、签名、universal arch 和 MIT notice 检查上补齐 entitlement/Gatekeeper、双架构与 stapler gate；协议 golden fixture 进入 Rust 测试。
- [ ] Taomni updater 签名与 Apple Developer ID/notarization 是两套独立信任链；release workflow 已要求两套 secrets，并在两个架构构建后验证 Taomni Developer ID、Team ID、Gatekeeper notarization 和 stapled ticket。正式 Gatekeeper 分发仍需配置真实 Apple 凭据并让首个 tag 构建通过该 gate。

### 9.8 P1/P2：数据面、可观测性和稳定性

- [x] UDP direct relay 增加 60 秒 idle timeout、共享 flow 数量上限、每 flow/source token bucket 和完整 datagram 统计；保持“只阻断 in-scope UDP/443，其它 UDP direct”语义。
- [x] 增加 `lastFlowAt`、control/bridge health、当前 session/scope hash、`quicFlowsDropped`、`udpDirectDatagrams`、`lastQuicDropAt`、scope mismatch 和失败原因。
- [x] 向 UI/文档明确：non-443 UDP 会直连，当前不是全 UDP proxy/kill switch；纯 QUIC 且无 TCP fallback 的客户端可能失败。
- [ ] 覆盖 1/32/256 并发、大量短连接、1,000–5,000 长连接、UDP flood、不同 action 数量和 1–4 小时 soak，记录吞吐、建连 p50/p95/p99、CPU 和 RSS。
- [ ] 在 Intel/Apple Silicon、IPv4/IPv6、Safari/Chrome/curl/原始 socket client 上完成 Global 矩阵，并验证 Start/Stop 前后 `scutil --proxy` 完全不变。
- [x] 将当前与本改动无关的全量 Rust 测试失败单独记录；聚焦 macOS Redirector 新增回归必须独立全绿，不得被既有失败掩盖。

### 9.9 P2：上游协议 v2 非阻塞路线图

本节不属于 Redirector v0.12.11 的当前发布 gate。v0.12.11 继续作为受支持且固定的生产基线；只有决定采用上游未来版本时，才执行提交、迁移和升级。

- [x] 在仓库内完成 typed selector、identity、version/generation/request、applied ACK、显式 disable、atomic EOF、迁移与测试矩阵的具体提案：[`sockscap-redirector-protocol-v2-proposal.md`](./sockscap-redirector-protocol-v2-proposal.md)。
- [ ] 向 mitmproxy 上游提交 typed selector（exact path/bundle/signing ID/PID）和 `NewFlow` 身份字段扩展。
- [ ] 提交 protocol version、generation/applied ACK、显式 disable/stop 和 control EOF 原子 fail-open。
- [ ] 若未来采用 v2，只接入由 mitmproxy 上游构建、签名并发布的新 Redirector；固定新版本/hash/协议 fixture，保留 v1 path-family 配置迁移并优先使用 v2 signing identity，不修改或自行重签 Provider。

## 10. 建议实施顺序与发布 gate

1. 先完成 §9.1，立即阻止 dirty journal 被 macOS 空恢复误清。
2. 完成 §9.2–§9.4，把 control 所有权从 Tauri 迁入 bridge，建立父进程监控和启动前 recovery-only 闭环。
3. 通过 §9.5 全部 fault injection 后，才允许 Global 进入 production-ready。
4. 在 P0 生命周期基础上完成 §9.6；identity 和 selected/unselected 矩阵全部通过后才开启 `app_filter=true`。
5. §9.7–§9.8 可与 Application 工作并行；安装/升级、供应链、双架构和稳定性验收仍是正式发布的必要条件。§9.9 v2 是非阻塞路线图，不影响固定 v0.12.11 发布。

任何单元测试或 PoC 成功都不能单独解锁上述 gate；Global/Application 的生产能力以固定且验证通过的官方签名 Redirector v0.12.11、已批准 System Extension 和故障注入结果为准，不依赖上游 v2 发布。

## 11. P0–P2 本轮交付与验证记录

2026-08-01 在当前 Intel Mac 上完成：

- `cargo check --lib --bin taomni` 通过；`cargo build --bin taomni` 通过。新增 macOS 依赖全部放在 target-specific dependency 下，bridge CLI 入口由 `#[cfg(target_os = "macos")]` 隔离。
- `cargo test --lib sockscap::redirector -- --test-threads=1`：24/24 通过；包含 v0.12.11 golden frame、管理协议、scope、QUIC policy、Calculator 系统签名应用、当前已安装 Redirector 的固定签名/hash/version/entitlement/universal/Gatekeeper supply-chain gate。
- `cargo test --lib sockscap::recovery -- --test-threads=1`：3/3 通过。
- `pnpm build` 通过；Vitest 全量 221 files / 1806 tests 通过。
- 最终构建的 bridge 真机完成 `controlReady -> Applied -> Ping/Pong -> inert Stop -> Stopped`；Provider peer 验证通过，退出后两个随机 Unix socket 均不存在，独立 `nc 192.168.0.110:31028` 直连成功。
- HTTP upstream `192.168.0.110:31028` 和 SOCKS5 upstream `192.168.0.110:6088` 都完成 TCP 可达与经代理访问 `https://example.com` HTTP 200。
- Redirector app/extension 都确认是 `x86_64 arm64`，System Extension 为 `[activated enabled]`；验证后 `scutil --proxy` 的 `HTTPEnable`、`HTTPSEnable`、`SOCKSEnable` 仍全部为 `0`。
- `bash scripts/stage-mitmproxy-redirector-macos.sh --check` 在可访问 macOS 安全服务的环境中通过：app/extension nested codesign、Designated Requirement、entitlement、固定 hash、双架构、Gatekeeper Notarized Developer ID 和 stapled ticket 均验证成功。

本轮没有伪造以下外部结果：Apple Silicon 实机、完整 §9.5 fault injection、Application 多浏览器/Helper/XPC selected-unselected、1–4 小时 soak/高并发仍未执行，并保持未勾选 release gate。mitmproxy 上游 v2 PR/官方签名新版本也未执行，但它属于非阻塞路线图，不是 v0.12.11 的当前 release gate。
