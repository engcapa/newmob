# jdtls 真实 provider fixture 合同(§8.18.3 / §8.18.7)

本目录是 C2/C6 的**版本固定 Java fixture 合同**。它定义了在真实 jdtls
运行时中必须复现并留证的最小矩阵;任何 capability 在没有对应 trace 证据前,
只能声明 `wired`/`platform-unverified`,不得写 `verified/L3`。

## 运行环境要求

- JDK 21(jdtls 最低要求),`JAVA_HOME` 指向该 JDK。
- jdtls distribution + java-debug / java-test 扩展 jar(Taomni
  `src-tauri/src/java_bundles.rs` 解析)。
- Maven(`mvn -q -v`)与 Gradle(`gradle -v`)任一可用 wrapper。
- 运行 Taomni 打包应用(Linux/Windows/macOS 三端各一次)。

## Fixture 项目

| 目录(待建) | 内容 | 覆盖 |
|---|---|---|
| `maven-multi-module/` | parent + `app`(main source set)+ `lib`;`app` 依赖 `lib` | 跨模块 navigation/rename、classpath 完整性 |
| `gradle-single/` | 单模块,含 test source set 与 JUnit 依赖 | test/main 分区、Gradle classpath |
| `ambiguous-types/` | 两个同名类 `com.a.Foo` / `com.b.Foo`,均被引用 | auto-import 歧义由用户选择 |
| `snippet-method/` | 含 method snippet 触发点(`${1|void,int|}` choice + placeholder) | choice/tabstop 会话、一次 undo |
| `static-import/` | 需 resolve additional edit 的 static import 候选 | 有界 resolve、"Insert without additional edits" 回退 |
| `dependency-source/` | 引用已下载源码的第三方库类型 | library read-only、decompiled/source 区分 |

## 必须留证的 trace(脱敏后入档)

1. initialize capability 位图(completionProvider resolveProvider 等)。
2. Basic completion:typing(80ms debounce)/ trigger(`.`)/ explicit
   (Ctrl+Space,重复调用 ordinal=2 → "provider scope unchanged")三路请求/
   响应摘要(label 数量、isIncomplete、截断标志)。
3. resolve:additional edits(auto-import)原文、resolve timeout 行为。
4. acceptance:一次 dispatch(主文本+import+selection)、单次 Ctrl+Z 全恢复。
5. provider restart / stale:generation 变化后迟到结果被丢弃。
6. 非 Java 负例:.ts/.py 在无 provider 时 unavailable,绝不插入 Java import。

## 记录格式

每个用例一行 JSON,字段:`caseId / jdtlsVersion / jvmVersion / buildTool /
requestKind / requestSummary / responseSummary / assertions[] / result /
timestamp / platform`。日志不得包含源码正文、用户名、绝对 home 路径或凭据。

## 当前状态(诚实登记)

- [x] 合同与期望结构定义(本文件 + `jdtlsFixtureExpectations.ts`)。
- [x] synthetic acceptance 基线(Vitest mounted host,1040+ 测试)。
- [ ] **真实 jdtls trace**:需要实机 JDK/jdtls/Maven/Gradle 环境,本轮开发
  环境不可用 —— 所有 Java provider capability 保持 `platform-unverified`。
