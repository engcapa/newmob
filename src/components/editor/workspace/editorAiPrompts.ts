// Prompt construction for the editor's AI selection actions (Explain / Syntax /
// Fix / Ask AI).
//
// Kept as pure functions outside CodeWorkspaceTab so the wording, the context
// budget, and the language handling are unit-testable without CodeMirror or a
// live language server. The tab component only collects the raw facts; every
// decision about what reaches the model lives here.
//
// The prompts are what we send to the LLM, not UI copy, so the templates live in
// this module keyed by answer language rather than in the i18n dictionaries.

import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { getLocale } from "../../../lib/i18n";
import { symbolKindLabel } from "./symbolKinds";

export type EditorAiAction = "explain" | "syntax" | "fix" | "rewrite";

/** Answer language preference. `auto` follows the app locale. */
export type AiAnswerLanguage = "auto" | "zh-CN" | "en";

/** Resolved answer language — what the templates are actually keyed by. */
export type ResolvedAnswerLanguage = "zh-CN" | "en";

export const AI_ANSWER_LANGUAGES: AiAnswerLanguage[] = ["auto", "zh-CN", "en"];

/**
 * Everything the prompt builder is allowed to know. The tab component fills
 * this in from the open buffer, the LSP state, and the current selection.
 */
export interface EditorAiContext {
  action: EditorAiAction;
  /** Display label for the file (subtitle or path). */
  filePath: string;
  /** Human-readable language name, e.g. "Rust". Null when unknown. */
  languageLabel: string | null;
  /** Markdown fence info string, e.g. "rust". Empty when unknown. */
  fenceLanguage: string;
  /** The selected code. Already truncated by `truncateSelection`. */
  selection: string;
  /** 1-based inclusive line range of the selection in the file. */
  selectionStartLine: number;
  selectionEndLine: number;
  /** Enclosing symbols, outermost first, from `describeScopeChain`. */
  scopeChain: string[];
  /** Import/use/include lines from the top of the file. */
  imports: string[];
  /** Context lines immediately before / after the selection. */
  linesBefore: string[];
  linesAfter: string[];
  /** LSP hover text at the selection start (type information). */
  hover: string | null;
  /** Diagnostics overlapping the selection. */
  diagnostics: string[];
  /** User instruction, for the rewrite action. */
  instruction?: string;
  /** True when the selection was clipped to fit the budget. */
  truncated: boolean;
}

// ── Context budget ───────────────────────────────────────────────────────────
// A teaching answer needs surrounding code to be useful, but the selection is
// user-driven and can be a whole file. These caps keep the request bounded
// without silently dropping the part the user actually pointed at.

/** Max characters of selected code sent to the model. */
export const MAX_SELECTION_CHARS = 8000;
/** Context lines kept on each side of the selection. */
export const CONTEXT_LINE_RADIUS = 12;
/** Max import/use lines carried over from the file header. */
export const MAX_IMPORT_LINES = 40;
/** Max diagnostics listed in the prompt. */
export const MAX_DIAGNOSTICS = 10;
/** Max characters of LSP hover text carried over. */
export const MAX_HOVER_CHARS = 1200;

/** Resolve an answer-language preference, following the app locale for `auto`. */
export function resolveAnswerLanguage(preference: AiAnswerLanguage): ResolvedAnswerLanguage {
  if (preference === "zh-CN" || preference === "en") return preference;
  return getLocale() === "zh-CN" ? "zh-CN" : "en";
}

/**
 * Clip `text` to the selection budget, keeping the head and the tail so both
 * the opening construct and the closing brace survive. The marker tells the
 * model the gap is our doing, not a syntax error in the user's code.
 */
export function truncateSelection(
  text: string,
  maxChars: number = MAX_SELECTION_CHARS,
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

// ── Language identification ──────────────────────────────────────────────────

interface LanguageDescriptor {
  /** Human-readable name used in the prompt body. */
  label: string;
  /** Markdown fence info string so the model gets the grammar right. */
  fence: string;
}

/**
 * Extension → language. Covers every case `diffLanguage.ts` can load a grammar
 * for, plus languages we have no CodeMirror mode for but can still teach.
 */
const LANGUAGES_BY_EXTENSION: Record<string, LanguageDescriptor> = {
  ts: { label: "TypeScript", fence: "typescript" },
  tsx: { label: "TypeScript (TSX)", fence: "tsx" },
  mts: { label: "TypeScript", fence: "typescript" },
  cts: { label: "TypeScript", fence: "typescript" },
  js: { label: "JavaScript", fence: "javascript" },
  jsx: { label: "JavaScript (JSX)", fence: "jsx" },
  mjs: { label: "JavaScript", fence: "javascript" },
  cjs: { label: "JavaScript", fence: "javascript" },
  json: { label: "JSON", fence: "json" },
  jsonc: { label: "JSON with comments", fence: "jsonc" },
  py: { label: "Python", fence: "python" },
  pyi: { label: "Python stub", fence: "python" },
  rs: { label: "Rust", fence: "rust" },
  go: { label: "Go", fence: "go" },
  java: { label: "Java", fence: "java" },
  kt: { label: "Kotlin", fence: "kotlin" },
  kts: { label: "Kotlin script", fence: "kotlin" },
  scala: { label: "Scala", fence: "scala" },
  groovy: { label: "Groovy", fence: "groovy" },
  cs: { label: "C#", fence: "csharp" },
  c: { label: "C", fence: "c" },
  h: { label: "C/C++ header", fence: "cpp" },
  cc: { label: "C++", fence: "cpp" },
  cpp: { label: "C++", fence: "cpp" },
  cxx: { label: "C++", fence: "cpp" },
  hpp: { label: "C++ header", fence: "cpp" },
  hxx: { label: "C++ header", fence: "cpp" },
  m: { label: "Objective-C", fence: "objectivec" },
  mm: { label: "Objective-C++", fence: "objectivec" },
  swift: { label: "Swift", fence: "swift" },
  rb: { label: "Ruby", fence: "ruby" },
  php: { label: "PHP", fence: "php" },
  pl: { label: "Perl", fence: "perl" },
  lua: { label: "Lua", fence: "lua" },
  dart: { label: "Dart", fence: "dart" },
  zig: { label: "Zig", fence: "zig" },
  hs: { label: "Haskell", fence: "haskell" },
  ex: { label: "Elixir", fence: "elixir" },
  exs: { label: "Elixir script", fence: "elixir" },
  erl: { label: "Erlang", fence: "erlang" },
  clj: { label: "Clojure", fence: "clojure" },
  r: { label: "R", fence: "r" },
  jl: { label: "Julia", fence: "julia" },
  sh: { label: "Shell", fence: "bash" },
  bash: { label: "Shell", fence: "bash" },
  zsh: { label: "Shell", fence: "bash" },
  fish: { label: "Fish shell", fence: "fish" },
  ps1: { label: "PowerShell", fence: "powershell" },
  psm1: { label: "PowerShell module", fence: "powershell" },
  bat: { label: "Batch", fence: "bat" },
  cmd: { label: "Batch", fence: "bat" },
  sql: { label: "SQL", fence: "sql" },
  css: { label: "CSS", fence: "css" },
  scss: { label: "SCSS", fence: "scss" },
  less: { label: "Less", fence: "less" },
  html: { label: "HTML", fence: "html" },
  htm: { label: "HTML", fence: "html" },
  vue: { label: "Vue", fence: "vue" },
  svelte: { label: "Svelte", fence: "svelte" },
  md: { label: "Markdown", fence: "markdown" },
  markdown: { label: "Markdown", fence: "markdown" },
  xml: { label: "XML", fence: "xml" },
  svg: { label: "SVG", fence: "xml" },
  xaml: { label: "XAML", fence: "xml" },
  plist: { label: "Property list", fence: "xml" },
  yaml: { label: "YAML", fence: "yaml" },
  yml: { label: "YAML", fence: "yaml" },
  toml: { label: "TOML", fence: "toml" },
  ini: { label: "INI", fence: "ini" },
  dockerfile: { label: "Dockerfile", fence: "dockerfile" },
  proto: { label: "Protocol Buffers", fence: "protobuf" },
};

/**
 * Fence name → descriptor, derived from the extension table. LSP language ids
 * (`rust`, `typescript`, `python`) mostly match the fence names rather than our
 * extension keys (`rs`, `ts`, `py`), so this is the primary index for ids.
 * First entry wins, which keeps the canonical label for a shared fence
 * (`cpp` → "C++", not "C++ header").
 */
const LANGUAGES_BY_FENCE: Record<string, LanguageDescriptor> = (() => {
  const byFence: Record<string, LanguageDescriptor> = {};
  for (const descriptor of Object.values(LANGUAGES_BY_EXTENSION)) {
    if (!descriptor.fence) continue;
    if (byFence[descriptor.fence]) continue;
    byFence[descriptor.fence] = descriptor;
  }
  return byFence;
})();

/** LSP language ids that match neither an extension key nor a fence name. */
const LANGUAGES_BY_LSP_ID: Record<string, LanguageDescriptor> = {
  typescriptreact: { label: "TypeScript (TSX)", fence: "tsx" },
  javascriptreact: { label: "JavaScript (JSX)", fence: "jsx" },
  csharp: { label: "C#", fence: "csharp" },
  objectivec: { label: "Objective-C", fence: "objectivec" },
  objectivecpp: { label: "Objective-C++", fence: "objectivec" },
  shellscript: { label: "Shell", fence: "bash" },
  powershell: { label: "PowerShell", fence: "powershell" },
  plaintext: { label: "Plain text", fence: "" },
};

function extensionOf(path: string): string {
  const name = path.toLowerCase().replace(/[\\/]+$/, "");
  const segments = name.split(/[\\/]+/);
  const base = segments[segments.length - 1] ?? "";
  // Extensionless files whose name is the language (Dockerfile, Makefile).
  if (!base.includes(".")) return base;
  return base.slice(base.lastIndexOf(".") + 1);
}

/**
 * Resolve the language for a buffer. The LSP-reported `languageId` wins when a
 * server is attached — it is authoritative — with the extension table as the
 * fallback for buffers with no language server.
 */
function descriptorFor(languageId: string | null | undefined, path: string): LanguageDescriptor | null {
  const id = (languageId ?? "").trim().toLowerCase();
  if (id) {
    const byId = LANGUAGES_BY_LSP_ID[id]
      ?? LANGUAGES_BY_FENCE[id]
      ?? LANGUAGES_BY_EXTENSION[id];
    if (byId) return byId;
  }
  return LANGUAGES_BY_EXTENSION[extensionOf(path)] ?? null;
}

/** Human-readable language name for the prompt body, or null when unknown. */
export function languageLabelFor(languageId: string | null | undefined, path: string): string | null {
  return descriptorFor(languageId, path)?.label ?? null;
}

/**
 * Markdown fence info string. Empty when unknown so the fence degrades to a
 * plain block rather than claiming the wrong grammar.
 */
export function fenceLanguageFor(languageId: string | null | undefined, path: string): string {
  return descriptorFor(languageId, path)?.fence ?? "";
}

// ── Context extraction ───────────────────────────────────────────────────────

/**
 * Import-ish line patterns per fence language. Imports tell the model where the
 * types in the selection come from, which is often the difference between a
 * correct explanation and a guess.
 */
const IMPORT_PATTERNS: Array<{ fences: string[]; pattern: RegExp }> = [
  { fences: ["rust"], pattern: /^\s*(?:pub\s+)?(?:use|extern\s+crate)\s/ },
  {
    fences: ["typescript", "tsx", "javascript", "jsx", "vue", "svelte"],
    pattern: /^\s*(?:import\s|export\s+(?:\*|\{)[^=]*\sfrom\s|const\s+\w+\s*=\s*require\()/,
  },
  { fences: ["python"], pattern: /^\s*(?:import\s|from\s+\S+\s+import\s)/ },
  { fences: ["go"], pattern: /^\s*(?:import\s|\t"[^"]+"\s*$|\t\w+\s+"[^"]+"\s*$)/ },
  { fences: ["java", "kotlin", "scala", "groovy", "dart"], pattern: /^\s*import\s/ },
  { fences: ["csharp"], pattern: /^\s*(?:using\s|global\s+using\s)/ },
  { fences: ["c", "cpp", "objectivec"], pattern: /^\s*#\s*(?:include|import)\s/ },
  { fences: ["php"], pattern: /^\s*(?:use|require|require_once|include|include_once)\s/ },
  { fences: ["ruby"], pattern: /^\s*(?:require|require_relative|include|extend)\s/ },
  { fences: ["swift"], pattern: /^\s*(?:import|@_exported\s+import)\s/ },
  { fences: ["elixir"], pattern: /^\s*(?:import|alias|require|use)\s/ },
  { fences: ["haskell"], pattern: /^\s*import\s/ },
  { fences: ["lua"], pattern: /^\s*local\s+\w+\s*=\s*require\s*\(?/ },
  { fences: ["perl"], pattern: /^\s*(?:use|require)\s/ },
  { fences: ["powershell"], pattern: /^\s*(?:using\s+(?:module|namespace)|Import-Module)\s/i },
  { fences: ["zig"], pattern: /^\s*(?:pub\s+)?const\s+\w+\s*=\s*@import\s*\(/ },
];

/**
 * Pull import-like lines from the head of the file. Scans only the header
 * region: imports appear at the top in every language we cover, and scanning
 * the whole file would pick up unrelated matches from strings and comments.
 */
export function extractImports(
  fileText: string,
  fenceLanguage: string,
  maxLines: number = MAX_IMPORT_LINES,
): string[] {
  if (maxLines <= 0) return [];
  const entry = IMPORT_PATTERNS.find((candidate) => candidate.fences.includes(fenceLanguage));
  if (!entry) return [];
  const lines = fileText.split("\n");
  // Header region: generous enough for a long import block, bounded so a file
  // with no imports does not cost a full scan.
  const scanLimit = Math.min(lines.length, 400);
  const found: string[] = [];
  for (let index = 0; index < scanLimit; index += 1) {
    const line = lines[index] ?? "";
    if (!entry.pattern.test(line)) continue;
    found.push(line.trim());
    if (found.length >= maxLines) break;
  }
  return found;
}

/**
 * Context lines around the selection. `startLine` / `endLine` are 1-based and
 * inclusive, matching what the prompt reports to the model.
 */
export function surroundingLines(
  fileText: string,
  startLine: number,
  endLine: number,
  radius: number = CONTEXT_LINE_RADIUS,
): { before: string[]; after: string[] } {
  if (radius <= 0) return { before: [], after: [] };
  const lines = fileText.split("\n");
  const firstIndex = Math.max(0, startLine - 1);
  const lastIndex = Math.min(lines.length - 1, endLine - 1);
  const before = lines.slice(Math.max(0, firstIndex - radius), firstIndex);
  const after = lines.slice(lastIndex + 1, Math.min(lines.length, lastIndex + 1 + radius));
  return { before, after };
}

/**
 * Describe the enclosing symbol chain, outermost first, as
 * `Name (kind)` entries. Answers "what am I inside of?" for a selection that is
 * only a fragment — e.g. an `impl` header with its body collapsed.
 */
export function describeScopeChain(symbols: LspDocumentSymbol[]): string[] {
  return [...symbols]
    .sort((left, right) => left.depth - right.depth)
    .map((symbol) => {
      const kind = symbolKindLabel(symbol.kind);
      const detail = symbol.detail?.trim();
      const suffix = detail ? ` — ${detail}` : "";
      return `${symbol.name} (${kind})${suffix}`;
    });
}

// ── Prompt templates ─────────────────────────────────────────────────────────

interface ActionTemplate {
  /** Opening directive. */
  lead: string;
  /** Numbered requirements. */
  requirements: string[];
  /** Closing guidance. */
  closing?: string;
}

const TEMPLATES: Record<ResolvedAnswerLanguage, Record<EditorAiAction, ActionTemplate>> = {
  "zh-CN": {
    explain: {
      lead: "请解释下面这段代码的作用、关键逻辑和潜在问题。",
      requirements: [
        "这段代码做什么，输入输出和主要流程是什么；",
        "关键逻辑的实现思路，以及它在整个文件/模块里承担的职责；",
        "存在哪些潜在问题或风险（边界条件、错误处理、并发、性能、安全等）。",
      ],
    },
    syntax: {
      lead: "请把下面这段代码当作教学示例，讲解其中用到的语言语法与写法，帮助我打好语言基础。",
      requirements: [
        "逐一说明用到的语法结构、关键字和语言特性（例如声明方式、控制流、类型、作用域、生命周期、异步、装饰器/宏、泛型、错误处理等），解释它们的含义和规则；",
        "为什么这里会这样写，这种写法解决了什么问题、有什么好处或注意事项（可读性、性能、安全、惯用法等）；",
        "还有哪些等价的其它写法，并对比各自的优缺点；",
        "在这个场景下哪种写法更合适，给出你的推荐和理由。",
      ],
      closing: "请用通俗易懂的方式讲解，必要时配简短示例。如果选区只是一个片段（例如只有声明头、缺少函数体），请结合下面提供的上下文来讲，并说明该语法结构完整的形态是什么样的。",
    },
    fix: {
      lead: "请修复下面这段代码中的问题，保持原有意图。",
      requirements: [
        "先简要说明问题的根因（如果下面列出了诊断信息，请逐条对应）；",
        "给出修复后的完整代码块，保持原有缩进风格和命名习惯；",
        "说明修复为什么正确，以及是否还有其它需要注意的隐患。",
      ],
      closing: "修复后的代码请放在单独的代码块里，方便直接复制。",
    },
    rewrite: {
      lead: "请按指令改写下面的代码。",
      requirements: [
        "给出改写后的完整代码块，保持原有缩进风格和命名习惯；",
        "简要说明你做了哪些改动以及为什么；",
        "如果指令有歧义或存在无法保证等价的地方，请明确指出。",
      ],
      closing: "改写后的代码请放在单独的代码块里，方便直接复制。",
    },
  },
  en: {
    explain: {
      lead: "Explain what the following code does, its key logic, and any potential problems.",
      requirements: [
        "What this code does — inputs, outputs, and the main flow;",
        "How the key logic works, and the role it plays in the wider file/module;",
        "Any potential problems or risks (edge cases, error handling, concurrency, performance, security).",
      ],
    },
    syntax: {
      lead: "Treat the following code as a teaching example and walk me through the language syntax it uses, so I build a solid foundation in the language.",
      requirements: [
        "Go through each syntax construct, keyword, and language feature used (declarations, control flow, types, scoping, lifetimes, async, decorators/macros, generics, error handling, and so on), explaining what it means and the rules that govern it;",
        "Why the code is written this way here — what problem this style solves, and its benefits or caveats (readability, performance, safety, idiom);",
        "What equivalent alternative styles exist, with the trade-offs of each;",
        "Which style fits best in this context, with your recommendation and reasoning.",
      ],
      closing: "Explain it in plain language, with short examples where they help. If the selection is only a fragment (for example a declaration header with no body), use the context provided below and describe what the complete form of that construct looks like.",
    },
    fix: {
      lead: "Fix the problems in the following code while preserving its original intent.",
      requirements: [
        "First state the root cause briefly (address each diagnostic listed below, if any);",
        "Give the complete fixed code block, keeping the existing indentation style and naming conventions;",
        "Explain why the fix is correct, and whether any related hazards remain.",
      ],
      closing: "Put the fixed code in its own code block so it can be copied directly.",
    },
    rewrite: {
      lead: "Rewrite the following code according to the instruction.",
      requirements: [
        "Give the complete rewritten code block, keeping the existing indentation style and naming conventions;",
        "Briefly state what you changed and why;",
        "Call out anything ambiguous in the instruction, or anywhere equivalence cannot be guaranteed.",
      ],
      closing: "Put the rewritten code in its own code block so it can be copied directly.",
    },
  },
};

interface Labels {
  contextHeading: string;
  file: string;
  language: string;
  lines: string;
  scope: string;
  imports: string;
  diagnostics: string;
  typeInfo: string;
  before: string;
  after: string;
  selectionHeading: string;
  instruction: string;
  truncatedNote: string;
  answerDirective: string;
}

const LABELS: Record<ResolvedAnswerLanguage, Labels> = {
  "zh-CN": {
    contextHeading: "## 上下文",
    file: "文件",
    language: "语言",
    lines: "选区行号",
    scope: "所属作用域（由外到内）",
    imports: "文件导入",
    diagnostics: "选区内的诊断信息",
    typeInfo: "语言服务给出的类型信息",
    before: "选区之前的代码",
    after: "选区之后的代码",
    selectionHeading: "## 选中的代码",
    instruction: "指令",
    truncatedNote: "注意：选区过长，中间部分已被省略（省略处已标注），这不是代码本身的语法错误。",
    answerDirective: "请用中文回答。",
  },
  en: {
    contextHeading: "## Context",
    file: "File",
    language: "Language",
    lines: "Selected lines",
    scope: "Enclosing scope (outermost first)",
    imports: "File imports",
    diagnostics: "Diagnostics inside the selection",
    typeInfo: "Type information from the language server",
    before: "Code before the selection",
    after: "Code after the selection",
    selectionHeading: "## Selected code",
    instruction: "Instruction",
    truncatedNote: "Note: the selection was long, so its middle was omitted (marked inline) — that gap is not a syntax error in the code.",
    answerDirective: "Answer in English.",
  },
};

function fencedBlock(body: string, fence: string): string[] {
  return [`\`\`\`${fence}`, body, "```"];
}

function clampHover(hover: string): string {
  const trimmed = hover.trim();
  if (trimmed.length <= MAX_HOVER_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_HOVER_CHARS)}…`;
}

/**
 * Build the prompt for an editor AI action.
 *
 * Layout is deliberate: the directive and its requirements come first, the
 * gathered context next, and the selected code last. Trailing code keeps the
 * instructions from being buried under a long paste, and the fence carries the
 * real language id so the model does not have to infer the grammar.
 */
export function buildEditorAiPrompt(
  context: EditorAiContext,
  preference: AiAnswerLanguage,
): string {
  const language = resolveAnswerLanguage(preference);
  const template = TEMPLATES[language][context.action];
  const labels = LABELS[language];
  const fence = context.fenceLanguage;

  const lines: string[] = [template.lead, ""];

  template.requirements.forEach((requirement, index) => {
    lines.push(`${index + 1}. ${requirement}`);
  });

  if (template.closing) {
    lines.push("", template.closing);
  }

  // ── Context block ──
  const contextLines: string[] = [];
  contextLines.push(`- ${labels.file}: ${context.filePath}`);
  if (context.languageLabel) {
    contextLines.push(`- ${labels.language}: ${context.languageLabel}`);
  }
  contextLines.push(
    context.selectionStartLine === context.selectionEndLine
      ? `- ${labels.lines}: ${context.selectionStartLine}`
      : `- ${labels.lines}: ${context.selectionStartLine}-${context.selectionEndLine}`,
  );
  if (context.scopeChain.length > 0) {
    contextLines.push(`- ${labels.scope}: ${context.scopeChain.join(" › ")}`);
  }
  if (context.action === "rewrite" && context.instruction?.trim()) {
    contextLines.push(`- ${labels.instruction}: ${context.instruction.trim()}`);
  }

  lines.push("", labels.contextHeading, ...contextLines);

  if (context.diagnostics.length > 0) {
    lines.push("", `${labels.diagnostics}:`);
    context.diagnostics.slice(0, MAX_DIAGNOSTICS).forEach((diagnostic) => {
      lines.push(`- ${diagnostic}`);
    });
  }

  if (context.hover?.trim()) {
    lines.push("", `${labels.typeInfo}:`, ...fencedBlock(clampHover(context.hover), ""));
  }

  if (context.imports.length > 0) {
    lines.push("", `${labels.imports}:`, ...fencedBlock(context.imports.join("\n"), fence));
  }

  if (context.linesBefore.length > 0) {
    lines.push("", `${labels.before}:`, ...fencedBlock(context.linesBefore.join("\n"), fence));
  }

  if (context.linesAfter.length > 0) {
    lines.push("", `${labels.after}:`, ...fencedBlock(context.linesAfter.join("\n"), fence));
  }

  // ── Selection last ──
  lines.push("", labels.selectionHeading);
  if (context.truncated) {
    lines.push(labels.truncatedNote);
  }
  lines.push(...fencedBlock(context.selection, fence));

  lines.push("", labels.answerDirective);

  return lines.join("\n");
}
