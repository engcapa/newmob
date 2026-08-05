# SocksCap Linux 开发计划

**目标**：在 Linux 上提供可恢复的 TCP 透明捕获、按应用过滤、规则/上游 relay、打包与 CI 覆盖；捕获状态只能在内核规则实际安装成功后显示为 Active。

**当前状态**：实现已从不可编译的 stub 收敛为 `nftables OUTPUT NAT + cgroup v2 + SO_ORIGINAL_DST` 后端。纯逻辑与 Linux 单元测试、前端构建、DEB 封包及内容检查已完成；真实特权环境流量验证和已运行 Vite 服务上的 UI 执行仍待完成。

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
- 本机 `nft list tables` 返回 `Operation not permitted`，因此不能在此 runner 做 `CAP_NET_ADMIN` 流量验证；端口 5000/1980 也没有已运行的 Vite/桌面服务，按 UI 自动化流程不自动启动服务。

## 实现偏差与原因

原计划中的 `smoltcp + TUN NAT` 没有继续采用。TUN/smoltcp 自身不会截获宿主机的 TCP OUTPUT；若没有额外的内核 redirect/mark 规则，只会得到一个看似启动、实际不接管流量的实现。当前方案改为 nftables 在内核 OUTPUT NAT hook 做透明重定向，使用 cgroup v2 inode 做进程范围匹配，并由 loopback relay 读取 `SO_ORIGINAL_DST`。

这仍满足 PID 过滤、cgroup、流量决策和可测试抽象层目标，同时避免虚假的 Active 状态。代价是运行时需要管理员批准的 `CAP_NET_ADMIN` 与 cgroup 管理权限；应用会在 preflight 阶段明确失败，而不会自动给 GUI 进程授予 `CAP_SYS_ADMIN`。
