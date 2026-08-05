# Claude Code 数据库会话工具

> 状态：SQL 与 Redis MCP 工具已实现并接入会话绑定。本文记录当前设计、安全约束和仍需原生环境验证的边界。

## 目标

当 Claude Code 对话绑定到 Taomni 的数据库会话时，模型通过 Taomni 后端提供的 MCP 工具操作该连接，而不是获得数据库凭据、拼接本机 CLI 命令或访问其他会话。每个工具调用都再次校验线程、绑定会话和权限。

## 会话 flavor

MCP bridge 根据绑定会话选择互斥的工具集：

- `Shell`：终端、文件和进程工具。
- `Sql`：MySQL、PostgreSQL、SQL Server、Oracle、SQLite、DuckDB、Presto 等统一数据库工具。
- `Redis`：键扫描、值读取和 Redis 命令工具。

HBase 使用独立 shell/协议模型，不伪装成 SQL flavor。身份卡在 Claude Code 进程创建时生成，说明当前绑定、可用工具和安全规则；绑定改变时应新建/重启对应进程，不能让旧进程跨会话复用权限。

## SQL 工具

SQL handler 复用 `src-tauri/src/database/` 的连接与驱动实现，提供：

- schema/catalog/table/view/index/object 枚举与表结构描述。
- `run_sql`：返回有界的行内结果。
- `run_sql_captured`：完整结果捕获到后端管理文件，只向模型返回摘要和少量预览。
- `read_result`：对捕获的 CSV 执行 `head/tail/range/grep/stats`，每次输出仍有上限。
- `export_result`：经确认后导出到用户下载目录的 `taomni-exports`；当前格式为 CSV。
- 查询取消和连接生命周期清理。

大结果优先捕获、检索、再导出，不能反复重跑查询来读取不同片段。捕获文件及 token 只对创建它的线程/绑定作用域有效。

## Redis 工具

Redis handler 提供分页 `SCAN`、读取键值以及受控的原生命令执行。只读命令可按会话策略自动放行；`SET`、`DEL`、`FLUSH*` 等写入或破坏性命令必须进入确认流程。空命令或不能可靠分类的命令按写操作处理。

## 权限与数据边界

- MCP URL 中的随机 token 只用于定位进程，后端还必须核对 thread、session 和 flavor。
- 后端按已保存的 session id 打开连接；工具参数不能覆盖 host、port、username、password、Vault ref 或 driver options。
- SQL 分类器采用保守策略：只有可靠识别为只读的语句才免确认；多语句、DDL、DML、存储过程和未知语法按写操作处理。
- Redis 同样使用保守的只读命令白名单。
- 写 SQL、Redis 写命令、文件导出等副作用进入 HITL 确认卡；`disableAiWrite` 必须在后端生效。
- 错误、身份卡和 MCP 返回值不得包含密码、连接串秘密或 Vault 内容。
- 所有列表、查询、grep 和预览结果都有界，避免把数据库内容无上限送入模型上下文。

## 关键实现

- MCP HTTP/作用域：`src-tauri/src/agent/cc_bridge/mcp_http.rs`
- SQL 工具：`src-tauri/src/agent/cc_bridge/mcp_sql.rs`
- Redis 工具：`src-tauri/src/agent/cc_bridge/mcp_redis.rs`
- 会话身份卡：`src-tauri/src/agent/cc_bridge/session_card.rs`
- SQL 分类：`src-tauri/src/agent/sql_classify.rs`
- 权限策略：`src-tauri/src/agent/safety.rs`
- 数据库驱动：`src-tauri/src/database/`

## 已知边界

- `export_result` 当前只支持 CSV。
- 捕获结果是后端受管的临时/缓存数据，不是长期备份格式；应用退出和清理策略必须可预测。
- 身份卡是进程启动时快照，不代表持续刷新的 schema 或运行时 cwd。
- 各数据库对 catalog/schema、取消和类型序列化的支持不同，统一工具需要返回明确的能力差异。
- 浏览器 stub 可验证交互，不等同于真实数据库、Claude Code CLI 和 Tauri IPC 的原生证据。

## 验证

单元/集成测试至少覆盖：

- flavor 选择和跨线程、跨会话、错 token 拒绝。
- SQL 只读/写入/多语句分类及 `disableAiWrite`。
- Redis 只读白名单与未知命令的保守确认。
- 各 SQL 驱动的 schema 工具、结果上限、捕获、检索、CSV 转义和取消。
- 捕获 id 猜测、路径穿越、过期文件和跨线程读取失败。
- 身份卡脱敏，不包含秘密或其他会话信息。
- 原生 UI 中的绑定、确认、取消、错误恢复和大结果导出。

浏览器自动化用例位于 `qa-ui-auto-tests/`；真实数据库和真实 Claude Code CLI 的冒烟结果应作为发布证据保存，而不是写成永久“已验证”结论。
