# macOS SocksCap：mitmproxy Redirector IPC Bridge 验证

日期：2026-08-01

状态：验证完成。真实 System Extension 的 TCP、UDP、application scope、UDP/443 阻断、Chrome QUIC→TCP 回退和显式停机恢复均已通过。

## 1. 验证目标

本验证只回答一件事：Taomni 能否复用 mitmproxy 已签名、公证的 `Mitmproxy Redirector.app` 作为 macOS 捕获引擎，通过它现有的 Unix Socket IPC 接收 application-level TCP/UDP 流，同时完全不修改系统 HTTP/SOCKS 代理配置。

当前 PoC 与生产 SocksCap 路径隔离，不会切换 `src-tauri/src/sockscap/capture/macos/mod.rs`，也不会把系统代理保留为 fallback。它暂时把捕获到的 TCP 和非 443 UDP 直接转发到原目标，仅用于证明捕获和 IPC 数据面。

## 2. 固定的上游版本与供应链检查

- PyPI 包：[mitmproxy-macos 0.12.11](https://pypi.org/project/mitmproxy-macos/0.12.11/)，发布于 2026-07-20。
- wheel：`mitmproxy_macos-0.12.11-py3-none-any.whl`。
- SHA-256：`63349d9b46514ca679547651f7c0548f9222892edfbcba087b82b3244fbae859`。
- 对应[源码 tag](https://github.com/mitmproxy/mitmproxy_rs/tree/v0.12.11/mitmproxy-macos/redirector)：`mitmproxy_rs/v0.12.11`，commit `40f1dfb5dca7b03ff7793d3c90f23b8bdf873889`。
- 许可证：MIT；若后续随 Taomni 分发，必须保留上游许可证和归属声明。
- 宿主 app 与 System Extension 均为 `x86_64 + arm64` universal binary。
- 签名：`Developer ID Application: Maximilian Hils (S8XHQB96PW)`。
- System Extension bundle id：`org.mitmproxy.macos-redirector.network-extension`。
- entitlement：`com.apple.developer.networking.networkextension = app-proxy-provider-systemextension`。
- `codesign --verify --deep --strict` 通过。
- Gatekeeper：`accepted`，来源为 `Notarized Developer ID`。

`0.12.9` 与 `0.12.11` 在 protobuf、macOS packet source、Swift provider 和 IPC framing 相关文件上无差异，但生产接入仍应固定版本和哈希，不能隐式跟随最新版。

## 3. IPC 协议结论

Redirector 启动顺序如下：

1. Taomni 在 `/tmp` 直属路径创建 Unix listener。
2. 启动 `/Applications/Mitmproxy Redirector.app/Contents/MacOS/mitmproxy redirector <socket>`。
3. Redirector 安装/激活它自己的 System Extension，并创建 `NETransparentProxyManager` 配置。
4. Provider 首先打开一个控制连接；Taomni 发送一帧 `InterceptConf`。
5. 每条匹配的 TCP/UDP flow 再各自打开一个 Unix Socket 连接。

所有 protobuf 帧均为 `4-byte big-endian length + protobuf payload`：

- 控制连接：发送 `InterceptConf { repeated string actions }`。action 可按 PID 或进程路径子串匹配，因此天然保留未来 application-level SocksCap 的扩展点。
- flow 连接第一帧：`NewFlow`，包含 TCP/UDP 类型、进程 PID/路径和地址信息。
- TCP：`NewFlow` 后切换为双向原始字节流。
- UDP：后续一直发送/接收带远端地址的长度前缀 `UdpPacket`。

重要实测结论：不能把关闭控制连接当作可靠的 fail-open。PoC 第一次只关闭 socket 后，Provider 仍保留最后一份 `curl` 拦截规则，随后 curl 出现 SSL connection timeout。向控制通道显式发送空 `InterceptConf` 后再关闭，退出后的 curl 恢复为 HTTP 200。因此 graceful stop 必须先 disable；进程崩溃仍需要独立看护或上游提供明确的 stop/EOF 语义。

## 4. PoC 实现

代码位于：

- `src-tauri/src/bin/mitmproxy-redirector-poc/main.rs`
- `src-tauri/src/bin/mitmproxy-redirector-poc/bridge.rs`

安全边界：

- `--intercept` 强制必填，防止 PoC 意外打开全局捕获。
- 默认阻断捕获流的 UDP/443；`--allow-udp-443` 只用于对照测试。
- 非 443 UDP 使用 `send_to/recv_from` direct relay，允许同一个 UDP flow 的目标发生变化；每一包都重新执行 UDP/443 检查。
- Unix Socket 必须位于 `/tmp/`，且 stale path 只有在确认为 socket 时才会删除。
- IPC 帧限制为 1 MiB，拒绝畸形长度和非法端口。
- PoC 的上游连接由桥接进程发起，而拦截规则只匹配测试进程，避免递归捕获。
- 收到 `Ctrl-C` 时先发送空 `InterceptConf`，等待其进入控制通道，再关闭连接和删除 socket。

构建与受控启动：

```sh
cd src-tauri
cargo build --bin mitmproxy-redirector-poc
./target/debug/mitmproxy-redirector-poc --intercept curl,dig,nc
```

首次启动需要用户在 macOS 的“隐私与安全性”中批准 mitmproxy 的 System Extension；不需要让 Taomni 或桥接器以 `sudo` 运行。批准属于系统强制的交互步骤，无法由 GitHub Runner 或无签名 Taomni 自动代替。

## 5. 验证矩阵

| 项目 | 结果 | 证据/预期 |
| --- | --- | --- |
| protobuf wire format | 通过 | `InterceptConf(["curl"])` 与上游字节编码一致 |
| TCP IPC bridge | 通过 | 回环 TCP echo：握手后 raw stream 双向各 4 bytes |
| UDP IPC bridge | 通过 | 回环 UDP echo：framed datagram 双向各 1 包 |
| UDP/443 阻断 | 通过 | 首包或后续包目标为 443 时均不向上游发送并关闭该 flow |
| stale socket 安全 | 通过 | 普通文件不会被 bridge 删除 |
| 聚焦单测 | 通过 | `cargo test --bin mitmproxy-redirector-poc`：6 passed |
| 官方 wheel 哈希 | 通过 | 与 PyPI `0.12.11` SHA-256 一致 |
| app/extension 签名与公证 | 通过 | codesign、entitlement、Gatekeeper 均通过 |
| System Extension 注册 | 通过 | `org.mitmproxy.macos-redirector.network-extension (2.0/1) [activated enabled]` |
| 真实 TCP 捕获 | 通过 | `/usr/bin/curl` 经 IPC 返回 HTTP 200；一次实测为上行 601 B、下行 4842 B |
| 真实非 443 UDP 放行 | 通过 | curl DNS 与 `/usr/bin/dig` 的 UDP/53 均经 IPC 获得响应 |
| 真实 UDP/443 阻断 | 通过 | `/usr/bin/nc -u 1.1.1.1 443` 命中 `UDP 1.1.1.1:443 blocked` |
| application scope | 通过 | action 只含 curl/dig/nc 时，未列入的 `/usr/bin/openssl` 直连成功且 bridge 无 flow |
| QUIC→TCP 应用回退 | 通过 | Chrome 150 先命中 `[2606:4700::6812:1b0e]:443/UDP` 阻断，随后同地址 TCP 完成 2451 B/17612 B，页面输出 `<title>QUIC \| Cloudflare</title>` |
| graceful stop | 通过（有条件） | 退出前发送空配置后，bridge 停止且无 IPC socket，同一 curl 仍返回 HTTP 200 |
| 仅断开 socket | 不通过 | 未先 disable 时，最后的匹配规则残留并使 curl 超时；不能作为停机方案 |
| 系统代理未改动 | 通过 | 验证前后均为 `HTTPEnable=0`、`HTTPSEnable=0`、`SOCKSEnable=0` |

## 6. 生产集成建议

建议把 mitmproxy Redirector 定义为 `MacosRedirectorEngine`，而不是把 PoC 的 direct relay 直接合入现有 capture backend：

1. `EngineInstaller`：从 Taomni 签名资源或固定下载源取指定版本，先校验 SHA-256、Team ID、bundle id、entitlement 和 Gatekeeper，再以独立 app 形式放入 `/Applications`。不得覆盖未知来源或签名不匹配的同名 app。
2. `EngineLifecycle`：启动 Redirector、等待控制通道、发送配置、健康检查；将“等待用户批准”和“等待网络配置批准”作为可见状态返回前端。正常退出必须按 `empty InterceptConf → 确认/短暂 drain → close` 执行，不能直接断开 socket。
3. `CaptureBridge`：解析 IPC，生成统一的 `CapturedFlow` 元数据。TCP 数据面需要让现有 relay 接受通用 `AsyncRead + AsyncWrite`，或提供 UnixStream adapter，不能保留 PoC 的 direct-only 行为。
4. `UdpPolicy`：对每个 UDP packet 检查目标，UDP/443 在 capture 层立即关闭；其他当前不支持代理的 UDP 明确 direct-pass，并记录 reason。后续代理端具备 UDP 能力时再接路由策略。
5. `ScopePolicy`：第一版可用排除列表表达全局捕获；application-level 待办直接映射为 Redirector action 的 PID/进程路径规则，无需更换引擎。
6. `CrashRecovery`：Taomni 每次启动先下发空规则清理遗留状态，再启用捕获。生产版还需要独立 watchdog，或推动上游签名 Provider 在控制 EOF 时清空规则/停止 tunnel；否则 Taomni 被 `SIGKILL` 或崩溃后存在匹配应用断网窗口。
7. `SupplyChainPolicy`：固定包版本、哈希和上游协议快照测试；更新 Redirector 时必须跑 IPC compatibility、graceful/crash stop 与真实系统扩展回归。

关键风险有两个：这个 IPC 属于 mitmproxy 内部协议，并非承诺稳定的公共 SDK；现有签名 Provider 的控制断链也不是可靠 fail-open。方案的数据面与 application scope 已证明可行，但进入生产前必须先关闭 crash-recovery 缺口，并把 Redirector 当作有版本约束的第三方运行时组件。

## 7. 当前机器的安装状态与清理

验证期间已安装：

```text
/Applications/Mitmproxy Redirector.app
```

当前 System Extension 保持 `[activated enabled]`，但最后下发的是空拦截规则；bridge、Chrome 测试进程、临时 profile 和 IPC socket 均已清理。系统代理保持关闭，退出后 curl 已复测为 HTTP 200。

停止 PoC 时按 `Ctrl-C`，桥接器会先下发空规则，再关闭控制通道并清理 `/tmp/taomni-mitmproxy-redirector-<pid>.sock`。是否保留 app 和已批准的 System Extension 应由用户决定；不要在 capture 运行中直接删除 bundle。
