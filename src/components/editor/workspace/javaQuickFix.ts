/**
 * NON-PRODUCTION / TEST FIXTURE ONLY (§8.14.2 J0 Containment).
 * Do not import or execute in production completion or code-action paths.
 */

import type { LspCodeAction, LspPosition, LspWorkspaceEdit } from "../../../lib/editor/lsp";

export const JDK_KNOWN_TYPES: Record<string, string[]> = {
  // Collections & Utilities
  List: ["java.util.List", "java.awt.List"],
  ArrayList: ["java.util.ArrayList"],
  LinkedList: ["java.util.LinkedList"],
  Map: ["java.util.Map"],
  HashMap: ["java.util.HashMap"],
  LinkedHashMap: ["java.util.LinkedHashMap"],
  TreeMap: ["java.util.TreeMap"],
  ConcurrentHashMap: ["java.util.concurrent.ConcurrentHashMap"],
  Set: ["java.util.Set"],
  HashSet: ["java.util.HashSet"],
  LinkedHashSet: ["java.util.LinkedHashSet"],
  TreeSet: ["java.util.TreeSet"],
  Queue: ["java.util.Queue"],
  Deque: ["java.util.Deque"],
  ArrayDeque: ["java.util.ArrayDeque"],
  PriorityQueue: ["java.util.PriorityQueue"],
  Collection: ["java.util.Collection"],
  Collections: ["java.util.Collections"],
  Arrays: ["java.util.Arrays"],
  Objects: ["java.util.Objects"],
  Optional: ["java.util.Optional"],
  UUID: ["java.util.UUID"],
  Date: ["java.util.Date", "java.sql.Date"],
  Calendar: ["java.util.Calendar"],
  Random: ["java.util.Random"],
  Scanner: ["java.util.Scanner"],
  StringJoiner: ["java.util.StringJoiner"],
  Properties: ["java.util.Properties"],
  Locale: ["java.util.Locale"],
  TimeZone: ["java.util.TimeZone"],
  Currency: ["java.util.Currency"],

  // Streams & Functional
  Stream: ["java.util.stream.Stream"],
  Collectors: ["java.util.stream.Collectors"],
  IntStream: ["java.util.stream.IntStream"],
  LongStream: ["java.util.stream.LongStream"],
  DoubleStream: ["java.util.stream.DoubleStream"],
  Function: ["java.util.function.Function"],
  BiFunction: ["java.util.function.BiFunction"],
  Consumer: ["java.util.function.Consumer"],
  BiConsumer: ["java.util.function.BiConsumer"],
  Supplier: ["java.util.function.Supplier"],
  Predicate: ["java.util.function.Predicate"],
  BiPredicate: ["java.util.function.BiPredicate"],
  UnaryOperator: ["java.util.function.UnaryOperator"],
  BinaryOperator: ["java.util.function.BinaryOperator"],

  // Concurrency
  CompletableFuture: ["java.util.concurrent.CompletableFuture"],
  Future: ["java.util.concurrent.Future"],
  Callable: ["java.util.concurrent.Callable"],
  ExecutorService: ["java.util.concurrent.ExecutorService"],
  Executors: ["java.util.concurrent.Executors"],
  ScheduledExecutorService: ["java.util.concurrent.ScheduledExecutorService"],
  CountDownLatch: ["java.util.concurrent.CountDownLatch"],
  CyclicBarrier: ["java.util.concurrent.CyclicBarrier"],
  Semaphore: ["java.util.concurrent.Semaphore"],
  TimeUnit: ["java.util.concurrent.TimeUnit"],
  CopyOnWriteArrayList: ["java.util.concurrent.CopyOnWriteArrayList"],
  CopyOnWriteArraySet: ["java.util.concurrent.CopyOnWriteArraySet"],
  AtomicInteger: ["java.util.concurrent.atomic.AtomicInteger"],
  AtomicLong: ["java.util.concurrent.atomic.AtomicLong"],
  AtomicBoolean: ["java.util.concurrent.atomic.AtomicBoolean"],
  AtomicReference: ["java.util.concurrent.atomic.AtomicReference"],
  ReentrantLock: ["java.util.concurrent.locks.ReentrantLock"],
  ReentrantReadWriteLock: ["java.util.concurrent.locks.ReentrantReadWriteLock"],

  // I/O & NIO
  File: ["java.io.File"],
  Path: ["java.nio.file.Path"],
  Paths: ["java.nio.file.Paths"],
  Files: ["java.nio.file.Files"],
  InputStream: ["java.io.InputStream"],
  OutputStream: ["java.io.OutputStream"],
  FileInputStream: ["java.io.FileInputStream"],
  FileOutputStream: ["java.io.FileOutputStream"],
  ByteArrayInputStream: ["java.io.ByteArrayInputStream"],
  ByteArrayOutputStream: ["java.io.ByteArrayOutputStream"],
  BufferedReader: ["java.io.BufferedReader"],
  BufferedWriter: ["java.io.BufferedWriter"],
  FileReader: ["java.io.FileReader"],
  FileWriter: ["java.io.FileWriter"],
  InputStreamReader: ["java.io.InputStreamReader"],
  OutputStreamWriter: ["java.io.OutputStreamWriter"],
  PrintWriter: ["java.io.PrintWriter"],
  PrintStream: ["java.io.PrintStream"],
  IOException: ["java.io.IOException"],
  Serializable: ["java.io.Serializable"],
  Closeable: ["java.io.Closeable"],

  // Math
  BigDecimal: ["java.math.BigDecimal"],
  BigInteger: ["java.math.BigInteger"],
  RoundingMode: ["java.math.RoundingMode"],
  MathContext: ["java.math.MathContext"],

  // Networking & URI
  URI: ["java.net.URI"],
  URL: ["java.net.URL"],
  HttpURLConnection: ["java.net.HttpURLConnection"],
  InetAddress: ["java.net.InetAddress"],
  Socket: ["java.net.Socket"],
  ServerSocket: ["java.net.ServerSocket"],

  // Time (java.time)
  LocalDate: ["java.time.LocalDate"],
  LocalTime: ["java.time.LocalTime"],
  LocalDateTime: ["java.time.LocalDateTime"],
  ZonedDateTime: ["java.time.ZonedDateTime"],
  Instant: ["java.time.Instant"],
  Duration: ["java.time.Duration"],
  Period: ["java.time.Period"],
  ZoneId: ["java.time.ZoneId"],
  OffsetDateTime: ["java.time.OffsetDateTime"],
  OffsetTime: ["java.time.OffsetTime"],
  DateTimeFormatter: ["java.time.format.DateTimeFormatter"],

  // Text & Regex
  SimpleDateFormat: ["java.text.SimpleDateFormat"],
  DecimalFormat: ["java.text.DecimalFormat"],
  NumberFormat: ["java.text.NumberFormat"],
  Pattern: ["java.util.regex.Pattern"],
  Matcher: ["java.util.regex.Matcher"],

  // Common popular libraries
  Logger: ["java.util.logging.Logger", "org.slf4j.Logger"],
  LoggerFactory: ["org.slf4j.LoggerFactory"],
  NonNull: ["org.springframework.lang.NonNull", "lombok.NonNull"],
  Nullable: ["org.springframework.lang.Nullable"],
};

/**
 * Extracts a Java identifier at or near the given cursor position in the document text.
 */
export function extractJavaIdentifierAtPosition(
  docText: string,
  position: LspPosition,
): string | null {
  const lines = docText.split(/\r?\n/);
  const line = lines[position.line];
  if (line == null) return null;

  const char = position.character;
  const isIdentChar = (c: string) => /[a-zA-Z0-9_$]/.test(c);

  // If cursor is at or adjacent to an identifier character
  let start = Math.min(char, line.length);
  while (start > 0 && isIdentChar(line[start - 1] ?? "")) {
    start--;
  }

  let end = Math.min(char, line.length);
  while (end < line.length && isIdentChar(line[end] ?? "")) {
    end++;
  }

  if (start < end) {
    const word = line.slice(start, end);
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(word) && JDK_KNOWN_TYPES[word]) {
      return word;
    }
  }

  // Also check if any unimported identifier exists on the entire line
  const matches = line.match(/\b([A-Z][a-zA-Z0-9_$]*)\b/g);
  if (matches && matches.length > 0) {
    for (const match of matches) {
      if (JDK_KNOWN_TYPES[match]) {
        return match;
      }
    }
  }

  return null;
}

/**
 * Checks whether a given fully qualified class or simple class name is already imported
 * or declared in the current Java document.
 */
export function isJavaTypeImported(docText: string, fqcn: string, simpleName: string): boolean {
  const lines = docText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (
      line === `import ${fqcn};` ||
      line === `import static ${fqcn};` ||
      line === `import static ${fqcn}.*;` ||
      (line.startsWith("import ") && line.endsWith(`.${simpleName};`))
    ) {
      return true;
    }
    // Check wildcard imports like java.util.*
    const pkg = fqcn.substring(0, fqcn.lastIndexOf("."));
    if (line === `import ${pkg}.*;`) {
      return true;
    }
    // Check package declaration (same package)
    if (line.startsWith("package ") && line.endsWith(";")) {
      const currentPkg = line.slice(8, -1).trim();
      if (currentPkg === pkg) {
        return true;
      }
    }
    // Check if class/interface/enum with same name is declared in this file
    if (
      line.startsWith(`public class ${simpleName}`) ||
      line.startsWith(`class ${simpleName}`) ||
      line.startsWith(`public interface ${simpleName}`) ||
      line.startsWith(`interface ${simpleName}`) ||
      line.startsWith(`public enum ${simpleName}`) ||
      line.startsWith(`enum ${simpleName}`) ||
      line.startsWith(`public record ${simpleName}`) ||
      line.startsWith(`record ${simpleName}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generates an LSP WorkspaceEdit that inserts the import statement into the Java document.
 */
export function generateJavaImportWorkspaceEdit(
  filePath: string,
  docText: string,
  fqcn: string,
): LspWorkspaceEdit {
  const eol = docText.includes("\r\n") ? "\r\n" : "\n";
  const lines = docText.split(/\r?\n/);

  let insertLine = 0;
  let insertPrefix = "";
  let insertSuffix = eol;

  let packageLineIndex = -1;
  let lastImportLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith("package ") && trimmed.endsWith(";")) {
      packageLineIndex = i;
    } else if (trimmed.startsWith("import ") && trimmed.endsWith(";")) {
      lastImportLineIndex = i;
    }
  }

  if (lastImportLineIndex !== -1) {
    // Insert after the last import statement
    insertLine = lastImportLineIndex + 1;
    insertPrefix = "";
    insertSuffix = eol;
  } else if (packageLineIndex !== -1) {
    // Insert after the package statement with a leading blank line
    insertLine = packageLineIndex + 1;
    insertPrefix = eol;
    insertSuffix = eol;
  } else {
    // Top of file
    insertLine = 0;
    insertPrefix = "";
    insertSuffix = eol + eol;
  }

  const importStatement = `${insertPrefix}import ${fqcn};${insertSuffix}`;

  const uri = filePath.startsWith("file://")
    ? filePath
    : `file://${filePath.startsWith("/") ? "" : "/"}${filePath}`;

  return {
    documentEdits: [
      {
        uri,
        path: filePath,
        edits: [
          {
            range: {
              start: { line: insertLine, character: 0 },
              end: { line: insertLine, character: 0 },
            },
            newText: importStatement,
          },
        ],
      },
    ],
    operations: [],
  };
}

/**
 * Creates Java quick fix CodeAction items for unimported JDK classes at the cursor position.
 */
export function createJavaImportCodeActions(
  filePath: string,
  docText: string,
  position: LspPosition,
): LspCodeAction[] {
  const symbol = extractJavaIdentifierAtPosition(docText, position);
  if (!symbol) return [];

  const candidates = JDK_KNOWN_TYPES[symbol];
  if (!candidates || candidates.length === 0) return [];

  const actions: LspCodeAction[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const fqcn = candidates[i]!;
    if (isJavaTypeImported(docText, fqcn, symbol)) {
      continue;
    }

    const edit = generateJavaImportWorkspaceEdit(filePath, docText, fqcn);
    actions.push({
      title: `Import '${symbol}' (${fqcn})`,
      kind: "quickfix",
      isPreferred: i === 0,
      edit,
      command: null,
      commandArguments: null,
      raw: {
        title: `Import '${symbol}' (${fqcn})`,
        kind: "quickfix",
        isPreferred: i === 0,
        edit,
      },
    });
  }

  return actions;
}

export interface JavaJdkCompletionItem {
  label: string;
  detail: string;
  type: string;
  boost: number;
}

/**
 * Returns candidate JDK completions for a typed prefix in a Java document.
 */
export function getJavaJdkCompletionCandidates(
  typedPrefix: string,
  docText: string,
): JavaJdkCompletionItem[] {
  if (!typedPrefix || typedPrefix.length === 0) return [];
  const lowerPrefix = typedPrefix.toLowerCase();
  const results: JavaJdkCompletionItem[] = [];

  for (const [simpleName, fqcns] of Object.entries(JDK_KNOWN_TYPES)) {
    if (simpleName.toLowerCase().startsWith(lowerPrefix)) {
      for (const fqcn of fqcns) {
        const isImported = isJavaTypeImported(docText, fqcn, simpleName);
        const matchBoost = simpleName === typedPrefix ? 40 : simpleName.startsWith(typedPrefix) ? 20 : 0;
        const importBoost = isImported ? 10 : 0;
        results.push({
          label: simpleName,
          detail: fqcn,
          type: "class",
          boost: matchBoost + importBoost,
        });
      }
    }
  }

  return results.sort((a, b) => b.boost - a.boost);
}
