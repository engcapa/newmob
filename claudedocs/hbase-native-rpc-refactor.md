# HBase 原生 RPC 客户端架构

> 状态：原生 RPC 已是默认传输；REST/Stargate 作为显式兼容后端保留。本文描述当前协议边界和维护要求，不再记录移植阶段。

## 目标

Taomni 在不启动 JVM、`hbase shell` 或辅助进程的前提下连接 HBase。原生模式通过 ZooKeeper 定位集群，直接使用 RegionServer/Master RPC；REST 模式仅用于明确配置了 Stargate/兼容网关的环境。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `native/proto.rs` | HBase protobuf 类型 |
| `native/rpc/codec.rs` | 长度前缀、protobuf header 和 CellBlock 帧 |
| `native/rpc/conn.rs` | TCP 连接 actor、call-id 多路复用和超时 |
| `native/auth.rs` | simple 认证和 Kerberos/GSSAPI 协商 |
| `native/cell.rs` | KeyValueCodec CellBlock 编解码 |
| `native/zk.rs` | ZooKeeper znode bootstrap |
| `native/region.rs` | RegionInfo、meta row 和 region 比较 |
| `native/client.rs` | region 定位/cache、重试、scan 以及数据/管理操作 |
| `hbase/mod.rs` | 会话配置、传输选择和 shell 命令映射 |

## 连接流程

1. 从 `zkQuorum`（或单节点 host 兼容配置）连接 ZooKeeper，并应用 `zkRoot`。
2. 读取 meta region/master 信息，解析带 PBUF magic 的 znode 数据。
3. 建立 HBase RPC TCP 连接并发送 `HBas` preamble。
4. simple 使用认证字节 `0x50`；Kerberos 使用 `0x51` 完成 SASL/GSSAPI token 交换。
5. 写入 `ConnectionHeader`，之后用 call-id 关联并发请求与响应。
6. 通过 `hbase:meta` 定位用户 row 所属 region，并缓存定位结果。
7. 遇到可恢复的 stale region/NotServingRegion 类错误时失效缓存并做有界重试。

所有网络读取必须有长度上限和超时；未知 call-id、非法负长度、超大 frame、截断 protobuf 或 CellBlock 都应终止对应连接，而不是继续失步解析。

## 数据面

当前原生客户端支持：

- `get`、`put`、`delete`、`deleteall`
- 跨 region `scan`、scanner open/next/close
- `list`、`describe`、`create`、`drop`
- `enable`、`disable`、`alter`
- cluster `status` 与连接 `ping`

Cell 值按 HBase KeyValue 二进制布局解析，前端表格使用扁平化的 row/family/qualifier/value/timestamp 结果。扫描必须保持分页和行数上限，不能把无界表一次性载入内存。

## 认证与配置

`HBaseConfig` 可从界面字段或 `hbase-site.xml` 补全 ZooKeeper quorum、znode parent、service principal 等参数。Kerberos 可结合 principal、keytab 和 `krb5.conf`，凭据/路径由现有会话与 Vault 规则管理。

Cargo 的默认 feature 当前包含 `hbase-kerberos`。如果某个目标平台无法提供对应 GSSAPI/Kerberos 构建依赖，应在该平台构建矩阵中明确处理，不能在文档中假设默认关闭。

simple 认证只适用于集群允许的环境；它不是对不可信网络的加密层。TLS、网络隧道和企业 Kerberos 策略由部署环境决定。

## REST 兼容后端

REST/Stargate 保留用于已有网关的集群，支持常用数据操作和有限管理命令。它与原生 RPC 使用同一前端 shell 入口，但能力并不完全等价；REST 不支持的 admin 操作必须返回清晰错误，不能伪装成功。

## 验证策略

- codec/protobuf/CellBlock 使用固定向量和畸形帧单元测试。
- region comparator、meta row 解析、namespace/table 规范化使用纯函数测试。
- simple/Kerberos 握手、超时、断线和缓存失效需要协议级测试。
- shell parser 与 native/REST 命令分派必须覆盖同一命令的能力差异。
- 真实集群测试应覆盖单 region、多 region split、空表、大值、并发请求和权限错误。
- Kerberos 测试需要隔离的 KDC/测试 realm，不把 keytab 或票据提交到仓库。

日常 Rust 回归运行 `cd src-tauri && cargo test --lib`；真实 HBase/ZooKeeper/Kerberos 互通属于发布前环境测试。
