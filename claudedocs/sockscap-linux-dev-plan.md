# SocksCap Linux 开发计划

**目标**：在 Linux 上提供可恢复的 TCP 透明捕获、按应用过滤、规则/上游 relay、打包与 CI 覆盖；捕获状态只能在内核规则实际安装成功后显示为 Active。

**当前状态**：实现已从不可编译的 stub 收敛为 `nftables OUTPUT NAT + cgroup v2 + SO_ORIGINAL_DST` 后端，并补上了**无 root 容器**里唯一可行的 local-proxy 后端（见下文专节）——环境探针判定透明捕获不可能时自动切换，而不是把一个无解的权限错误反复丢给用户。纯逻辑与 Linux 单元测试、前端构建、DEB 封包及内容检查已完成；真实特权环境流量验证和已运行 Vite 服务上的 UI 执行仍待完成。

## Task checklist

- [x] **Phase 0：抽象层准备**
  - [x] 创建 `src-tauri/src/sockscap/capture/linux/` 子目录，并移除与目录同名的冲突 stub 模块。
  - [x] 定义 `LinuxCapture` trait、运行句柄和 cfg(Linux) 编排入口。
  - [x] 让 `orchestrator.rs` 保存 Linux capture 生命周期，而不是进入 `start_linux_stub`。
  - [x] 验证：Linux `cargo check --lib` 通过。

- [x] **Phase 1：PID / 内核重定向 / relay**
  - [x] 根据已配置的可执行文件解析 PID；App 模式预建按方案隔离的 capture cgroup，并持续发现、接管在 SocksCap Start 之后启动的目标进程。
  - [x] Global 模式将 Taomni/relay 放入 bypass cgroup，防止上游连接被自己再次捕获。
  - [x] 用受验证的 CIDR 生成专属 `inet taomni_sockscap` nftables OUTPUT NAT 表，并只将 TCP 重定向到 loopback relay。
  - [x] 在 relay 上通过 `SO_ORIGINAL_DST` 恢复原始 IPv4/IPv6 目标，复用现有策略、统计和 HTTP/SOCKS/SSH egress。
  - [x] 失败时回滚 relay/cgroup；停止时按“先删 nft 规则、再停 relay、再恢复 cgroup”顺序执行。
  - [x] 对不完整清理进入 `RecoveryRequired`，不清除恢复 journal；Recover 只删除本应用残留表和空 cgroup。
  - [x] 单元测试：CIDR 注入防护、nft 规则渲染、PID 集合、cgroup 路径、防篡改路径、原始目标选项。
  - [ ] 验证：在具备 `CAP_NET_ADMIN` 与 cgroup 写权限的 Linux 主机上进行真实 TCP 代理流量测试。

- [ ] **Phase 2：策略、统计、UI 确认**
  - [x] relay 共享策略、域名记录和流量统计；配置/规则热更新继续使用共享 relay context。
  - [x] UI 明确区分“Linux 后端可用”和“Active · Linux nftables transparent capture”，不再静态宣称已激活。
  - [x] 新增 SocksCap 浏览器预览 smoke 用例、feature catalog 与自动化审计。
  - [ ] 在实际 Vite/桌面服务上执行该 UI smoke；浏览器预览不尝试内核捕获。
  - [ ] 结合真实代理上游复核 UI Active、域名/字节计数和 Stop/Recover。

- [x] **Phase 3：打包、发布**
  - [x] 添加 Linux 资源说明与 `stage-sockscap-linux.sh --check` 打包前检查。
  - [x] DEB/RPM 声明 `nftables` 运行时依赖；不在安装时授予 GUI 广泛 Linux capabilities。
  - [x] GitHub Ubuntu runner 运行 Linux capture 单测和打包前检查。
  - [x] 验证本地 `tauri build --bundles deb` 的应用构建、DEB 生成、内容与依赖；签名另需 release 环境提供私钥。

- [ ] **Phase 4：生产验证与发布**
  - [ ] 在最小权限 launcher 或 systemd cgroup delegation 环境复核全局/按应用模式、断电恢复和 CPU 占用。
  - [ ] 收集真实流量、UI 和包产物证据；准备 release/tag。

## 验证记录

- `cargo test --lib sockscap::capture::linux`：12 passed。
- `pnpm build`：通过。
- `bash scripts/stage-sockscap-linux.sh --check`：通过。
- `qa_ui_auto.lint`、SocksCap case dry-run 和 `audit --feature F-Sockscap-1`：通过。
- `pnpm tauri build --bundles deb`：release 编译、资源预检与 `Taomni_0.3.37_amd64.deb` 生成成功；`dpkg-deb` 确认依赖含 `nftables`、包内含 Linux runtime README 与 `sockscap-helper`。命令最终仅因本地没有 `TAURI_SIGNING_PRIVATE_KEY` 而在签名后置步骤返回非零；发布/CI 环境须提供该密钥。
- 本机 `nft list tables` 返回 `Operation not permitted`，因此不能在此 runner 做 `CAP_NET_ADMIN` 流量验证；端口 5000/1420 也没有已运行的 Vite/桌面服务，按 UI 自动化流程不自动启动服务。

## 实现偏差与原因

原计划中的 `smoltcp + TUN NAT` 没有继续采用。TUN/smoltcp 自身不会截获宿主机的 TCP OUTPUT；若没有额外的内核 redirect/mark 规则，只会得到一个看似启动、实际不接管流量的实现。当前方案改为 nftables 在内核 OUTPUT NAT hook 做透明重定向，使用 cgroup v2 inode 做进程范围匹配，并由 loopback relay 读取 `SO_ORIGINAL_DST`。

这仍满足 PID 过滤、cgroup、流量决策和可测试抽象层目标，同时避免虚假的 Active 状态。代价是运行时需要管理员批准的 `CAP_NET_ADMIN` 与 cgroup 管理权限；应用会在 preflight 阶段明确失败，而不会自动给 GUI 进程授予 `CAP_SYS_ADMIN`。

## 容器 / 无 root 环境：local-proxy 后端

透明捕获在部分环境下**根本不可能**，而不只是"缺少提权"。容器通常把 `CAP_NET_ADMIN` 从 **bounding set** 里去掉，此时容器内的 uid 0 也无法获得该能力，任何 sudo 流程都不可能成功；cgroup v1-only 的宿主同样无法提供 nftables 依赖的 cgroup v2 socket 匹配。

判定依据是 capability **bounding set**（`/proc/self/status` 的 `CapBnd`）而不是 effective set —— 后者为空只代表"需要提权"，前者缺位才代表"永远不可能"。把两者混淆会造成双向损害：既可能把只差一个密码的普通桌面误降级，也可能对着无解的容器反复索要密码。`capture/linux/support.rs` 做这个判定（三次文件读取，无子进程，`OnceLock` 缓存），并同时报告 cgroup v2 挂载与 `nft` 存在性。

不支持透明捕获时，引擎改用 `capture/local_proxy.rs`：把既有的 `ingress/`（loopback SOCKS5 / HTTP-CONNECT）接成正式后端。该监听器此前已完整实现但**没有任何调用方**，握手后直接进入 `relay::handle_captured_client`，因此策略 / GFWList / SNI / egress / 统计与透明后端完全共用。

语义边界（UI 必须如实呈现，不能让人误以为全局捕获已生效）：

- **不自动拦截**：只有显式指向该端口的客户端会被捕获。`capabilities()` 因此报 `global_tcp: false`。
- **无进程归属**：代理握手不携带 `process_path` / `pid`，基于可执行文件路径的 app selector 不生效，`app_filter: false`。方案改用**端口区分**：global/catch-all 方案占用配置端口（默认 **7890**，不是 1080——1080 正是默认上游 `socks5 127.0.0.1:1080` 的端口，占用它会在出厂配置下自环；端口固定以便 `ALL_PROXY` 类客户端配置在重启后仍然有效），其余启用方案各分配一个端口。
  - 该自环不只靠默认值规避：`local_proxy::start` 在**实际绑定到的端口**上检查是否等于某个启用方案的 loopback 上游端点，命中即回滚并报错。检查放在绑定之后，随机端口偶然撞上上游端口也能拦住；core 类上游（走 xray sidecar 自己的 inbound）与 session 类上游（端点在拨号时才解析）不参与判定。
  - 端口区分要成立，策略引擎必须把 backend 给出的 `profile_id_hint` 视为**权威归属**。原实现只用它跳过 App 方案的进程匹配，Global 方案一律视为命中，于是优先级更高的 Global 方案会替本该由被 hint 方案回答的流量做决定——在本后端里所有方案都是 Global，这是必然踩到的静默错路由。现在 hint 命中的方案独占评估（`decide_with_profile_hint` 与 `decide_without_hostname` 同步生效）；hint 指向的方案已不在启用列表时（配置热更新删除）退回按优先级遍历，而不是掉到 "no matching profile"。
  - 每个方案可在「范围」里固定自己的端口（`profile.local_proxy_port`，0 = 自动）。不给 UI 的话，除 catch-all 以外的方案每次启动都拿到随机端口，客户端配置每次重启即失效——而端口在本后端里就是方案选择器，等于方案不可寻址。
- **QUIC 阻断不适用**：需要 nftables filter chain，UI 置灰该开关而不是留一个静默无效的勾选。
- **`privileged_required: false`**：这是阻止 UI 索要无用 sudo 密码的关键。前端 `needsElevationPassword` 也改为以该能力为准，不再硬编码 `platform === "linux"`——原实现会因 `isRootRequiredError()` 命中 `"permission to manage cgroup v2"` 而陷入永远无法成功的密码框循环。

`capture_mode`（`auto` / `transparent` / `localProxy`，默认 `auto`）控制选择；`auto` 回退时报 `Degraded` 并附上探针给出的具体原因，`transparent` 保留原始错误以便诊断权限问题。恢复路径在探针判定不支持时跳过 nft/cgroup 清理并返回 `Ok`——此环境下本 build 从未、也不可能装上那张表，而查询它只会返回 `Operation not permitted`，否则引擎会永久卡在 `RecoveryRequired`。

若确实需要全局透明捕获，须由部署侧提供，应用内无法解决：Kubernetes `securityContext.capabilities.add: ["NET_ADMIN"]`（或 docker `--cap-add=NET_ADMIN`）+ 挂载 cgroup v2（`--cgroupns=private`，宿主为 unified hierarchy）。

### 验证记录（容器）

- 实测环境：Kubernetes Pod、Ubuntu 22.04.5、uid 1000、`CapBnd=0xa80425fb`（bit 12 = 0）、`/sys/fs/cgroup` 为 cgroup v1 且子挂载 `ro`、无 `/dev/net/tun`、`unshare -Ur --net` 返回 EPERM。`sudo -n id` 返回 uid 0，但 `sudo -n nft list tables` 仍然 `Operation not permitted`——证明阻塞点是 bounding set 而非密码。
- 探针在该环境输出：`cgroup v2 未挂载; CAP_NET_ADMIN 不在 bounding set`，与实测一致。
- `cargo test --lib sockscap`：192 passed。含**零特权端到端用例**：真实 SOCKS5 与 HTTP-CONNECT 客户端经 ingress → 策略 → direct egress 打到本地 echo server 并完成数据往返；固定端口 Stop 后可重新绑定；被占用的固定端口如实报错而不静默改端口；自环端口被拒且已绑定的监听器回滚释放；端口归属的方案独占策略评估。
- `cargo test --lib`：1179 passed / 2 failed，两个失败为既有的 `agent::capture::exec_b::tests::local_run_captures_output` 与 `mail::tests::cache_roundtrips_folders_messages_and_body`，与本次改动无关（已在 stash 后的干净树上复现确认）。
- `sockscap::capture::tests::this_environment_never_advertises_elevation_it_cannot_use` 直接对**运行测试的这台机器**断言：报 `privileged_required` 时必须真的支持透明捕获，否则运行后端必须是 `local-proxy` 且 `global_tcp`/`app_filter` 均为 false。在本容器里走的是后一支。
- `pnpm test`：231 files / 1976 tests passed。`pnpm build`：通过。
- 本机 `cargo` 全量编译需临时 patch 掉 `xcap`（Ubuntu 22.04 的 pipewire 0.3.48 头文件不满足 `libspa 0.9.2`，属既有环境限制，与 sockscap 无关）。该 patch 通过 `--config 'patch.crates-io.xcap.path=...'` 传入，指向一个只满足类型检查的本地 stub；`Cargo.lock` 会被 cargo 顺带改写（删掉 xcap 及其 pipewire/drm/wayland 传递依赖），**必须在提交前 `git checkout -- src-tauri/Cargo.lock` 还原**，否则 CI 的 `--locked` 构建和其他平台会缺依赖。

### 尚未完成（需要相应环境）

- 浏览器 UI smoke（`TC-auto-F-Sockscap-1`）需要先手动起服务，qa-ui-auto 流程明确不自动拉起：`DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev`（:5000），再跑该用例。
- 真实上游下的 Active / 域名与字节计数 / Stop / Recover 复核，以及 `CAP_NET_ADMIN` + cgroup v2 环境的透明捕获流量验证，都要换环境做；本容器不具备条件。
