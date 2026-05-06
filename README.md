# NewMob

NewMob 是一个基于 Tauri 2 + React + TypeScript 的跨平台远程连接管理工具，目标是提供类似 MobaXterm 的桌面体验。

当前工程已包含本地终端、SSH 终端、SFTP 文件浏览器、会话/分组管理、OpenSSH 配置导入等基础能力。VNC 基础客户端已实现（Raw 编码、RFB 握手、Canvas 渲染、SetDesktopSize、QuickConnect 接入、浏览器预览 stub）；RDP 仍为占位。

## 技术栈

- 前端：React 18、TypeScript、Vite、Tailwind CSS
- 桌面端：Tauri 2、Rust
- 终端：xterm.js、portable-pty、russh
- 状态与存储：Zustand、SQLite（rusqlite）

## 环境要求

- Node.js 18+
- pnpm
- Rust 1.77.2+
- Tauri 所需系统依赖

安装依赖：

```bash
pnpm install
```

## 开发

启动桌面应用开发模式：

```bash
pnpm tauri dev
```

仅启动前端 Vite 服务：

```bash
pnpm dev
```

Vite 默认端口为 `1420`，Tauri 开发模式会自动使用该端口。

## 构建与打包

构建前端静态资源：

```bash
pnpm build
```

构建产物输出到：

```text
dist/
```

打包 Tauri 桌面应用：

```bash
pnpm tauri build
```

该命令会先执行 `pnpm build`，再按当前平台生成桌面应用安装包/可执行文件。打包产物通常位于：

```text
src-tauri/target/release/bundle/
```

直接运行 release 可执行文件时，可在：

```text
src-tauri/target/release/
```

## 版本与发布

应用版本号统一维护在根目录 `package.json` 的 `version` 字段。`src-tauri/tauri.conf.json` 通过 `../package.json` 读取同一个版本，避免 Tauri bundle 版本与前端包版本分叉。

`src-tauri/Cargo.toml` 中的 `version` 是 Rust crate 元数据；除非需要发布 Rust crate 或在后端代码中使用 `CARGO_PKG_VERSION`，否则应用发布版本以 `package.json` 为准。

发布 tag 使用 `v<version>` 格式，例如当前 `0.1.0` 对应：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会在推送 `v*` tag、发布 GitHub Release，或手动运行 `Release Bundle` workflow 时构建桌面 bundle。发布触发时 workflow 会校验 tag 是否等于 `v` + `package.json` 版本；手动运行时不填 tag 只生成 workflow artifacts，填写 tag 则会上传到对应 Release。

## 测试

```bash
pnpm test
```

## 目录结构

```text
src/                 React 前端代码
src/components/      UI 组件
src/layouts/         主布局
src/lib/             IPC 与工具函数
src/stores/          前端状态管理
src-tauri/           Tauri/Rust 后端代码
src-tauri/src/       Rust 模块
```
