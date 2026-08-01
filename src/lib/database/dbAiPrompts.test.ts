import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { writeGlobalAnswerLanguage } from "../ai/answerLanguage";
import {
  MAX_DB_RESULT_CHARS,
  MAX_DB_STATEMENT_CHARS,
  buildDbAiPrompt,
  fenceForDialect,
  truncateStatement,
  type DbAiContext,
} from "./dbAiPrompts";

function makeContext(overrides: Partial<DbAiContext> = {}): DbAiContext {
  return {
    action: "explain",
    dialect: "sql",
    engine: "MySQL",
    statement: "SELECT * FROM users WHERE id = 1",
    truncated: false,
    ...overrides,
  };
}

describe("truncateStatement", () => {
  it("leaves a short statement untouched", () => {
    const { text, truncated } = truncateStatement("SELECT 1");
    expect(text).toBe("SELECT 1");
    expect(truncated).toBe(false);
  });

  it("keeps the head and the tail so both ends survive", () => {
    const statement = `SELECT head ${"x".repeat(MAX_DB_STATEMENT_CHARS)} tail_marker`;
    const { text, truncated } = truncateStatement(statement);

    expect(truncated).toBe(true);
    expect(text.startsWith("SELECT head")).toBe(true);
    expect(text.endsWith("tail_marker")).toBe(true);
    expect(text).toContain("characters omitted from the middle");
  });

  it("honours a custom budget", () => {
    const { text, truncated } = truncateStatement("SELECT abcdefghij", 10);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan("SELECT abcdefghij".length + 80);
  });
});

describe("fenceForDialect", () => {
  it("maps each dialect to a grammar the model can use", () => {
    expect(fenceForDialect("sql")).toBe("sql");
    expect(fenceForDialect("redis")).toBe("redis");
    // HBase shell is Ruby-flavoured, so a ruby fence highlights it correctly.
    expect(fenceForDialect("hbase")).toBe("ruby");
  });
});

describe("buildDbAiPrompt layout", () => {
  it("puts the directive first and the statement last", () => {
    const prompt = buildDbAiPrompt(makeContext(), "en");
    const directiveIndex = prompt.indexOf("Explain the following");
    const statementIndex = prompt.indexOf("SELECT * FROM users");

    expect(directiveIndex).toBeGreaterThanOrEqual(0);
    // Instructions must not be buried under a long paste.
    expect(directiveIndex).toBeLessThan(statementIndex);
    expect(prompt.indexOf("## Context")).toBeLessThan(statementIndex);
  });

  it("fences the statement with the dialect's grammar", () => {
    expect(buildDbAiPrompt(makeContext(), "en")).toContain("```sql");
    expect(buildDbAiPrompt(makeContext({ dialect: "redis", engine: "Redis" }), "en")).toContain("```redis");
    expect(buildDbAiPrompt(makeContext({ dialect: "hbase", engine: "HBase" }), "en")).toContain("```ruby");
  });

  it("numbers its requirements", () => {
    const prompt = buildDbAiPrompt(makeContext(), "en");
    expect(prompt).toContain("1. ");
    expect(prompt).toContain("2. ");
  });

  it("ends with the answer directive", () => {
    expect(buildDbAiPrompt(makeContext(), "en").trimEnd().endsWith("Answer in English.")).toBe(true);
    expect(buildDbAiPrompt(makeContext(), "zh-CN").trimEnd().endsWith("请用中文回答。")).toBe(true);
  });
});

describe("buildDbAiPrompt context block", () => {
  it("always names the engine", () => {
    expect(buildDbAiPrompt(makeContext({ engine: "PostgreSQL" }), "en")).toContain("- Engine: PostgreSQL");
  });

  it("includes only the optional facts it was given", () => {
    const prompt = buildDbAiPrompt(
      makeContext({ database: "shop", schema: "public", rowCount: 42, durationMs: 1500 }),
      "en",
    );
    expect(prompt).toContain("- Database: shop");
    expect(prompt).toContain("- Schema: public");
    expect(prompt).toContain("- Rows returned: 42");
    expect(prompt).toContain("- Duration: 1.50s");
    expect(prompt).not.toContain("- Transport:");
  });

  it("omits blank and null optional facts rather than printing placeholders", () => {
    const prompt = buildDbAiPrompt(
      makeContext({ database: "   ", schema: null, transport: undefined, rowCount: null }),
      "en",
    );
    expect(prompt).not.toContain("- Database:");
    expect(prompt).not.toContain("- Schema:");
    expect(prompt).not.toContain("- Rows returned:");
  });

  it("formats sub-second durations in milliseconds", () => {
    expect(buildDbAiPrompt(makeContext({ durationMs: 42 }), "en")).toContain("- Duration: 42ms");
  });

  it("carries the HBase transport", () => {
    const prompt = buildDbAiPrompt(
      makeContext({ dialect: "hbase", engine: "HBase", transport: "thrift" }),
      "en",
    );
    expect(prompt).toContain("- Transport: thrift");
  });

  it("keeps a zero row count, which is a real result", () => {
    expect(buildDbAiPrompt(makeContext({ rowCount: 0 }), "en")).toContain("- Rows returned: 0");
  });
});

describe("buildDbAiPrompt error handling", () => {
  it("adds a diagnosis requirement and the error text when a run failed", () => {
    const prompt = buildDbAiPrompt(
      makeContext({ error: "ERROR 1146: Table 'shop.userz' doesn't exist" }),
      "en",
    );
    expect(prompt).toContain("An execution error is listed above");
    expect(prompt).toContain("ERROR 1146");
    // Diagnosis leads, so it is the first numbered requirement.
    expect(prompt.indexOf("1. An execution error")).toBeGreaterThanOrEqual(0);
  });

  it("leaves the diagnosis requirement out when there was no error", () => {
    const prompt = buildDbAiPrompt(makeContext(), "en");
    expect(prompt).not.toContain("An execution error is listed above");
  });

  it("treats a whitespace-only error as no error", () => {
    const prompt = buildDbAiPrompt(makeContext({ error: "   \n " }), "en");
    expect(prompt).not.toContain("An execution error is listed above");
    expect(prompt).not.toContain("Execution error:");
  });

  it("includes a result preview when one is available", () => {
    const prompt = buildDbAiPrompt(makeContext({ resultSummary: "3 row(s), 2 column(s)" }), "en");
    expect(prompt).toContain("Execution result:");
    expect(prompt).toContain("3 row(s), 2 column(s)");
  });

  it("clamps an oversized result preview to the documented budget", () => {
    const prompt = buildDbAiPrompt(makeContext({ resultSummary: "y".repeat(5000) }), "en");
    // Longest run, not the first — a bare /y+/ matches the "y" in "syntax".
    const preview = [...prompt.matchAll(/y+/g)]
      .map((match) => match[0])
      .reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), "");
    expect(preview).toHaveLength(MAX_DB_RESULT_CHARS);
  });

  it("flags a truncated statement so the gap is not read as a syntax error", () => {
    const prompt = buildDbAiPrompt(makeContext({ truncated: true }), "en");
    expect(prompt).toContain("that gap is not a syntax error");
  });
});

describe("buildDbAiPrompt dialect hazards", () => {
  it("names SQL-specific risks for SQL", () => {
    const prompt = buildDbAiPrompt(makeContext(), "en");
    expect(prompt).toContain("index usage and full scans");
    // Padding every answer with unrelated warnings trains the model to guess.
    expect(prompt).not.toContain("row-key design");
  });

  it("names Redis-specific risks for Redis", () => {
    const prompt = buildDbAiPrompt(makeContext({ dialect: "redis", engine: "Redis" }), "en");
    expect(prompt).toContain("blocks the single thread");
    expect(prompt).not.toContain("index usage and full scans");
  });

  it("names HBase-specific risks for HBase", () => {
    const prompt = buildDbAiPrompt(makeContext({ dialect: "hbase", engine: "HBase" }), "en");
    expect(prompt).toContain("row-key design");
    expect(prompt).not.toContain("blocks the single thread");
  });
});

describe("buildDbAiPrompt answer language", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => setLocale("en"));

  it("writes the whole prompt in the requested language", () => {
    const zh = buildDbAiPrompt(makeContext(), "zh-CN");
    expect(zh).toContain("## 上下文");
    expect(zh).toContain("## 待解释的语句");
    expect(zh).toContain("- 引擎: MySQL");

    const en = buildDbAiPrompt(makeContext(), "en");
    expect(en).toContain("## Context");
    expect(en).toContain("## Statement to explain");
  });

  it("localizes the dialect subject and hazards together", () => {
    const zh = buildDbAiPrompt(makeContext({ dialect: "redis", engine: "Redis" }), "zh-CN");
    expect(zh).toContain("Redis 命令");
    expect(zh).toContain("阻塞单线程");
  });

  it("follows the app locale for auto", () => {
    setLocale("zh-CN");
    expect(buildDbAiPrompt(makeContext(), "auto")).toContain("## 上下文");
    setLocale("en");
    expect(buildDbAiPrompt(makeContext(), "auto")).toContain("## Context");
  });

  it("follows the global default for inherit, so DB and editor answers match", () => {
    writeGlobalAnswerLanguage("zh-CN");
    setLocale("en");
    expect(buildDbAiPrompt(makeContext(), "inherit")).toContain("## 上下文");

    writeGlobalAnswerLanguage("en");
    setLocale("zh-CN");
    expect(buildDbAiPrompt(makeContext(), "inherit")).toContain("## Context");
  });

  it("localizes the error requirement", () => {
    const zh = buildDbAiPrompt(makeContext({ error: "boom" }), "zh-CN");
    expect(zh).toContain("上面给出了执行报错");
  });
});
