# SocksCap macOS Redirector 实施分析

> 日期：2026-08-01
>
> 状态：实施基线
>
> 目标方案：[`sockscap-macos-transparent-only-plan.md`](./sockscap-macos-transparent-only-plan.md)

## 1. 当前实现结论

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
| Applications | 自建 NE 设计按 signing ID，未运行 | 当前 Redirector 的 canonical path-family actions；身份 gate 未完成前 capability=false |
| Stop | 旧自建协议假设控制断开即 fail-open | 非空 inert action → drain；EOF/SIGKILL 保持 P0 |
| 发布 | 不携带官方 Redirector | 固定 wheel/hash、原始 app tar、MIT notice、静态签名校验 |

## 3. 已发现的协议风险

- 上游 `InterceptConf` 通过 `actions[0]` 判断默认行为；空数组不是合法停用配置。
- process selector 是 PID 或对完整路径的大小写敏感 `contains`，不是 bundle/signing ID。
- 控制协议没有 version、generation 或 ACK。
- 普通控制 EOF 不保证清空旧 spec；PoC 已观察到残留规则。
- 第一条 Unix connection 被约定为 control，IPC 本身没有 token，需要随机 socket、权限和 peer 校验补强。

因此本轮会把“禁止空 actions”和作用域 compiler 作为代码不变量。独立 sidecar、强 peer signing 校验和 bridge `SIGKILL` 恢复是后续生产 gate；在这些完成前不得宣称完整 production-ready。

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

- 当前第一版只开启 `global_tcp`。
- Applications compiler 和 profile mapping 可以进入代码，但 `app_filter` 在 App Picker identity、签名重验证和 selected/unselected 真机矩阵完成前保持 `false`。
- Redirector 缺失/签名不匹配时 Start 失败，不回退任何系统代理。

## 5. 验证策略

1. 纯单测：protobuf framing、action 顺序、空数组拒绝、inert sentinel、Global/Apps scope、UDP policy。
2. Rust 集成：fake Unix provider → TCP echo/PolicyEngine、UDP direct/drop。
3. 当前 Mac：官方 `0.12.11` Redirector 的 Global curl、DNS、QUIC→TCP、Stop 后直连。
4. upstream：使用 `http://192.168.0.110:31028` 作为 HTTP upstream，验证被捕获 TCP 经现有 HTTP CONNECT egress；需要下载固定资料时也可临时设置 `HTTP_PROXY/HTTPS_PROXY`。
5. 回归：`cargo test --lib`、前端 SocksCap 聚焦测试、`pnpm build`；只格式化本轮修改的 Rust 文件。

## 6. 本轮不伪装完成的项目

- bridge 进程级 sidecar/管理 IPC。
- Darwin Unix peer PID + code-signing verification。
- Redirector 自动安装/升级的完整授权 UI。
- bridge `SIGKILL` 后的可靠 provider 重置。
- application App Picker、Security.framework identity 和 bundle family 重绑定。
- Apple Developer ID 下的 Taomni 签名/公证。

这些项目继续作为目标方案中的 Phase 1–5 gate；第一切片建立可编译、可测试、无 system-proxy fallback 的唯一 Redirector 基础。

## 7. 第一切片实施结果

截至 2026-08-01，本分析对应的第一切片已落到代码：

- macOS backend 选择收敛为 `mitmproxy-redirector`，Redirector 不存在或校验失败时 capability 不开放，Start 明确失败。
- 已删除所有 `networksetup` 调用路径、旧 system-proxy 恢复逻辑、自建 Provider/activation shim 与 `sockscap-core` workspace。
- 正式 IPC codec 禁止空 `InterceptConf.actions`；Stop 使用随机、不匹配的非空 include sentinel。
- TCP `UnixStream` 直接进入通用 `CapturedFlow` relay，因此复用现有 HTTP/SOCKS5/SSH/Xray egress 和 PolicyEngine。
- UDP 当前只实现产品要求：in-scope UDP/443 drop 以触发 QUIC→TCP，其他 UDP direct relay。
- scope compiler 同时建模 Global exclusions 与 Applications bundle-path family，并稳定映射 profile priority；但 application capability 和运行入口仍保持关闭。
- 已增加固定 wheel/app tar/可执行文件 hash、codesign、Team/bundle identity、universal arch 的 staging/check 脚本，并接入 macOS release job。

当前验证结果：Redirector 聚焦 Rust 测试 14/14 通过（包含 application 运行 gate、当前已安装 app 的固定 hash 与签名检查）；前端 Vitest 全量 1806/1806 通过；固定资源在当前 Mac 上通过 hash、nested codesign 与双架构检查。一次全量 `cargo test --lib` 中 1044 项通过，除已修复的 scope 用例外，另有 5 个与本改动无关的既有环境/测试失败（mail cache、PTY UTF-8，以及 3 个 `/private/var` canonical path 用例）。
