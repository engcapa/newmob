# jdtls 真实 provider fixture 合同(§8.19.4 R3-c)

本目录是 Basic Completion 的**版本固定 Java fixture 合同**:真实 jdtls
进程按生产等价的启动配方与 client capabilities 运行,逐场景留下脱敏
trace。任何 capability 在没有对应 trace 证据前,只能声明
`platform-unverified`/synthetic,不得写 `verified/L3`。

## 工具链(固定版本,trace 内记录)

- JDK 21:Zulu 21.0.4(`TAOMNI_FIXTURE_JAVA` 覆盖,默认 `/data/dev/jdk-21/bin/java`)。
- jdtls 1.61.0.202607102111(`JDTLS_HOME` 覆盖,默认 `~/.local/share/jdtls`)。
- Maven 3.9.x(jdtls 内嵌 m2e 解析 pom;`mvnCliDetected` 仅记录探测结果)。
- Gradle:`~/.gradle/wrapper/dists` 缓存中的最高发行版(9.5.1;
  `TAOMNI_FIXTURE_GRADLE` 覆盖),经 `java.import.gradle.home` 注入。

## Fixture 项目(`projects/`)

| 项目 | 构建工具 | 覆盖场景 |
|---|---|---|
| `maven-single/` | maven | JDK type、static member(`Arrays.`)、overload 家族(`appen`)、依赖类型 + resolve import(commons-lang3)、test source set(junit) |
| `maven-multi-module/` | maven | 跨模块类型(CoreUtil)+ resolve import、同名类型歧义(两个 `Result`) |
| `gradle-single/` | gradle | Gradle 导入 sanity(JDK type) |
| `gradle-multi-module/` | gradle | 跨模块类型(GCore)+ resolve import |
| `maven-broken-classpath/` | maven | 坏 classpath:缺失依赖候选绝不出现、java.lang 仍可补全 |

补全目标写在 `completionTargets()` 的不可达块里,每行一个裸前缀
token;runner 按"整行等于 token"(成员触发则行尾)定位 caret,与编译
代码中的同名标识符无歧义。

## Runner(`runner/`)

```
node runner/run-jdtls-fixture.mjs [--fixture <id>]...
```

- 启动配方镜像 `src-tauri/src/lsp.rs`(产品 JVM flags、共享 config 区、
  `-data` workspace);initialize 的 completion client capabilities 与
  生产相同,含 `resolveSupport.properties = [documentation, detail,
  additionalTextEdits]`。
- 每个场景轮询 completion 直到期望满足或超时(首次项目导入可达数分钟);
  命中候选项后发 `completionItem/resolve`(原样回传 item.raw,与生产一致),
  记录 additionalTextEdits。
- `verifyRevert` 场景把 primary+additional edits 应用到内存文档并做哈希
  往返:应用后哈希 → 反向移除全部插入 → 必须精确恢复原始哈希。这验证
  additional edits 是纯插入且范围良定义(R0 ledger 的 hash 记账前提),
  **不等于**编辑器内 Ctrl+Z —— 后者由 mounted/browser/native 层另行记账。
- restart 场景 SIGKILL 首个 server 后重建会话并复测同一用例。
- trace 写入 `traces/<fixture>.trace.json`:工具链版本、构建模型指纹
  (pom/gradle 文件内容 sha256)、逐场景请求次数/耗时/itemCount/
  isIncomplete、resolve additional edits 原文、acceptance 三哈希、
  restart 时延;home/tmp/project 绝对路径统一替换为 `~`/`${project}`/
  `${fixtures}`,不含源码正文。

## 诚实边界

- runner 直连 jdtls stdio,采集的是 **provider 层证据**:证明请求形状、
  capabilities、import-on-resolve、restart 行为在真实服务器上成立。
  Tauri IPC/webview 链路、键盘/IME、三端行为仍归 R9 native 门禁。
- IDEA expected 目前为**人工整理**(候选类别/scope/import/undo 结果),
  不是 IntelliJ 机器录制;"单 fixture 与 IDEA 对照达到完整矩阵"的 G2/L3
  升级仍需该对照被明确建立。

## 当前状态(诚实登记)

- [x] 合同与期望结构定义(`jdtlsFixtureExpectations.ts`)。
- [x] synthetic acceptance 基线(Vitest mounted host)。
- [x] 真实 jdtls trace(R3-c,2026-08-24,Linux 实机):五个项目全部
  绿,见 `traces/*.trace.json`;Vitest 断言 trace 与期望一致
  (`jdtlsTraceContract.test.ts`)。
- [ ] Windows/macOS 平台重复运行(R9);IDEA 2026.2 对照录制。
