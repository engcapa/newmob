# 自动更新发布与运维

> 状态：客户端更新链路和发布工作流已接通。本文件记录当前发布约束、验证和回滚方式；签名私钥只存在于 CI secrets。

## 架构

Taomni 使用 Tauri 2 updater 完成更新检查、签名验证、下载和安装，使用 process 插件完成用户确认后的重启。

```text
Git tag / GitHub Release
  -> .github/workflows/release.yml 构建各平台安装包和 updater 包
  -> CI 使用 minisign 私钥签名
  -> compose-update-manifest 汇总为一个 latest.json
  -> GitHub Release assets
  -> 客户端按 tauri.conf.json endpoint 检查并验证签名
```

关键位置：

- 客户端流程：`src/lib/updateService.ts`、`src/stores/updateStore.ts`、设置页更新 UI
- 平台/架构选择：`src-tauri/src/update.rs`
- endpoint 和公钥：`src-tauri/tauri.conf.json`
- 依赖与 capability：`src-tauri/Cargo.toml`、`src-tauri/capabilities/`
- 发布构建：`.github/workflows/release.yml`

## 客户端行为

1. 读取当前系统可安装的 updater target，并在可切换架构的平台推荐原生架构。
2. 使用应用代理配置检查 `latest.json`；无更新时保持安静并显示当前状态。
3. 展示版本、说明和目标包，用户确认后下载。
4. 下载完成前显示字节/百分比进度。
5. 安装前调用 `sockscap_prepare_for_update`，释放驱动、helper 和系统捕获状态。
6. 安装完成后再次征得用户确认，再重启到新版本。

检查结果按 target 缓存，下载与安装复用同一个 `Update` 对象。不得绕过 updater 的签名校验，也不得自行执行未验证的安装包。

## 版本与清单

- 应用版本唯一维护入口是根目录 `package.json`。
- `tauri.conf.json` 从该版本生成打包信息，不另行维护版本号。
- endpoint 指向 GitHub 最新 Release 的 `latest.json`。
- `latest.json` 必须是包含所有已发布平台的单一清单；不能让并行构建产物互相覆盖。
- 清单中的 URL、signature、target key 和版本必须与 Release assets 一致。

## CI 签名要求

仓库 secrets 必须配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

对应公钥提交在 `src-tauri/tauri.conf.json`。轮换密钥时，必须先规划旧客户端的升级路径；只替换公钥会使已安装旧版本无法验证后续更新。

工作流允许无签名 secret 的构建用于普通 workflow artifacts，但这类产物不能作为自动更新正式发布。正式 tag/release 若缺少 updater 签名或完整清单，应视为发布失败。

## 发布流程

1. 更新根 `package.json` 版本并完成构建、单测和目标平台冒烟。
2. 确认 CI 签名 secrets 可用，创建匹配版本的 `v*` tag。
3. 等待各平台 bundle 和 `Compose latest.json` job 全部成功。
4. 检查 Release assets：安装包、updater 包、签名和唯一的 `latest.json` 均存在。
5. 用上一稳定版本检查更新，验证显示、代理、下载、签名、安装和重启。
6. 分别验证 Windows、macOS、Linux；macOS 还需覆盖支持的 x86_64/aarch64 选择。

`workflow_dispatch` 未指定 tag 时只生成工作流产物，不等同于正式发布。

## 失败与回滚

- 清单或资产错误：修复同一 Release assets 后重新生成并上传 `latest.json`，在客户端可见前再次验证。
- 新版本存在严重问题：停止把它作为 latest，发布版本号更高的修复版；updater 不应依赖降级覆盖。
- 安装失败：保留当前可运行版本和错误信息，不自动循环重试。
- SocksCap 清理失败：中止安装，避免在驱动/helper 占用时替换文件。
- 签名验证失败：拒绝安装并记录非敏感诊断，不提供“忽略签名”选项。

## 发布门禁

当前代码链路已完成，正式发布仍必须持续保留以下外部证据：

- CI 使用真实签名 secret 生成的 updater 资产。
- 从上一稳定版本执行的端到端升级记录。
- 三个平台的安装、重启和版本核对结果。
- SocksCap 已启动场景下的更新前清理验证。
- 代理可用、代理不可用和网络中断时的可恢复错误状态。
