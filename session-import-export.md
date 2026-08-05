# 会话导入与导出

> 状态：已实现功能说明。实现与测试是事实来源；本文不再保留历史阶段、工时估算和已完成清单。

## 目标与边界

会话迁移负责把第三方连接配置规范化为 Taomni 的 `SessionConfig`，先预览、再由用户选择写入。普通文本格式在前端解析；注册表、系统钥匙串、二进制 plist、工具默认目录扫描和受保护凭据等平台能力由 Rust 命令提供。

导入不是第三方客户端的完整兼容层。无法安全还原的字段会产生警告，不会猜测或静默写入错误配置。

## 当前支持范围

### 导入

| 类别 | 来源 |
| --- | --- |
| Taomni | 当前 JSON、兼容旧版 NewMob/Taomni JSON、CSV |
| SSH/终端 | OpenSSH、MobaXterm、Xshell/ZIP、Tabby、WindTerm、iTerm2、Terminal.app、SecureCRT、Exceed |
| 连接管理器 | PuTTY/注册表、PuTTYCM、SuperPuTTY、mRemote/mRemoteNG、Remote Desktop Manager |
| 数据库 | DBeaver、Navicat |
| 代理 | ZeroOmega/SwitchyOmega 固定代理配置 |
| 本地环境 | WSL、外部 Bash 配置 |

部分来源既支持选择文件，也支持扫描当前系统的默认安装位置；实际入口以“设置 → 会话导入/导出”显示为准。

### 导出

| 格式 | 用途 |
| --- | --- |
| Taomni JSON | 完整迁移与备份；带 schema 版本 |
| CSV | 审阅、表格编辑与跨工具转换 |
| MobaXterm | 导出其可表达的连接类型与目录结构 |
| HTML | 生成不含可用凭据的离线清单 |

## 数据流

1. 读取文件或调用平台扫描命令。
2. 解析并标准化类型、端口、认证方式、目录和 `options_json`。
3. 应用大小、条数、字段长度和递归深度限制。
4. 与现有会话比较，处理重名并形成 `sessions / skipped / warnings / secrets`。
5. 在预览界面展示候选项和警告；用户可取消选择。
6. 仅在用户明确允许时，将可恢复的秘密写入 Vault，再批量保存会话。

导入过程不得把密码、私钥内容或解密中间值写入日志。导出默认不包含密码、Vault 引用对应的明文或本地日志路径。

## 凭据策略

- 普通导入只迁移连接元数据。
- “导入已保存凭据”是显式选择；恢复出的秘密进入 Vault，不写入会话 JSON。
- Tabby 可按情况读取其 Vault 或操作系统钥匙串；缺失的凭据会提示重新输入。
- DBeaver 需要同时提供匹配的凭据数据时才可能恢复密码。
- Navicat 仅处理已实现且可验证的密文格式；较新的 `Pwd_2` 不做推测性解密。
- SecureCRT 的受保护配置可能需要用户提供配置口令。
- Termius 不直接读取其私有存储；可通过其 OpenSSH 导出结果迁移。

## 兼容性规则

- 未识别的会话类型、空主机和非法端口会被跳过并计入原因。
- 第三方的 jump host、agent forwarding、代理命令等只有在 Taomni 运行时支持时才可生效；否则仅保留可表达的元数据并给出警告。
- 重名会话采用确定性的重命名规则，原记录不会被覆盖。
- `disableAiWrite` 等 Taomni 安全选项在本格式往返时必须保留。
- 解析器须容忍可识别的编码差异，例如 Xshell 的 UTF-16 文件，但不能无限制尝试不可信输入。

## 代码位置

- 解析、序列化与限制：`src/lib/sessionImportExport.ts`
- HTML 清单序列化：`src/lib/sessionExportHtml.ts`
- 设置页入口和预览流程：`src/components/settings/`
- 平台扫描与注册表入口：`src-tauri/src/session/import.rs`
- 平台凭据桥接：`src-tauri/src/session/import_secrets/`
- Vault：`src-tauri/src/vault/`
- 单元测试：`src/lib/sessionImportExport.test.ts` 及相关组件测试
- UI 行为目录：`qa-ui-auto-tests/feature-list.md`

## 变更要求

新增一种来源时必须同时交付：格式识别、字段映射、输入上限、警告语义、秘密处理说明、重复记录策略、单元测试和预览 UI 接入。若第三方格式依赖平台或版本，应在界面中标明限制，不把“文件能读取”当作“凭据能恢复”。
