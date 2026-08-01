# Code Workspace 多语言 SDK 导航与 Build/Run/Debug 计划

> 日期：2026-08-01  
> 状态：SDK/依赖源码导航适配已实现并完成自动化验证；多语言 Build/Run/Debug 为实施计划，尚未宣称完成。  
> 关联设计：`claudedocs/code-workspace-ide-design.md` 的 M3、M7、M8-M10。

## 1. 目标与结论

本轮处理两个问题：

1. 在语言服务器配置正确且工具链提供相应源码或声明的前提下，`Ctrl+点击` 可以从工作区代码跳到 SDK、标准库或依赖库定义，并在 Taomni 内打开只读缓冲区。
2. 盘点 Java 之外各语言的 Build/Run/Debug 现状，给出可逐批交付、可验证的完整实现路径。

SDK 导航不能只判断 LSP 是否返回 `Location`。定义目标可能是普通 `file:` 文件，也可能是归档条目、反编译文档或 metadata URI；Taomni 必须能读取该目标并为只读编辑器选择正确语言模式。本轮已补齐后者。

“跳到 SDK 源码”在不同生态中的含义不同：TypeScript 常见目标是 `.d.ts`，Python 可能是 `.pyi`，C/C++ 通常只能到头文件，Swift 可能是 `.swiftinterface`，C# 可能是从程序集生成的 metadata source。这些都属于有效的定义导航，但不等同于运行时实现源码。

## 2. SDK/标准库导航支持矩阵

| 语言 | LSP 预设 | 常见定义 URI/目标 | Taomni 打开方式 | 必要前提与边界 | 结论 |
|---|---|---|---|---|---|
| Rust | rust-analyzer | `file:`，sysroot/registry `.rs` | 直接读文件 | 安装匹配工具链的 `rust-src`；依赖已被 Cargo 获取 | 已支持 |
| Java | JDT LS | `file:`、`jdt:`、JAR class | `java/classFileContents`，已有下载 sources 路径 | JDT LS 正确导入工程；源码 JAR 或反编译器决定内容质量 | 已支持 |
| TypeScript / JavaScript | typescript-language-server | TypeScript lib/依赖 `.d.ts` 的 `file:` | 直接读文件 | 安装 TypeScript；Node 内建模块通常需要 `@types/node`；JS 运行时实现不一定可见 | 已支持 |
| Python | Pyright | typeshed、site-packages 的 `.py`/`.pyi` `file:` | 直接读文件 | 解释器/venv 选择正确；原生扩展通常只能到 stub | 已支持 |
| Go | gopls | `GOROOT/src`、module cache 的 `file:` | 直接读文件 | 完整 Go 安装且 gopls 使用正确 `GOROOT`/module | 已支持 |
| C / C++ | clangd | 系统 SDK、标准库 header 的 `file:` | 直接读文件 | 正确的 compilation database/flags；编译器 include 路径可见；通常只到 header | 已支持 |
| Swift | SourceKit-LSP | SDK `.swiftinterface`、Swift/header `file:` | 直接读文件 | Swift toolchain/Xcode SDK 与工程参数正确；部分标准库实现不随 SDK 发布 | 已支持 |
| Kotlin | 官方 Kotlin LSP | `jar:`/`jrt:` 或反编译虚拟文档 | 先直接读源码 JAR；否则执行 `decompile` | 官方 LSP 正确导入项目；无 sources 时显示反编译结果 | 已支持，真机待验 |
| Kotlin | community KLS | 临时 `file:` 或 `kls:` | 直接读文件/归档；二进制目标调用 `kotlin/jarClassContents` | KLS 正确配置 classpath | 已支持，真机待验 |
| Scala | Metals | `jar:` 虚拟文档 | 先直接读源码 JAR；否则执行 `file-decode` | 初始化声明 `isVirtualDocumentSupported`; Metals/BSP 导入成功 | 已支持，真机待验 |
| C# | csharp-ls | `csharp:` metadata URI | 调用 `csharp/metadata` | 必须以 `--features metadata-uris` 启动；可显示的是 metadata/decompiled source | 已支持，真机待验 |
| C# | OmniSharp LSP | 普通项目 `file:`；SDK metadata 不稳定 | 普通文件直接读 | OmniSharp 标准 LSP definition 路径未可靠启用 metadata；不能作为 SDK 导航保证 | 有限支持 |

实现约束：

- 归档读取只接受 `jar:`/`kls:`、明确的 UTF-8 源码后缀，并限制为 8 MiB；不向工作区解压文件。
- `.class`、`.tasty` 等二进制条目不会当文本读取，会回退到语言服务器的虚拟文档/反编译协议。
- URL 百分号编码同时应用于归档路径和 entry 路径。
- 所有 SDK/依赖缓冲区只读，不加入 loose files，也不会被保存回 SDK。
- “Download sources” 仍只对 Java/JDT LS 的反编译文档显示，其他 LSP 没有共用的下载协议。
- 对 C# 默认推荐 `csharp-ls`。OmniSharp 保留为普通工程智能的 fallback，但不承诺 SDK metadata 导航。

### 2.1 SDK 导航验收

每种语言至少准备一个最小工程，从用户代码 `Ctrl+点击` 一个标准库符号和一个第三方依赖符号，验收：

1. 目标 tab 在 Taomni 内打开，不调用外部编辑器。
2. 普通 `file:`、带空格/非 ASCII 路径、归档 URI 均能读取。
3. tab 显示正确语言高亮、来源容器和只读状态。
4. 可从 SDK 缓冲区继续跳转定义，并可用导航历史返回。
5. 缺源码、无权限、entry 不存在、内容超限时给出可理解错误，不崩溃、不写入工作区。
6. C# 分别验证 csharp-ls 成功和 OmniSharp 限制提示；不得把 fallback 描述成等价支持。

自动化只能覆盖 URI 解析、协议请求形状和缓冲区模型。发布前仍需在 Windows、macOS、Linux 的实际 LSP/toolchain 组合上执行上述 smoke；没有完成真机矩阵前不将对应行标记为“真机已验”。

## 3. Build/Run/Debug 现状

当前有三层可复用基础：

- `workspace.rs` 可发现一组终端任务，`RunPanel`/`BuildPanel` 可经集成 PTY 执行，并保留真实退出码。
- `WorkspaceSdkEnvironment` 可向 LSP、终端和 Java 流程注入 SDK 环境，但 SDK 注册表当前只建模 Java、Kotlin、Scala、Python。
- `dap.rs` 已有语言无关的 DAP 帧协议、stdio/TCP transport、会话状态、断点/单步/变量 UI；`DapManager::with_lsp` 目前只注册 Java adapter。

现状矩阵中的“任务可运行”不等于“完整 Run”：固定 `cargo run`、package scripts 或自定义 shell 命令缺少目标选择、参数、环境、pre-launch build 和可复用运行配置。

| 语言 | Build 现状 | Run 现状 | Debug 现状 | 主要缺口 |
|---|---|---|---|---|
| Rust | Cargo build/test/clippy | 固定 `cargo run` | 无 | bin/example/package/feature 目标发现；产物解析；LLDB adapter |
| Go | go build/test/vet | 无一等 `go run` 目标 | 无 | main package/测试目标发现；Delve server 生命周期 |
| Python | 只列 pyproject scripts，支持 uv/Poetry 前缀 | entry script/custom task | 无 | 当前文件/module/console；解释器与 args/env；debugpy |
| TypeScript / JavaScript | package scripts | package/custom task | 无 | npm workspace/package 目标；Node/browser 配置；js-debug |
| C / C++ | Make/just 的命名任务 | 无 executable target model | 无 | CMake/compile database/产物发现；LLDB；多配置 build dir |
| C# | 无 `.sln`/`.csproj` 探测 | 无 | 无 | dotnet project/TFM/launchSettings；netcoredbg |
| Kotlin | Maven/Gradle 通用 build/test 可用 | Java main scanner 忽略 `.kt` | 无 | Kotlin main/模块发现；JVM debug adapter/source mapping |
| Scala | Maven/Gradle 工程可用；无 sbt | 无一等 main | 无 | sbt/BSP target；Metals run/debug session |
| Swift | 无 `Package.swift` 探测 | 无 | 无 | SwiftPM target/product；lldb-dap |
| Java | Maven/Gradle/单文件 Build/Run 已有 | main target、普通 Run 已有 | java-debug DAP 已有 | 继续作为共享模型迁移与回归基线 |

## 4. 目标架构

### 4.1 用结构化目标替代语言特判

新增后端 provider registry，按项目证据选择 provider，而不是在 `CodeWorkspaceTab.tsx` 继续堆语言分支：

```text
LanguageExecutionProvider
  probe(root, sdk_environment) -> ProjectModel[]
  build_targets(project)        -> BuildTarget[]
  run_configurations(project)   -> RunConfiguration[]
  test_targets(project)         -> TestTarget[]
  debug_plan(config)            -> DapLaunchPlan
```

核心数据至少包含：

- `ProjectModel`: provider、project root、manifest、module/package、language、toolchain、diagnostics。
- `BuildTarget`: stable id、kind（build/clean/rebuild/test/check）、可执行文件、参数数组、cwd、env、依赖目标、产物提示。
- `RunConfiguration`: stable id、target、program/module/main、args、cwd、env、console、pre-launch targets、source map。
- `DebugConfiguration`: adapter id、launch/attach、program/process、source map、pre-launch target 和 adapter-specific payload。

保留 `command` 字符串用于 UI 预览和兼容自定义任务；内置 provider 必须以 `executable + args[]` 执行，避免 shell quoting 成为跨平台协议。

### 4.2 统一执行编排

运行和调试共享同一条 pre-launch pipeline：

```text
保存目标项目的 dirty buffers
  -> 重新探测受 manifest 变更影响的 project/target
  -> 执行 pre-launch build（可关闭）
  -> 阻断确定的编译失败
  -> 以同一个 WorkspaceSdkEnvironment 启动 Run 或 DAP
  -> 将 stdout/stderr/exit 状态写入对应 Run/Debug session
```

需要把 Java 专用的 `prepareJavaLaunch` 提炼为语言无关 orchestrator。LSP diagnostics 只能作为附加信号，build 进程退出码和结构化 compiler messages 才是跨语言的权威结果。

### 4.3 DAP adapter registry 扩展

保留现有 `DebugAdapter` trait 和前端通用 Debug UI，新增：

- adapter executable 探测、版本与 install hint；设置页允许 workspace override。
- `DapTransport` 的 managed TCP server 形态：Taomni 分配端口、启动 adapter、等待 ready、持有 child、停止时回收。Delve、Metals/Scala 等不能只用当前的裸 `Tcp { host, port }`。
- adapter capability 归一化：attach、exception breakpoints、conditional breakpoints、data breakpoints、terminate、restart。
- 正确实现或按 adapter 避免 `runInTerminal`；当前 client 声明 `supportsRunInTerminalRequest: false`，引入需要它的 adapter 前必须完成该 reverse request。
- adapter stdout 必须只走 DAP；诊断 stderr 继续由现有 pump 排空并进入 Debug Console。

### 4.4 工具链与配置

扩展 SDK/tool registry：

- Runtime/SDK：Rust toolchain、Go SDK、Node、.NET SDK、LLVM/GCC、Swift toolchain。
- Debug adapter：CodeLLDB/`lldb-dap`、Delve、debugpy、vscode-js-debug、netcoredbg。
- Build tool：Cargo、Go、npm/pnpm/yarn、uv/Poetry、CMake/Ninja/Make、dotnet、Gradle/Maven、sbt、SwiftPM。

解析顺序统一为：项目 wrapper/本地环境 > workspace override > 已绑定 SDK > `PATH`。探测结果必须带来源与可操作错误，不能生成看似可点击、实际找不到工具的任务。

运行配置先存浏览器 workspace local storage，与现有 custom tasks 一致；等 schema 稳定后再评估可选的 workspace-shareable 文件。首期不自动写入用户仓库。

## 5. 分批实施计划

### Wave 0：共享模型与迁移门槛

1. 新增 provider registry、结构化 project/build/run/debug 类型和 IPC。
2. 将现有 Java 与 generic task detection 适配到新模型，行为保持不变。
3. 把顶部 `Run current Java file` / `Debug current Java file` 改成 capability 驱动的 `Run current target` / `Debug current target`。
4. 提炼 save/build/pre-launch orchestrator；为 target picker、args/env/cwd、rerun/restart 建统一状态。
5. 扩展 managed TCP transport、adapter probe、超时与 child cleanup。
6. 加入 fixture provider tests、DAP fake adapter integration test 和跨平台 command construction tests。

Wave 0 退出条件：Java 回归全绿；前端没有新增语言名分支；provider 可独立注册；fake stdio 和 managed TCP adapter 都能走完 initialize/launch/breakpoint/stop。

### Wave 1：Rust + Go

Rust：

- 用 `cargo metadata --format-version 1 --no-deps` 发现 workspace package、bin、example、test、bench。
- Build 提供 check/build/test/clippy/clean，支持 package、target、features、profile。
- Run 使用精确的 `cargo run -p ... --bin/--example ...`；配置保存 program args/env/cwd/features。
- Debug 以 CodeLLDB 为首选、`lldb-dap` 为可选 fallback。用 Cargo JSON message 的 `compiler-artifact.executable` 定位实际产物，不猜 `target/debug` 路径。

Go：

- 用 `go env -json` 与 `go list -json ./...` 发现 module、main package 和 tests。
- Build 提供 package/all 的 build/test/vet/clean；Run 支持当前 main package、单文件实验模式和 args/env。
- Debug 使用 Delve DAP；由 managed TCP transport 启动 `dlv dap`，支持 launch package/test 和 attach process。

退出条件：Cargo workspace 多 bin/example 和 Go multi-package 工程可选目标；dirty save -> build -> run/debug；断点、单步、变量、停止有效；Windows/Linux/macOS 至少各完成规定 smoke 中适用的工具链组合。

### Wave 2：Python + TypeScript/JavaScript

Python：

- 解释器以 workspace SDK、`.venv`、uv/Poetry environment 解析结果为准。
- Run 提供 active file、module (`-m`)、pyproject entry point；不把裸 entry name 当成可靠 executable。
- Debug 使用 debugpy，支持 file/module、args/env/cwd、justMyCode、subprocess 和 attach port。
- Build 仅在项目声明时提供 wheel/sdist、typecheck/test；不把解释型语言强行显示成 compile。

TypeScript/JavaScript：

- 解析 package manager、npm workspaces/pnpm workspace、package scripts；Build 由 scripts 的语义标签和显式配置决定。
- Run 提供 Node active file、package script、workspace package、Node test；TypeScript 直接运行只在检测到 tsx/ts-node 等项目 runner 时提供。
- Debug 使用 vscode-js-debug，支持 Node launch/attach、source maps、outFiles、skipFiles；浏览器调试作为后续子阶段，需端口/URL 与 dev-server pre-launch 配置。
- 明确 adapter 的安装/打包方式和许可证；不能假设全局 npm 包暴露稳定 DAP executable。

退出条件：venv/uv/Poetry 解释器不串用；Node monorepo target 不串 cwd；TS breakpoint 经 source map 命中；Python/Node child process 策略有明确配置。

### Wave 3：C/C++ + C#

C/C++：

- 首期支持 CMake presets/`CMakeLists.txt`，其次兼容 Make/just；读取 `compile_commands.json` 作为编译目标证据。
- Build 以独立 build directory 和 configure/build 两阶段建模，支持 Debug/Release 和 CMake target。
- Run 从 CMake file-api reply/已知 build target 获取 executable，不通过目录扫描猜测。
- Debug 共用 CodeLLDB/`lldb-dap`，补 Windows 路径、MSVC/GNU ABI、sourceMap 与 attach process 验证。

C#：

- 用 `dotnet sln list`、`dotnet msbuild -getProperty/-getItem` 或受控解析发现 solution/project、TFM、OutputPath；Build 提供 restore/build/test/clean。
- Run 支持 executable project、framework、configuration、args/env，并读取但不修改 `launchSettings.json` profile。
- Debug 使用 netcoredbg（stdio `--interpreter=vscode`），从结构化 build 结果解析 DLL/exe；支持 CoreCLR launch/attach。
- C# LSP 选择和 debug adapter 相互独立；使用 OmniSharp 不应阻止 netcoredbg，但 SDK 源码导航仍推荐 csharp-ls。

退出条件：CMake multi-target/multi-config 和 .NET multi-project/multi-TFM 不会默认选错目标；无 build artifact 时 debug 必须先 build 或给出明确错误。

### Wave 4：Kotlin + Scala

Kotlin：

- Maven/Gradle provider 扩展 `.kt` main 发现，优先采用 build tool model/任务，源码扫描只作有界 fallback。
- JVM Run 使用 Maven/Gradle classpath 与 main class；standalone kotlinc 仅支持明确的单文件/简单目录模式。
- 第一阶段验证现有 JVM java-debug adapter 对 Kotlin class、协程和 source mapping 的可用性；不能仅因协议同为 DAP 就宣称支持。
- 若 java-debug 无法覆盖纯 Kotlin 工程，评估官方 Kotlin LSP/DAP 或独立 Kotlin debug adapter，并以真机断点命中作为选型硬门槛。
- Android、Kotlin Multiplatform、JS/Wasm/Native 分成独立 provider，不纳入 JVM 首期完成定义。

Scala：

- 增加 sbt task/target，优先从 Metals/BSP 获得 build target、main class、test class。
- Run 通过 Metals `debugSession/start` 对应能力或 build tool run target；Debug 通过 Metals `debug-adapter-start` 获取会话 URI并接入通用 DAP。
- Maven/Gradle Scala 项目继续复用共享 build provider，但 main/debug discovery 不依赖 Java 源码扫描。

退出条件：Kotlin JVM Gradle/Maven 与 Scala sbt 各完成 main/test 的 run/debug；混合 Java/Kotlin/Scala 工程的 source path 和断点都能命中。Android/KMP 若未实现，UI 必须明确标为不支持，而不是退化成错误 JVM 配置。

### Wave 5：Swift

- 用 `swift package describe --type json`/SwiftPM 描述发现 package、library、executable、test product。
- Build 提供 build/test/clean，支持 configuration、triple 和 build path；Run 只展示 executable products。
- Debug 使用 Swift toolchain 内的 `lldb-dap`，校验 Swift runtime env、module cache、source mapping 和 tests。
- Xcode workspace/project、iOS simulator/device、codesign 不放入 SwiftPM 首期，单独立项。

退出条件：macOS 和至少一个 Swift 官方支持的非 macOS 环境完成 SwiftPM executable/test smoke；Xcode-only 工程显示明确范围提示。

## 6. 每个 Provider 的统一验收合同

功能验收：

1. project/target 探测可重复且 stable id 不随列表顺序变化；多根、多模块不串 cwd/toolchain。
2. Build/Clean/Rebuild/Test 的命令、参数、环境和退出码准确；取消会终止完整进程树。
3. Run 可选择目标，保存 args/env/cwd，支持 rerun/restart，stdin/stdout/stderr 正常。
4. Debug 的 launch/attach 能设置普通/条件/logpoint 断点，完成 continue/step/evaluate/variables/stack/source/terminate。
5. dirty 文件在 pre-launch 保存；build 明确失败时不启动过期产物；可配置跳过 build。
6. 缺工具、版本不兼容、无目标、目标歧义、端口超时均有 actionable error 和 install hint。
7. 普通 Run 不依赖 debug adapter；Build 不依赖 LSP；LSP 不活跃时只损失基于 LSP/BSP 的增强发现。

自动化分层：

- Rust unit tests：manifest/CLI JSON parser、target id、命令构造、路径/环境、provider selection。
- Rust integration tests：fake executable/fake DAP，覆盖 stdio/TCP、超时、退出、取消、cleanup。
- Vitest：target picker、toolbar capability、run configuration persistence、pre-launch 状态和错误 UI。
- YAML UI e2e：每个 wave 至少一个 Build -> Run 和 Build -> Debug 主流程，case 引用同步到 `feature-list.md`。
- Native smoke：真实工具链、真实 adapter、真实最小工程；记录 OS、版本、项目类型与结果。该层未完成时不得标记语言“完整支持”。

## 7. 风险与决策门槛

| 风险 | 决策/缓解 |
|---|---|
| 把脚本列表误称为完整 Run | UI 区分 Tasks 与 Run Configurations；只有 provider 生成的 target 进入顶部 Run/Debug |
| 多语言逻辑继续堆进 `CodeWorkspaceTab.tsx` | 以 provider/capability 数据驱动；壳体只做选择和编排 |
| adapter 安装方式不稳定 | 每个 adapter 先完成 executable/version probe 和分发决策，再开放按钮 |
| TCP adapter 进程泄漏或端口竞态 | managed TCP transport 统一分配端口、ready timeout、持有 child、会话结束回收 |
| LSP 与 build tool 项目模型冲突 | build tool/BSP/Cargo metadata 是运行目标权威；LSP 用于导航和增强发现 |
| 跨平台 shell quoting | 内置任务使用 executable + args；shell command 仅留给用户自定义任务 |
| “支持”覆盖范围无限扩大 | 每 wave 明列首期项目类型；Android/KMP、浏览器、Xcode/device 等独立验收 |

## 8. 推荐交付顺序

严格顺序为 Wave 0 -> Wave 1 -> Wave 2 -> Wave 3 -> Wave 4 -> Wave 5。Wave 内可以并行开发 provider 与 fixture，但必须在共享模型合入后进行，避免形成第二套任务/DAP 架构。

每个 wave 单独发布，并在 Build/Run/Debug capability matrix 中按 `unavailable`、`detected`、`verified` 三态展示。最终“完整多语言 Build/Run/Debug”完成条件不是代码路径存在，而是本文件第 6 节合同与对应 native smoke 全部通过。
