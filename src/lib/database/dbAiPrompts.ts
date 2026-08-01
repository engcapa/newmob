// Prompt construction for the database "Explain statement" actions.
//
// The sibling of `editorAiPrompts.ts`, and deliberately shaped the same way:
// pure functions, templates keyed by answer language, and a bounded context
// budget, so wording and truncation are unit-testable without a live
// connection. Callers collect the raw facts; every decision about what reaches
// the model lives here.
//
// One module rather than one per engine because the three dialects differ in
// their fence and their risk list, not in the shape of the answer a user wants:
// what does this do, what does each piece mean, what will bite me.

import {
  resolveAnswerLanguage,
  type AiAnswerLanguage,
  type ResolvedAnswerLanguage,
} from "../ai/answerLanguage";

/** What the user asked for. `explain` is the only action wired up so far. */
export type DbAiAction = "explain";

/**
 * Query language family. Drives the markdown fence and the dialect-specific
 * hazards the prompt asks the model to look for.
 */
export type DbDialect = "sql" | "redis" | "hbase";

/** Max characters of statement text sent to the model. */
export const MAX_DB_STATEMENT_CHARS = 8000;
/** Max characters of a result/reply preview carried over. */
export const MAX_DB_RESULT_CHARS = 2000;

export interface DbAiContext {
  action: DbAiAction;
  dialect: DbDialect;
  /** Engine name for the prompt body, e.g. "MySQL", "Redis", "HBase". */
  engine: string;
  /** The statement or command. Already clipped by `truncateStatement`. */
  statement: string;
  /** True when the statement was clipped to fit the budget. */
  truncated: boolean;
  database?: string | null;
  schema?: string | null;
  /** HBase only: which backend the command runs through. */
  transport?: string | null;
  /** Wall-clock duration of a completed run, in milliseconds. */
  durationMs?: number | null;
  rowCount?: number | null;
  /** Error text from a failed run. Shifts the answer toward diagnosis. */
  error?: string | null;
  /** Result shape or reply preview from a completed run. */
  resultSummary?: string | null;
}

/**
 * Clip `text` to the statement budget, keeping the head and the tail so both
 * the leading clause and the trailing one survive. The marker tells the model
 * the gap is ours, not a syntax error in the user's statement.
 */
export function truncateStatement(
  text: string,
  maxChars: number = MAX_DB_STATEMENT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const dropped = text.length - maxChars;
  const headChars = Math.ceil(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  return {
    text: `${head}\n\n… (${dropped} characters omitted from the middle) …\n\n${tail}`,
    truncated: true,
  };
}

/** Markdown fence info string for a dialect. */
export function fenceForDialect(dialect: DbDialect): string {
  if (dialect === "redis") return "redis";
  if (dialect === "hbase") return "ruby"; // HBase shell syntax is Ruby-flavoured.
  return "sql";
}

// ── Prompt templates ─────────────────────────────────────────────────────────
//
// The requirement list is dialect-specific in exactly one place: the hazards
// worth naming. A SQL reader cares about index usage and full scans; a Redis
// reader about O(N) commands and blocking the single thread; an HBase reader
// about row-key design and hotspotting. Asking for all three everywhere would
// train the model to pad answers with irrelevant warnings.

interface DialectCopy {
  /** What this dialect calls the thing being explained. */
  subject: string;
  /** Dialect-specific risks the answer should cover. */
  hazards: string;
}

const DIALECT_COPY: Record<ResolvedAnswerLanguage, Record<DbDialect, DialectCopy>> = {
  "zh-CN": {
    sql: {
      subject: "SQL 语句",
      hazards: "索引能否命中、是否会全表扫描、连接与子查询的代价、锁与事务边界、隐式类型转换、NULL 语义、SQL 注入面",
    },
    redis: {
      subject: "Redis 命令",
      hazards: "时间复杂度（是否 O(N) 扫描）、是否阻塞单线程、大 key 与大 value、KEYS/FLUSHALL 之类的生产风险、过期与内存淘汰、原子性",
    },
    hbase: {
      subject: "HBase 命令",
      hazards: "row key 设计与扫描范围、是否引起 region 热点、列族与版本数、scan 的 limit 与 filter 代价、写放大与 compaction",
    },
  },
  en: {
    sql: {
      subject: "SQL statement",
      hazards: "index usage and full scans, join and subquery cost, locking and transaction boundaries, implicit type conversion, NULL semantics, injection surface",
    },
    redis: {
      subject: "Redis command",
      hazards: "time complexity (whether it is an O(N) scan), whether it blocks the single thread, large keys and values, production hazards like KEYS or FLUSHALL, expiry and eviction, atomicity",
    },
    hbase: {
      subject: "HBase command",
      hazards: "row-key design and scan range, whether it hotspots a region, column families and version counts, the cost of scan limits and filters, write amplification and compaction",
    },
  },
};

interface Labels {
  contextHeading: string;
  statementHeading: string;
  engine: string;
  database: string;
  schema: string;
  transport: string;
  duration: string;
  rows: string;
  error: string;
  result: string;
  truncatedNote: string;
  answerDirective: string;
  errorRequirement: string;
}

const LABELS: Record<ResolvedAnswerLanguage, Labels> = {
  "zh-CN": {
    contextHeading: "## 上下文",
    statementHeading: "## 待解释的语句",
    engine: "引擎",
    database: "数据库",
    schema: "Schema",
    transport: "传输方式",
    duration: "执行耗时",
    rows: "返回行数",
    error: "执行报错",
    result: "执行结果",
    truncatedNote: "注意：语句过长，中间部分已被省略（省略处已标注），这不是语句本身的语法错误。",
    answerDirective: "请用中文回答。",
    errorRequirement: "上面给出了执行报错，请先逐条定位报错原因，并给出改好的语句；",
  },
  en: {
    contextHeading: "## Context",
    statementHeading: "## Statement to explain",
    engine: "Engine",
    database: "Database",
    schema: "Schema",
    transport: "Transport",
    duration: "Duration",
    rows: "Rows returned",
    error: "Execution error",
    result: "Execution result",
    truncatedNote: "Note: the statement was long, so its middle was omitted (marked inline) — that gap is not a syntax error in the statement.",
    answerDirective: "Answer in English.",
    errorRequirement: "An execution error is listed above — diagnose each one first and give a corrected statement;",
  },
};

function buildRequirements(
  language: ResolvedAnswerLanguage,
  copy: DialectCopy,
  hasError: boolean,
): { lead: string; requirements: string[]; closing: string } {
  const labels = LABELS[language];
  if (language === "zh-CN") {
    return {
      lead: `请解释下面这条${copy.subject}，并结合执行信息说明它的含义、语法和潜在问题。`,
      requirements: [
        ...(hasError ? [labels.errorRequirement] : []),
        `这条${copy.subject}在做什么，预期的输入输出和影响范围是什么；`,
        "逐一讲解其中用到的语法、关键字和参数的含义与规则（把它当作教学示例，帮我打好基础）；",
        `存在哪些潜在问题或风险（${copy.hazards}）；`,
        "有哪些可优化或更惯用的写法，给出改写后的语句并说明为什么更好。",
      ],
      closing: "改写后的语句请放在单独的代码块里，方便直接复制。",
    };
  }
  return {
    lead: `Explain the following ${copy.subject}, covering what it means, the syntax it uses, and any potential problems, using the execution details below.`,
    requirements: [
      ...(hasError ? [labels.errorRequirement] : []),
      `What this ${copy.subject} does — expected inputs, outputs, and blast radius;`,
      "Walk through each piece of syntax, keyword, and argument it uses, explaining what it means and the rules that govern it (treat it as a teaching example);",
      `Any potential problems or risks (${copy.hazards});`,
      "What could be optimized or written more idiomatically — give the rewritten statement and say why it is better.",
    ],
    closing: "Put any rewritten statement in its own code block so it can be copied directly.",
  };
}

function fencedBlock(body: string, fence: string): string[] {
  return [`\`\`\`${fence}`, body, "```"];
}

function clampResult(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_DB_RESULT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_DB_RESULT_CHARS)}…`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * Build the prompt for a database explain action.
 *
 * Same layout discipline as the editor prompts: the directive and its
 * requirements first, gathered context next, and the statement last, so the
 * instructions are not buried under a long paste. The fence carries the real
 * dialect so the model does not have to infer the grammar.
 */
export function buildDbAiPrompt(context: DbAiContext, preference: AiAnswerLanguage): string {
  const language = resolveAnswerLanguage(preference);
  const labels = LABELS[language];
  const copy = DIALECT_COPY[language][context.dialect];
  const fence = fenceForDialect(context.dialect);
  const hasError = !!context.error?.trim();

  const { lead, requirements, closing } = buildRequirements(language, copy, hasError);

  const lines: string[] = [lead, ""];
  requirements.forEach((requirement, index) => {
    lines.push(`${index + 1}. ${requirement}`);
  });
  lines.push("", closing);

  // ── Context block ──
  const contextLines: string[] = [`- ${labels.engine}: ${context.engine}`];
  if (context.database?.trim()) contextLines.push(`- ${labels.database}: ${context.database.trim()}`);
  if (context.schema?.trim()) contextLines.push(`- ${labels.schema}: ${context.schema.trim()}`);
  if (context.transport?.trim()) contextLines.push(`- ${labels.transport}: ${context.transport.trim()}`);
  if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs)) {
    contextLines.push(`- ${labels.duration}: ${formatDuration(context.durationMs)}`);
  }
  if (typeof context.rowCount === "number" && Number.isFinite(context.rowCount)) {
    contextLines.push(`- ${labels.rows}: ${context.rowCount}`);
  }
  lines.push(labels.contextHeading, ...contextLines);

  if (hasError) {
    lines.push("", `${labels.error}:`, ...fencedBlock(clampResult(context.error!), ""));
  }

  if (context.resultSummary?.trim()) {
    lines.push("", `${labels.result}:`, ...fencedBlock(clampResult(context.resultSummary), ""));
  }

  // ── Statement last ──
  lines.push("", labels.statementHeading);
  if (context.truncated) lines.push(labels.truncatedNote);
  lines.push(...fencedBlock(context.statement, fence));

  lines.push("", labels.answerDirective);

  return lines.join("\n");
}
