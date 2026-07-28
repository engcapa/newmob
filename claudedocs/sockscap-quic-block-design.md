# SocksCap QUIC (UDP 443) 拦截设计

> 状态：设计中（未实现）。本文档随三端讨论持续更新。
> 背景：sockscap global+gfwlist 下访问 chatgpt.com 报"超出国家允许列表"，
> 而 Chrome 直接设代理正常。根因分析见文末「根因背景」。本条为四条泄漏
> 路径中最贴近根因、性价比最高的一条。

## 1. 目标与原理

浏览器拿到 Cloudflare 的 `alt-svc` 后升级到 HTTP/3（UDP 443）。这些 UDP 包当前
完全不进捕获层（Windows `NETWORK_FILTER = "tcp and outbound"`），带着真实中国 IP
直出 → OpenAI 判定 CN。

原理：**丢弃 in-scope 流的出站 UDP 443 握手包**。浏览器 QUIC 握手拿不到响应，
几次超时后把该源标记为 broken，回退 TCP —— 而 TCP 路径已能按 SNI/GFWList 走代理。
这正是 netch 等工具的做法。我们**不代理 UDP**（把 UDP association 塞进 SOCKS5
反射机制不现实），只是让它"哑火"以触发回退。

## 2. 核心洞察（让改动很小的关键）

**"SocksCap 会用 TCP 代理的流" 恰好等于 "我们要杀掉其 QUIC 的流"。**
所以现有 `classify_flow` 的两个结果可直接复用，只是对 UDP 443 换执行动作：

| classify_flow 结果 | TCP 路径（现状） | UDP 443 路径（新增） |
|---|---|---|
| `Redirect`（会捕获） | 反射到 relay | **DROP**（不 send，逼 TCP 回退） |
| `Bypass`（放行）    | 原样转发     | **PASS**（原样转发） |

一个 SocksCap 本来就要直连放行的流（LAN、被 bypass 的上游 core、App 模式下不在
范围的进程），它的 QUIC 也必须原样放行 —— 语义天然一致。

## 3. 已锁定的产品取舍

- **默认开启**（`block_quic` 默认 true）。副作用：global 模式下机器上所有
  in-scope 应用的 QUIC 都降级 TCP；需在 UI 明确告知并可关闭。
- **会话级开关**（放 `SocksCapConfig` 顶层，非 per-profile）。单 WinDivert
  handle / 单 relay 模型不变，过滤器是否加宽只看这一个布尔，无并集逻辑。
- **仅 UDP 443**。基串固定 `outbound and (tcp or (udp and udp.DstPort == 443))`，
  不做端口集合参数化。UDP 80 上的 h3 浏览器几乎不用。

## 4. 配置项与传递链路（Windows，5 跳）

新增会话级布尔，沿现有链路透传，全程只多一个字段：

1. `config.rs`：`SocksCapConfig` 加 `#[serde(default = "default_true")] block_quic: bool`
   （复用已有 `default_true`；旧配置无此字段也得 true，老用户升级即生效，无需迁移）。
   `SocksCapConfig::Default` 显式设 true。
2. `helper.rs`：`CaptureStartArgs` 加 `block_quic: bool`；`capture_start()` 的 json
   body 加 `"blockQuic": args.block_quic`。
3. `mod.rs`（构造 `CaptureStartArgs` 处，~1345 行）：`block_quic: cfg.block_quic`。
4. `sockscap-helper/main.rs`：`Request` 加
   `#[serde(default, rename="blockQuic")] block_quic: Option<bool>`；`capture_start`
   分支构造 `CapturePlan` 时填入。
5. `capture.rs`：`CapturePlan` 加 `block_quic: bool`。

## 5. 过滤器变更（开 handle 时决定，关时零成本）

WinDivert 过滤器在 live handle 上不可变，所以 `block_quic` 必须在 `start()` 时已知：

- **关闭时**：过滤器与行为与现状逐字节一致（`"tcp and outbound"` + CIDR 排除），
  零开销、零风险 —— 安全回归基线。
- **开启时**：`build_network_filter` 基串改为
  `outbound and (tcp or (udp and udp.DstPort == 443))`，后面照旧 append 每条
  `and not (ip.DstAddr >= lo and <= hi)`（CIDR 排除对 UDP 同样按 DstAddr 生效）。
  fallback 串同样带 UDP 443 从句。

这样内核就把 in-scope 之外的本地/私网 UDP 443 挡在 loop 外，减少 kernel↔user 穿越。

## 6. 包处理路径（插入点极干净）

现在 UDP 包过不了 `parse_ip_tcp`（proto 17≠6），落到 else 分支直接转发：

```rust
let Some(tcp) = parse_ip_tcp(pkt) else {
    let _ = api.send(handle, pkt, &addr);   // ← UDP 当前从这里原样放行
    continue;
};
```

改为在该 else 内加 UDP 443 处理（TCP 热路径一字不动）：

```
若 plan.block_quic 且 outbound 且 是 UDP 且 dport==443:
    key=(src,sport)
    verdict = udp_verdicts 命中(校验 dst) ? 命中 : classify_flow_udp(...)（写缓存）
    if Redirect => continue（不 send = DROP，可选累加 quic_dropped 计数）
    else        => api.send(...)（PASS）
    continue
否则：api.send(...)（原样，非 UDP443 或未开启）
```

- DROP = 不 send，无需 checksum。
- PASS = 原样 send，从不改写 UDP 包，无需 recalc。
- 绝不反射 UDP，无 relay 回环风险。

## 7. 归属（谁拥有此 UDP 流）与默认值

关键正确性点：**绝不能误杀被 bypass 的上游自身 UDP**（最典型：WireGuard 经
xray-core 走 UDP 出节点；xray 进程已在 `bypass_pids`/`bypass_paths`）。所以 UDP 443
也要做 per-flow 归属。

- 新增 `proc_info.rs::udp_owner_pid(local, sport)`，用
  `GetExtendedUdpTable`（`MIB_UDP(6)TABLE_OWNER_PID`），带 100ms 缓存 + miss 强制
  重读一次，完全复刻现有 `tcp_owner_pid`。
  - UDP 优势：socket 在首个数据报前已 bind 并进表，归属比 TCP SYN 竞争更可靠。
- `classify_flow_udp` 复用 `classify_flow` 判定骨架（bypass_cidrs/endpoints/pid/path、
  loopback、App 范围匹配），仅把 `tcp_owner_pid` 换 `udp_owner_pid`、App 模式的
  `app_index.ports` 换成新增的 `app_index.udp_ports`。

未归属时的默认（与现有 TCP 语义严格对齐）：
- **Global**：一切默认 in-scope → 查 bypass 后 DROP（正确，上游 core 由 pid/path 保护）。
- **App**：未归属默认 Bypass/PASS（"别动不确定是否在范围内的流"，对齐 capture.rs:1228）。

## 8. App 模式：仅影响 in-scope app，不误伤其它 app

App 模式下过滤器加宽与 drop 决策是**两回事**：

- 过滤器加宽只决定"哪些包**进** divert loop"（全机出站 UDP 443 都进）。
- 是否 **DROP** 由 `classify_flow_udp` 逐流判定：

```
App 模式:
  sport 命中 in-scope app 的 udp 端口表  → Redirect → DROP（逼回退）
  否则 resolve_flow 得 pid，不在范围     → Bypass  → PASS（QUIC 照常）
  归属失败                              → Bypass  → PASS（安全默认）
```

**结论：只有 profile 选中的 app 被强制回退 TCP；其它 app 的 UDP 443 原样放行，
QUIC 照常工作。** 与现有 TCP 的 App 模式语义一致（capture.rs:1228 "leave
App-mode traffic alone"）。

失败方向安全：若 UDP 归属实现有缺陷，最坏是 in-scope app 的 QUIC **漏杀**（泄漏
回来），而 out-of-scope app 始终 PASS —— 是"漏杀"而非"误杀"。

代价（性能，会话级）：因单一 handle，开启后全机出站 UDP 443 都进 loop 被分类一次
（今天 UDP 根本不进 loop）。out-of-scope app 的 QUIC 仍可用，但每个 UDP 443 包多走
一趟"进 loop → 判 Bypass → 原样 send"。缓解：`bypass_cidrs` 在内核层排除本地/私网；
`udp_verdicts` 每流只分类一次，之后是哈希查找 + send。净效应：功能不受影响，
out-of-scope QUIC 有少量额外 CPU/转发开销。

**前提依赖（务必实现，App 模式尤甚）**：上面"只杀 in-scope"依赖
`app_index.udp_ports` + `udp_owner_pid`。`compute_app_index` 现仅调
`port_owners_for_pids`(TCP)，需加 UDP 版 `udp_port_owners_for_pids` 填充
`udp_ports`；否则 in-scope app 的 QUIC 会因查不到端口归属而落到"App 默认 PASS"
→ 泄漏（但仍不误伤其它 app）。

## 9. 决策缓存与生命周期

- 新增独立 `udp_verdicts: FlowTable`（**不与 TCP 的 `redirects` 共用**，否则
  (ip,port) 键会 TCP/UDP 撞车）。复用 `FlowTable` 现成 TTL、sweep、容量上限、
  dst 重校验。
- UDP 无 SYN/FIN/RST：生命周期靠 idle TTL sweep；不需要 peer_index/sport_index
  （UDP 不反射）。
- 缓存意义：QUIC 一条连接很多数据报，缓存 drop 决策避免每数据报都查表。回退成功后
  浏览器停发 UDP 443，负载自动收敛到接近 0。

## 10. 边界与风险

- 误杀上游 QUIC（WG）：靠 pid/path 归属保护；xray 是 bundled，pid+path 都在 bypass。✅
- in-scope 应用无 TCP 回退（罕见纯 QUIC RPC 客户端）：会被打断 —— QUIC 拦截固有
  代价，故做成开关。global 下影响机器上所有 in-scope QUIC 应用（都降级 TCP）。
- IPv6 扩展头：简易解析器遇扩展头 bail → 该包 PASS（安全侧，罕见），需注释。
- alt-svc 指定非 443 端口：极少见，本设计不覆盖；可后续把端口集合配置化。
- 与 ECH 的协同：QUIC 被堵回退 TCP 后，TCP 上仍可能因 ECH 抽不出 SNI 命中 miss。
  本条消除 QUIC 泄漏，但彻底解决 chatgpt 还需配合 default_action/GFWList/ECH 兜底。
- 性能：稳态开销低（QUIC 收敛后 UDP 443 趋零）；瞬时突发是"每 100ms 一次 UDP 表读
  + 每流一次分类"，与 TCP 同量级。

## 11. 本条能修 / 不能修

- ✅ 修掉 QUIC/UDP 443 泄漏（泄漏路径排序第 1 的最可能主因）。
- ❌ 不动 DNS/53 泄漏、不改 default_action、不补 ECH/GFWList（独立的其余三条）。

## 12. 三端设计

`block_quic` 是会话级配置（§3），三端共享同一语义与默认值（默认开启）。各端"让
UDP 443 哑火"的等价实现不同：Windows 用户态逐包 drop，Linux 内核 nftables drop，
macOS 待办。**Windows 与 Linux 均按完整实现设计；macOS 留待办，但实现其余两端时
须在 macOS 捕获代码中留下显式 TODO 标记（见 §12.3），不仅写在文档里。**

### 12.1 Windows（完整实现）

见上文 §4–§11、§13–§14，已定稿。要点：单一 WinDivert handle，过滤器按 `block_quic`
加宽到 `outbound and (tcp or (udp and udp.DstPort==443))`，用户态 `classify_flow_udp`
逐流判定 DROP/PASS，`udp_verdicts` 缓存 + `udp_owner_pid`/`app_index.udp_ports` 归属。

### 12.2 Linux（完整实现）

Linux 捕获是 **nftables nat hook + cgroup v2 归属**：`table inet taomni_sockscap` 的
`output` 链（`type nat hook output priority dstnat`）把 in-scope 的 **TCP** OUTPUT
重定向到 loopback relay；scope 由 cgroup 决定 —— global 模式把 Taomni 自身（及其子
进程，含 bundled xray）移入 `bypass` cgroup、其余全机重定向；app 模式仅把选中 PID
移入 `capture-profile-N` cgroup，子进程继承。

**QUIC drop 用同表新增一条 filter 链**（nat 类型链不能可靠 `drop`，必须用 filter
hook）。同表 → 与 redirect 链原子安装/移除，复用现有 Recover、ownership marker、
`RedirectPlan` 校验，无新增 teardown。

global 模式渲染（`block_quic=true` 时追加）：

```
chain quic_block {
  type filter hook output priority filter; policy accept;
  ip daddr 127.0.0.0/8 return
  ip6 daddr ::1/128 return
  <每条 bypass_cidr> return
  <bypass cgroup> return          # 与 redirect 链同一个 bypass cgroup
  udp dport 443 drop              # 其余 in-scope 一律丢弃
}
```

app 模式渲染（**仅对 capture cgroup 丢弃 → 其它 app 的 QUIC 原样放行**）：

```
chain quic_block {
  type filter hook output priority filter; policy accept;
  ip daddr 127.0.0.0/8 return
  ip6 daddr ::1/128 return
  <每条 bypass_cidr> return
  <capture cgroup 0> udp dport 443 drop
  <capture cgroup 1> udp dport 443 drop
  ...
}
```

**上游保护对等性**：quic_block 链在 drop 前放置与 redirect 链**完全相同**的
loopback / bypass_cidr / bypass-cgroup return。任何已被 TCP redirect 回环保护的
egress（Taomni 自身 + 其子 xray core、loopback 上的本地代理端口）同样被 UDP drop
保护 —— QUIC 拦截**不引入新的绕过面**。需验证：bundled xray（WireGuard 上游）作为
Taomni 子进程运行，从而继承 global 模式的 bypass cgroup；若成立，则 WG 的 UDP 出节点
天然放行。

**为何比 Windows 简单**：cgroup 匹配在内核层天然给出"仅 in-scope"，无需用户态逐包
分类、无 verdict 缓存、无 UDP owner 表。relay **完全不经手 UDP**（内核直接 drop），
Linux 侧无 relay/用户态改动。

**hook 顺序**：nat dstnat（prio dstnat，先）→ filter（prio filter，后）。TCP in-scope
包在 nat 阶段被 redirect 到 relay（dport 改成 relay_port），到 filter 链时既非 UDP
也非 443，不匹配 drop；UDP 443 包在 nat 阶段无匹配（redirect 仅 TCP）原样通过，到
filter 链被 drop。`inet` 表下 `udp dport 443` 同时匹配 v4/v6，无需 loopback listener
依赖，两族都可 drop。

**生命周期**：quic_block 与 output 链同处 `inet taomni_sockscap` 表 → 原子安装/移除；
`delete table` 一并清除；ownership marker 复用。无新增 teardown。

**Linux 传递链路（3 处）**：
1. `config.rs`：`block_quic`（会话级，三端共享，已在 §4 定义）。
2. `capture/linux/tunnel.rs`：`RedirectPlan` 加 `block_quic: bool`；`render_nft_script`
   在 true 时追加 quic_block 链（global/app 两种渲染分支）；`validate` 不变。
3. `capture/linux/mod.rs`：`start()` 构造 `RedirectPlan::new` / `new_app_routes` 时
   传入 `config.block_quic`。

**Linux 测试**：render 单测 —— global 在 bypass returns 之后 emit `udp dport 443 drop`；
app 对每个 capture cgroup emit `<cgroup> udp dport 443 drop` 且**不** emit 裸 drop
（保证不误伤 out-of-scope app）；`block_quic=false` 不 emit quic_block 链（回归：与今
逐字一致）；`ValidatedCidr` 注入防护对新链同样有效（复用现有渲染）。

### 12.3 macOS（留待办 — 须在代码中留 TODO）

macOS 有两种 backend：**system-proxy**（设置系统 SOCKS/HTTP 代理）与**透明 NE**
（Network Extension）。两者当前都不处理 QUIC：

- **system-proxy**：设 SOCKS 代理不捕获 UDP，QUIC 直接泄漏。要堵需额外 pf 规则或走 NE。
- **透明 NE**：`NEPacketTunnelProvider` 理论上能看到 UDP 443 并 drop，但现有 macOS
  透明 ingress 读的是 SOCKS5 / HTTP CONNECT 握手（TCP），UDP 路径未建。

**决策：本期不实现 macOS QUIC 拦截。** 但**硬性要求**：实现 Windows/Linux 时，须在
macOS 捕获代码中留下显式代码 TODO 标记（不仅写文档），标注 `block_quic` 在 macOS 的
接入点，便于后续实现：

- `src-tauri/src/sockscap/capture/macos/mod.rs`、`transparent.rs`、`system_proxy.rs`
  中，在各 backend 构建捕获/ingress 的自然插入点，加
  `// TODO(sockscap-quic): block UDP 443 to force QUIC→TCP fallback (see claudedocs/sockscap-quic-block-design.md §12.3); block_quic is session-level in SocksCapConfig`。
- 若 macOS 侧读取/透传 `SocksCapConfig` 的路径上有等价于 Windows `CapturePlan` /
  Linux `RedirectPlan` 的结构，在其旁标注 `block_quic` 尚未接入。

### 12.4 跨端一致性

- `block_quic` 语义、默认值（true）、UI 呈现三端统一（配置字段共享）。
- 三端"drop UDP 443"的 in-scope 判定都对齐各自的 TCP 捕获 scope：Windows =
  `classify_flow` 的 Redirect 集；Linux = redirect 的 cgroup 集；macOS 待办。
- 失败方向一致：宁"漏杀"（QUIC 泄漏回来）不"误杀"（打断无关 app）。

## 13. 测试（Windows）

- 单元：`build_network_filter(block_quic=true)` 串含 `udp.DstPort == 443` 且 CIDR
  排除仍在；`=false` 时与 `NETWORK_FILTER` 逐字相等（回归安全）。`classify_flow_udp`
  的 global-default-drop / app-default-pass / bypass-pid-pass。UDP 表行解析
  （v4 / v6，端口网络序）。
  - 注意：现有单测 `network_filter_without_bypasses_is_the_base_filter` 断言
    `build_network_filter(&[]) == NETWORK_FILTER`，加 `block_quic` 参数后需同步更新。
- 手动：开 sockscap global+gfwlist + block_quic，Chrome 开 ChatGPT 不再报国家限制；
  `chrome://net-export` 确认 h3 broken 回退 h2；确认 WG 上游仍连通。

## 14. 改动清单（Windows，7 处，供 review 范围）

| 文件 | 改动 | 风险 |
|---|---|---|
| `config.rs` | `block_quic` 字段(默认 true) + Default | 低（serde 兼容已考虑） |
| `helper.rs` | `CaptureStartArgs` 加字段 + `capture_start` json body 加 `blockQuic` | 低 |
| `mod.rs` | 构造 args 处填 `cfg.block_quic` | 低 |
| `sockscap-helper/main.rs` | `Request` 加 `blockQuic` + 填入 `CapturePlan` | 低 |
| `capture.rs` | `CapturePlan` 加字段；`build_network_filter` 按 flag 加宽；`network_loop` UDP else 分支加分类/drop；新增 `udp_verdicts` + `classify_flow_udp` + `app_index.udp_ports` | 中（热路径+新分类，TCP 路径不动） |
| `proc_info.rs` | 新增 `udp_owner_pid` / UDP 表读取 + `udp_port_owners_for_pids`（复刻 TCP 结构） | 低-中 |
| 前端 sockscap 设置 UI + i18n | 开关 + 副作用说明文案 | 低 |

## 根因背景（four leak paths，按可能性排序）

Chrome 设 SOCKS5 = 全量 + 远程 DNS，无泄漏；sockscap global+gfwlist = 按
"TCP + 命中域名 + 能识别 SNI" 三重漏斗过滤，漏出的走 Direct 带真实 IP：

1. **QUIC/HTTP3 走 UDP 443 未被捕获**（本文档，最可能主因）。
2. **ECH 让 SNI 抽不出 → GFWList miss → Direct**（`sni.rs` 不解析 ECH；
   `policy.rs:234` 无 hostname 落 default_action）。
3. **default_action 默认 Direct**（`config.rs`：miss/无 host → 真实 IP 直连）。
4. **DNS 不走代理**（`dns_win.rs` 仅读本地 DNS 缓存做反查，浏览器仍用国内解析器）。

## 15. 实现进展（截至本次）

已实现 Windows + Linux 完整方案 + macOS 代码 TODO；前端开关未完成；整体构建/测试未跑。

**已完成**
- `config.rs`：`SocksCapConfig.block_quic`（`#[serde(default="default_true")]`）+ Default
  显式 true + 单测（`block_quic_defaults_on_for_configs_without_the_field`：旧配置无字段
  也 true、显式 false 被尊重）。
- Windows（**已 `cargo check --bin sockscap-helper` 通过**，仅 pre-existing 警告）：
  - `proc_info.rs`：`GetExtendedUdpTable` FFI + `list_udp_owner_rows`（v4 12B / v6 28B）
    + `udp_owner_rows_cached`（独立 `UDP_TABLE_CACHE`）+ `udp_owner_pid` + `udp_port_owners_for_pids`。
  - `capture.rs`：`CapturePlan.block_quic`；`NETWORK_FILTER_WITH_QUIC` +
    `base_network_filter()`；`build_network_filter(cidrs, block_quic)`（签名变了）；
    `AppIndex.udp_ports`（仅 block_quic 时填充）；`CaptureEngine.udp_verdicts` 独立
    `FlowTable`（start 传入 network_loop / clear_tables / 收口）；network_loop 的
    `parse_ip_tcp` else 分支加 UDP443 drop；`udp_should_drop` + `classify_flow_udp`
    （UDP 用 `udp_owner_pid`，**不**走 TCP 的 flows 图）；`parse_ip_udp`/`UdpMeta`；
    新增单测（filter widen、udp443 解析、base 回归）。
  - `main.rs`：`Request.blockQuic` + 填 `CapturePlan.block_quic`。
  - `helper.rs`：`CaptureStartArgs.block_quic` + `capture_start` json `"blockQuic"`。
  - `mod.rs`：构造 args 处 `block_quic: cfg.block_quic`。
- Linux：`tunnel.rs`：`RedirectPlan.block_quic`；两个构造器加参（`new` +7 参、
  `new_app_routes` +4 参）；`render_quic_block_chain`（同表 filter hook 链，global=
  bypass returns 后 `udp dport 443 drop`，app=每 capture cgroup 各一条 drop）；4 个新
  render 单测（off 无链回归、global drop 在 bypass 后、app 仅按 cgroup）。`mod.rs`：两处
  调用传 `config.block_quic`。
- macOS：`capture/macos/{mod.rs,transparent.rs,system_proxy.rs}` 各留
  `// TODO(sockscap-quic): ...` 标记（引用本文档 §12.3），未实现。
- 前端：`src/lib/sockscap.ts` `SocksCapConfig.blockQuic: boolean` 字段已加。

**前端（已完成）**
- `src/lib/sockscap.ts`：`SocksCapConfig.blockQuic`。
- `SocksCapPanel.tsx`：DEFAULT config `blockQuic: true`；GFWList Section 末尾加会话级
  开关（`data-testid="sockscap-block-quic"`，`checked={cfg.blockQuic ?? true}`，
  `locked||busy` 时禁用，`persistConfig({...cfg, blockQuic})`）。
- i18n：`en.ts`/`zh-CN.ts` `sockscap.blockQuic` + `sockscap.blockQuicHint`。
- `stubs/tauri-core.ts`：dev-mode config 加 `blockQuic: true`。
- 三处测试 fixture（SocksCapPanel.test / sockscapPreflight.test / sockscapRestart.test）
  补 `blockQuic: true`。

**验证结果**
- `cargo test --bin sockscap-helper`：**26 passed, 0 failed**（含新增
  `network_filter_widens_to_udp_443_when_blocking_quic`、`parses_udp_443_from_ipv4`、
  base-filter 回归）。
- `cargo test --lib sockscap::config`：**7 passed**（含 block_quic 默认值 2 例）。
- `npx tsc --noEmit`：**0 error**。
- `vitest` sockscap 三套件：**37 passed**。

**唯一 caveat**
- Linux `tunnel.rs`/`mod.rs` 改动是 `cfg(target_os="linux")` 门控，**本 Windows 主机
  编译器未覆盖**；改动是机械式（加 bool 字段 + 构造器参数 + 一个镜像现有模式的
  render 函数），并已加 4 个 Linux-only render 单测（`no_quic_block_chain_when_block_quic_is_off`
  / `global_quic_block_drops_after_bypass_returns` / `app_quic_block_drops_only_per_capture_cgroup`
  + 现有测试签名更新），需 Linux/CI 编译运行确认。

## 16. bypass 语义确认（对话结论，实现依据）

- 用户可配的 bypass 只有 `bypass_cidrs`；`bypass_pids`/`bypass_paths`/`bypass_endpoints`
  是**内部**的（self、xray cores、本地代理进程、上游 endpoint、relay 端口），在
  `mod.rs` 构造。无面向用户的"bypass 应用"清单。
- **不变量**：各端"drop QUIC 的流集合" == "TCP 捕获(Redirect/redirect)的流集合"。被
  bypass 的应用其 QUIC 不受影响。Windows `classify_flow_udp` 复刻了 `classify_flow`
  的全部 bypass 判定（endpoints/cidrs/loopback/pid/path/app-scope）；Linux quic_block
  链复刻 redirect 链的 loopback/cidr/bypass-cgroup returns。
- **Linux 已知局限（继承自 TCP，非本功能引入）**：`mod.rs:796-799` 注明"Linux 上把
  xray 子进程排除出 taomni cgroup 是后续项"。故 Linux global 模式下，若上游用 **UDP 443
  传输**（如经 xray 的 WireGuard/hysteria）且 xray 未在 bypass cgroup，则其 UDP 出节点
  会被 quic_block 误杀 —— 但这与 TCP redirect 回环是同一个未决问题，QUIC 拦截**不新增**
  绕过面。多数上游对节点用 TCP（HTTP/SOCKS/SSH/多数 xray），不受影响。
- **capture-but-direct 权衡**：global 模式下即使目标经策略判为 Direct（.cn/GFWList
  miss），其 QUIC 仍被 drop → 回退 TCP 直连（功能对，仅 QUIC 降级 TCP）。要豁免需在 UDP
  时就知道 per-dest 决策（QUIC SNI 解析），本期不做。
