/**
 * IDEA-style Live Templates (and a small set of postfix templates).
 *
 * Abbreviations such as `sout` / `psvm` / `fori` expand via the completion
 * popup or Tab, using CodeMirror snippet tabstops so the caret lands on the
 * next editable field — the same muscle memory as IntelliJ.
 */
import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  loadLiveTemplatePreferences,
  subscribeLiveTemplatePreferences,
  type CustomLiveTemplate,
  type LiveTemplateLanguage,
  type LiveTemplatePreferences,
} from "../../../lib/liveTemplatePreferences";
import { isInsideStringOrComment } from "./syntaxContext";

export type { LiveTemplateLanguage };

export interface LiveTemplate {
  /** Typed abbreviation, e.g. `sout`. */
  abbreviation: string;
  /**
   * CodeMirror snippet body. Placeholders: `${name}` (linked by name),
   * `${}` empty tabstop. Newlines are indented to the caret column by CM.
   */
  body: string;
  /** Short description shown as the completion detail. */
  description: string;
  languages: readonly LiveTemplateLanguage[];
  /**
   * When true, matches `expr.abbr` (IDEA postfix completion) and substitutes
   * `$EXPR$` in the body with the left-hand expression text.
   */
  postfix?: boolean;
}

/** High boost so exact live templates beat ordinary LSP members. */
export const LIVE_TEMPLATE_EXACT_BOOST = 800;
export const LIVE_TEMPLATE_PREFIX_BOOST = 450;
export const LIVE_TEMPLATE_POSTFIX_BOOST = 700;

export function liveTemplateLanguageForPath(path: string | null | undefined): LiveTemplateLanguage {
  const name = (path ?? "").toLowerCase();
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  switch (ext) {
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    default:
      return "generic";
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────

const JAVA_TEMPLATES: LiveTemplate[] = [
  // Output (IDEA Output group)
  {
    abbreviation: "sout",
    body: "System.out.println(${});",
    description: "Prints a string to System.out",
    languages: ["java"],
  },
  {
    abbreviation: "soutm",
    body: "System.out.println(\"${MethodName}\");",
    description: "Prints current method name to System.out",
    languages: ["java"],
  },
  {
    abbreviation: "soutp",
    body: "System.out.println(${});",
    description: "Prints method parameter names and values",
    languages: ["java"],
  },
  {
    abbreviation: "soutv",
    body: "System.out.println(\"${expr} = \" + ${expr});",
    description: "Prints a value to System.out",
    languages: ["java"],
  },
  {
    abbreviation: "serr",
    body: "System.err.println(${});",
    description: "Prints a string to System.err",
    languages: ["java"],
  },
  {
    abbreviation: "souf",
    body: "System.out.printf(\"${format}\"${});",
    description: "printf to System.out",
    languages: ["java"],
  },
  // Main / modifiers
  {
    abbreviation: "psvm",
    body: "public static void main(String[] args) {\n\t${}\n}",
    description: "public static void main",
    languages: ["java"],
  },
  {
    abbreviation: "main",
    body: "public static void main(String[] args) {\n\t${}\n}",
    description: "public static void main",
    languages: ["java"],
  },
  {
    abbreviation: "psfs",
    body: "public static final String ${NAME} = \"${}\";",
    description: "public static final String",
    languages: ["java"],
  },
  {
    abbreviation: "psfi",
    body: "public static final int ${NAME} = ${0};",
    description: "public static final int",
    languages: ["java"],
  },
  {
    abbreviation: "psf",
    body: "public static final ${Type} ${NAME} = ${};",
    description: "public static final field",
    languages: ["java"],
  },
  {
    abbreviation: "prsf",
    body: "private static final ${Type} ${NAME} = ${};",
    description: "private static final field",
    languages: ["java"],
  },
  // Control flow
  {
    abbreviation: "fori",
    body: "for (int ${i} = 0; ${i} < ${}; ${i}++) {\n\t${}\n}",
    description: "Create iteration loop",
    languages: ["java"],
  },
  {
    abbreviation: "forr",
    body: "for (int ${i} = ${}; ${i} >= 0; ${i}--) {\n\t${}\n}",
    description: "Create reverse iteration loop",
    languages: ["java"],
  },
  {
    abbreviation: "iter",
    body: "for (${Type} ${item} : ${iterable}) {\n\t${}\n}",
    description: "Iterate over an Iterable",
    languages: ["java"],
  },
  {
    abbreviation: "itco",
    body: "for (${Type} ${item} : ${collection}) {\n\t${}\n}",
    description: "Iterate elements of java.util.Collection",
    languages: ["java"],
  },
  {
    abbreviation: "itar",
    body: "for (int ${i} = 0; ${i} < ${array}.length; ${i}++) {\n\t${Type} ${var} = ${array}[${i}];\n\t${}\n}",
    description: "Iterate elements of an array",
    languages: ["java"],
  },
  {
    abbreviation: "ifn",
    body: "if (${var} == null) {\n\t${}\n}",
    description: "Inserts null check",
    languages: ["java"],
  },
  {
    abbreviation: "inn",
    body: "if (${var} != null) {\n\t${}\n}",
    description: "Inserts not-null check",
    languages: ["java"],
  },
  {
    abbreviation: "inst",
    body: "if (${expr} instanceof ${Type} ${name}) {\n\t${}\n}",
    description: "Check object type with pattern match",
    languages: ["java"],
  },
  {
    abbreviation: "if",
    body: "if (${}) {\n\t${}\n}",
    description: "if statement",
    languages: ["java"],
  },
  {
    abbreviation: "else",
    body: "else {\n\t${}\n}",
    description: "else block",
    languages: ["java"],
  },
  {
    abbreviation: "elif",
    body: "else if (${}) {\n\t${}\n}",
    description: "else if statement",
    languages: ["java"],
  },
  {
    abbreviation: "wh",
    body: "while (${}) {\n\t${}\n}",
    description: "while loop",
    languages: ["java"],
  },
  {
    abbreviation: "tw",
    body: "try {\n\t${}\n} catch (${Exception} e) {\n\t${}\n}",
    description: "try/catch",
    languages: ["java"],
  },
  {
    abbreviation: "tcf",
    body: "try {\n\t${}\n} catch (${Exception} e) {\n\t${}\n} finally {\n\t${}\n}",
    description: "try/catch/finally",
    languages: ["java"],
  },
  {
    abbreviation: "tryf",
    body: "try {\n\t${}\n} finally {\n\t${}\n}",
    description: "try/finally",
    languages: ["java"],
  },
  {
    abbreviation: "tryc",
    body: "try (${resource}) {\n\t${}\n} catch (${Exception} e) {\n\t${}\n}",
    description: "try-with-resources",
    languages: ["java"],
  },
  {
    abbreviation: "thr",
    body: "throw new ${Exception}(${});",
    description: "throw new exception",
    languages: ["java"],
  },
  {
    abbreviation: "throe",
    body: "throw new ${Exception}(${});",
    description: "throw new exception",
    languages: ["java"],
  },
  {
    abbreviation: "sw",
    body: "switch (${}) {\n\tcase ${}:\n\t\t${}\n\t\tbreak;\n\tdefault:\n\t\t${}\n}",
    description: "switch statement",
    languages: ["java"],
  },
  {
    abbreviation: "syn",
    body: "synchronized (${this}) {\n\t${}\n}",
    description: "synchronized block",
    languages: ["java"],
  },
  // Types / stubs
  {
    abbreviation: "St",
    body: "String",
    description: "String type",
    languages: ["java"],
  },
  {
    abbreviation: "cls",
    body: "public class ${Name} {\n\t${}\n}",
    description: "class",
    languages: ["java"],
  },
  {
    abbreviation: "m",
    body: "${public} ${void} ${name}(${}) {\n\t${}\n}",
    description: "method",
    languages: ["java"],
  },
  // Postfix templates (expr.abbr)
  {
    abbreviation: "sout",
    body: "System.out.println($EXPR$);",
    description: "Prints expression to System.out",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "serr",
    body: "System.err.println($EXPR$);",
    description: "Prints expression to System.err",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "var",
    body: "var ${name} = $EXPR$;",
    description: "Introduce local variable",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "val",
    body: "final var ${name} = $EXPR$;",
    description: "Introduce final local variable",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "nn",
    body: "if ($EXPR$ != null) {\n\t${}\n}",
    description: "Introduce null check",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "notnull",
    body: "if ($EXPR$ != null) {\n\t${}\n}",
    description: "Introduce null check",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "null",
    body: "if ($EXPR$ == null) {\n\t${}\n}",
    description: "Introduce null check",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "for",
    body: "for (${Type} ${item} : $EXPR$) {\n\t${}\n}",
    description: "Iterate over expression",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "fori",
    body: "for (int ${i} = 0; ${i} < $EXPR$.length; ${i}++) {\n\t${}\n}",
    description: "Iterate with index",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$;",
    description: "Return expression",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "cast",
    body: "(($EXPRTYPE$) $EXPR$)",
    description: "Casts expression",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "if",
    body: "if ($EXPR$) {\n\t${}\n}",
    description: "if expression",
    languages: ["java"],
    postfix: true,
  },
  {
    abbreviation: "while",
    body: "while ($EXPR$) {\n\t${}\n}",
    description: "while expression",
    languages: ["java"],
    postfix: true,
  },
];

const KOTLIN_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "println(${})",
    description: "Prints a string to stdout",
    languages: ["kotlin"],
  },
  {
    abbreviation: "soutv",
    body: "println(\"${expr} = $${expr}\")",
    description: "Prints a value",
    languages: ["kotlin"],
  },
  {
    abbreviation: "main",
    body: "fun main(args: Array<String>) {\n\t${}\n}",
    description: "main function",
    languages: ["kotlin"],
  },
  {
    abbreviation: "psvm",
    body: "fun main(args: Array<String>) {\n\t${}\n}",
    description: "main function",
    languages: ["kotlin"],
  },
  {
    abbreviation: "fori",
    body: "for (${i} in 0 until ${}) {\n\t${}\n}",
    description: "for loop with index",
    languages: ["kotlin"],
  },
  {
    abbreviation: "iter",
    body: "for (${item} in ${iterable}) {\n\t${}\n}",
    description: "Iterate collection",
    languages: ["kotlin"],
  },
  {
    abbreviation: "ifn",
    body: "if (${var} == null) {\n\t${}\n}",
    description: "null check",
    languages: ["kotlin"],
  },
  {
    abbreviation: "inn",
    body: "if (${var} != null) {\n\t${}\n}",
    description: "not-null check",
    languages: ["kotlin"],
  },
  {
    abbreviation: "todo",
    body: "TODO(\"${}\")",
    description: "TODO stub",
    languages: ["kotlin"],
  },
  {
    abbreviation: "sout",
    body: "println($EXPR$)",
    description: "Print expression",
    languages: ["kotlin"],
    postfix: true,
  },
  {
    abbreviation: "nn",
    body: "if ($EXPR$ != null) {\n\t${}\n}",
    description: "not-null check",
    languages: ["kotlin"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["kotlin"],
    postfix: true,
  },
];

const JS_TS_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "console.log(${});",
    description: "console.log (IDEA-style sout)",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "clg",
    body: "console.log(${});",
    description: "console.log",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "clo",
    body: "console.log('${expr}', ${expr});",
    description: "console.log labeled value",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "clw",
    body: "console.warn(${});",
    description: "console.warn",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "cle",
    body: "console.error(${});",
    description: "console.error",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "fori",
    body: "for (let ${i} = 0; ${i} < ${}; ${i}++) {\n\t${}\n}",
    description: "for loop with index",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "forof",
    body: "for (const ${item} of ${iterable}) {\n\t${}\n}",
    description: "for...of loop",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "forin",
    body: "for (const ${key} in ${object}) {\n\t${}\n}",
    description: "for...in loop",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "foreach",
    body: "${array}.forEach((${item}) => {\n\t${}\n});",
    description: "Array.forEach",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "af",
    body: "(${}) => ${}",
    description: "arrow function",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "afb",
    body: "(${}) => {\n\t${}\n}",
    description: "arrow function block",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "anfn",
    body: "async (${}) => {\n\t${}\n}",
    description: "async arrow function",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "fn",
    body: "function ${name}(${}) {\n\t${}\n}",
    description: "function",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "afn",
    body: "async function ${name}(${}) {\n\t${}\n}",
    description: "async function",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "iife",
    body: "(${async} () => {\n\t${}\n})();",
    description: "immediately-invoked function expression",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "imp",
    body: "import { ${} } from '${}';",
    description: "named import",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "imd",
    body: "import ${name} from '${}';",
    description: "default import",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "exp",
    body: "export { ${} };",
    description: "named export",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "edf",
    body: "export default ${};",
    description: "default export",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "prom",
    body: "new Promise((resolve, reject) => {\n\t${}\n})",
    description: "Promise",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "st",
    body: "setTimeout(() => {\n\t${}\n}, ${delay});",
    description: "setTimeout",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "si",
    body: "setInterval(() => {\n\t${}\n}, ${delay});",
    description: "setInterval",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "us",
    body: "const [${state}, set${State}] = useState(${});",
    description: "React useState",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "uef",
    body: "useEffect(() => {\n\t${}\n}, [${}]);",
    description: "React useEffect",
    languages: ["javascript", "typescript"],
  },
  {
    abbreviation: "sout",
    body: "console.log($EXPR$);",
    description: "console.log expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
  {
    abbreviation: "log",
    body: "console.log($EXPR$);",
    description: "console.log expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$;",
    description: "return expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
  {
    abbreviation: "if",
    body: "if ($EXPR$) {\n\t${}\n}",
    description: "if expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
  {
    abbreviation: "forof",
    body: "for (const ${item} of $EXPR$) {\n\t${}\n}",
    description: "for...of expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
  {
    abbreviation: "await",
    body: "await $EXPR$",
    description: "await expression",
    languages: ["javascript", "typescript"],
    postfix: true,
  },
];

const PYTHON_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "main",
    body: "if __name__ == \"__main__\":\n\t${}",
    description: "main guard",
    languages: ["python"],
  },
  {
    abbreviation: "sout",
    body: "print(${})",
    description: "print (IDEA-style sout)",
    languages: ["python"],
  },
  {
    abbreviation: "pr",
    body: "print(${})",
    description: "print",
    languages: ["python"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} in range(${}):\n\t${}",
    description: "for range loop",
    languages: ["python"],
  },
  {
    abbreviation: "for",
    body: "for ${item} in ${iterable}:\n\t${}",
    description: "for loop",
    languages: ["python"],
  },
  {
    abbreviation: "if",
    body: "if ${}:\n\t${}",
    description: "if statement",
    languages: ["python"],
  },
  {
    abbreviation: "ife",
    body: "if ${}:\n\t${}\nelse:\n\t${}",
    description: "if/else",
    languages: ["python"],
  },
  {
    abbreviation: "def",
    body: "def ${name}(${}):\n\t${}",
    description: "function",
    languages: ["python"],
  },
  {
    abbreviation: "defs",
    body: "def ${name}(self${}):\n\t${}",
    description: "method",
    languages: ["python"],
  },
  {
    abbreviation: "class",
    body: "class ${Name}:\n\tdef __init__(self${}):\n\t\t${}",
    description: "class with __init__",
    languages: ["python"],
  },
  {
    abbreviation: "try",
    body: "try:\n\t${}\nexcept ${Exception} as ${e}:\n\t${}",
    description: "try/except",
    languages: ["python"],
  },
  {
    abbreviation: "with",
    body: "with ${expr} as ${name}:\n\t${}",
    description: "with statement",
    languages: ["python"],
  },
  {
    abbreviation: "sout",
    body: "print($EXPR$)",
    description: "print expression",
    languages: ["python"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["python"],
    postfix: true,
  },
];

const RUST_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "println!(\"${}\");",
    description: "println! (IDEA-style sout)",
    languages: ["rust"],
  },
  {
    abbreviation: "p",
    body: "println!(\"${}\");",
    description: "println!",
    languages: ["rust"],
  },
  {
    abbreviation: "pd",
    body: "println!(\"{:?}\", ${});",
    description: "println! debug",
    languages: ["rust"],
  },
  {
    abbreviation: "main",
    body: "fn main() {\n\t${}\n}",
    description: "main function",
    languages: ["rust"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} in 0..${} {\n\t${}\n}",
    description: "for range loop",
    languages: ["rust"],
  },
  {
    abbreviation: "for",
    body: "for ${item} in ${iterable} {\n\t${}\n}",
    description: "for loop",
    languages: ["rust"],
  },
  {
    abbreviation: "match",
    body: "match ${expr} {\n\t${} => ${},\n\t_ => ${},\n}",
    description: "match expression",
    languages: ["rust"],
  },
  {
    abbreviation: "ifl",
    body: "if let ${Some}(${val}) = ${expr} {\n\t${}\n}",
    description: "if let",
    languages: ["rust"],
  },
  {
    abbreviation: "wl",
    body: "while let ${Some}(${val}) = ${expr} {\n\t${}\n}",
    description: "while let",
    languages: ["rust"],
  },
  {
    abbreviation: "fn",
    body: "fn ${name}(${}) ${-> Type }{\n\t${}\n}",
    description: "function",
    languages: ["rust"],
  },
  {
    abbreviation: "sout",
    body: "println!(\"{:?}\", $EXPR$);",
    description: "println! expression",
    languages: ["rust"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$;",
    description: "return expression",
    languages: ["rust"],
    postfix: true,
  },
];

const GO_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "fmt.Println(${})",
    description: "fmt.Println (IDEA-style sout)",
    languages: ["go"],
  },
  {
    abbreviation: "main",
    body: "func main() {\n\t${}\n}",
    description: "main function",
    languages: ["go"],
  },
  {
    abbreviation: "psvm",
    body: "func main() {\n\t${}\n}",
    description: "main function",
    languages: ["go"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} := 0; ${i} < ${}; ${i}++ {\n\t${}\n}",
    description: "for loop with index",
    languages: ["go"],
  },
  {
    abbreviation: "for",
    body: "for ${key}, ${value} := range ${collection} {\n\t${}\n}",
    description: "for range",
    languages: ["go"],
  },
  {
    abbreviation: "err",
    body: "if err != nil {\n\t${return err}\n}",
    description: "if err != nil",
    languages: ["go"],
  },
  {
    abbreviation: "ierr",
    body: "if ${err} != nil {\n\t${}\n}",
    description: "if error check",
    languages: ["go"],
  },
  {
    abbreviation: "fn",
    body: "func ${name}(${}) ${} {\n\t${}\n}",
    description: "function",
    languages: ["go"],
  },
  {
    abbreviation: "sout",
    body: "fmt.Println($EXPR$)",
    description: "fmt.Println expression",
    languages: ["go"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["go"],
    postfix: true,
  },
];

const CSHARP_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "Console.WriteLine(${});",
    description: "Console.WriteLine",
    languages: ["csharp"],
  },
  {
    abbreviation: "psvm",
    body: "public static void Main(string[] args)\n{\n\t${}\n}",
    description: "Main method",
    languages: ["csharp"],
  },
  {
    abbreviation: "main",
    body: "public static void Main(string[] args)\n{\n\t${}\n}",
    description: "Main method",
    languages: ["csharp"],
  },
  {
    abbreviation: "fori",
    body: "for (int ${i} = 0; ${i} < ${}; ${i}++)\n{\n\t${}\n}",
    description: "for loop",
    languages: ["csharp"],
  },
  {
    abbreviation: "foreach",
    body: "foreach (var ${item} in ${collection})\n{\n\t${}\n}",
    description: "foreach loop",
    languages: ["csharp"],
  },
  {
    abbreviation: "prop",
    body: "public ${Type} ${Name} { get; set; }",
    description: "auto-property",
    languages: ["csharp"],
  },
  {
    abbreviation: "sout",
    body: "Console.WriteLine($EXPR$);",
    description: "WriteLine expression",
    languages: ["csharp"],
    postfix: true,
  },
];

const PHP_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "echo ${};",
    description: "echo",
    languages: ["php"],
  },
  {
    abbreviation: "fori",
    body: "for ($${i} = 0; $${i} < ${}; $${i}++) {\n\t${}\n}",
    description: "for loop",
    languages: ["php"],
  },
  {
    abbreviation: "foreach",
    body: "foreach ($${array} as $${item}) {\n\t${}\n}",
    description: "foreach",
    languages: ["php"],
  },
  {
    abbreviation: "pubf",
    body: "public function ${name}(${}): ${void}\n{\n\t${}\n}",
    description: "public method",
    languages: ["php"],
  },
];

/** All built-in templates. Language filtering is done at match time. */
export const LIVE_TEMPLATES: readonly LiveTemplate[] = [
  ...JAVA_TEMPLATES,
  ...KOTLIN_TEMPLATES,
  ...JS_TS_TEMPLATES,
  ...PYTHON_TEMPLATES,
  ...RUST_TEMPLATES,
  ...GO_TEMPLATES,
  ...CSHARP_TEMPLATES,
  ...PHP_TEMPLATES,
];

/**
 * Stable key for a built-in template (used by Settings to enable/disable).
 * Custom templates use their own `id` field instead.
 */
export function builtinTemplateKey(template: LiveTemplate): string {
  const langs = [...template.languages].sort().join(",");
  return `${langs}|${template.postfix ? "p" : "l"}|${template.abbreviation}`;
}

export function customTemplateToLiveTemplate(custom: CustomLiveTemplate): LiveTemplate {
  return {
    abbreviation: custom.abbreviation,
    body: custom.body,
    description: custom.description || "Custom template",
    languages: custom.languages,
    postfix: custom.postfix || undefined,
  };
}

// Preferences cache so completion stays sync and settings apply immediately.
let preferencesCache: LiveTemplatePreferences = loadLiveTemplatePreferences();

export function getLiveTemplatePreferencesCache(): LiveTemplatePreferences {
  return preferencesCache;
}

/** Test / settings helper: re-read storage into the in-memory cache. */
export function refreshLiveTemplatePreferencesCache(
  preferences?: LiveTemplatePreferences,
): LiveTemplatePreferences {
  preferencesCache = preferences ?? loadLiveTemplatePreferences();
  return preferencesCache;
}

if (typeof window !== "undefined") {
  subscribeLiveTemplatePreferences((next) => {
    preferencesCache = next;
  });
}

// ── Matching ─────────────────────────────────────────────────────────────

export interface LiveTemplateMatch {
  from: number;
  to: number;
  template: LiveTemplate;
  /** Present for postfix matches — raw left-hand expression. */
  expr?: string;
  /** Typed abbreviation prefix used for ranking. */
  typed: string;
  exact: boolean;
}

function languageMatches(template: LiveTemplate, language: LiveTemplateLanguage): boolean {
  return template.languages.includes(language)
    || template.languages.includes("generic");
}

/**
 * Built-ins + enabled custom templates for a language, respecting Settings.
 */
export function templatesFor(
  language: LiveTemplateLanguage,
  postfix: boolean,
  preferences: LiveTemplatePreferences = preferencesCache,
): LiveTemplate[] {
  if (!preferences.enabled) return [];
  if (postfix && !preferences.postfixEnabled) return [];

  const disabled = new Set(preferences.disabledBuiltinKeys);
  const builtins = LIVE_TEMPLATES.filter((template) => (
    languageMatches(template, language)
    && !!template.postfix === postfix
    && !disabled.has(builtinTemplateKey(template))
  ));

  const customs = preferences.customTemplates
    .filter((custom) => custom.enabled && !!custom.postfix === postfix)
    .map(customTemplateToLiveTemplate)
    .filter((template) => languageMatches(template, language));

  return [...builtins, ...customs];
}

/** All built-ins for Settings UI, annotated with enable state. */
export function listBuiltinTemplatesForSettings(
  preferences: LiveTemplatePreferences = preferencesCache,
): Array<LiveTemplate & { key: string; enabled: boolean }> {
  return LIVE_TEMPLATES.map((template) => {
    const key = builtinTemplateKey(template);
    return {
      ...template,
      key,
      enabled: !preferences.disabledBuiltinKeys.includes(key),
    };
  });
}

/**
 * Match a simple live-template abbreviation at `pos` (identifier before caret).
 * Prefers the longest exact abbreviation; otherwise the longest prefix match.
 */
export function matchLiveTemplateAbbreviation(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): LiveTemplateMatch | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const word = before.match(/[A-Za-z_$@][\w$]*$/);
  if (!word) return null;
  const typed = word[0];
  // Do not steal member access completions (`obj.s…`).
  const charBeforeWord = before.slice(0, -typed.length).slice(-1);
  if (charBeforeWord === ".") return null;

  const from = pos - typed.length;
  const candidates = templatesFor(language, false)
    .filter((template) => template.abbreviation.startsWith(typed) || typed.startsWith(template.abbreviation))
    // Only suggest when the user is typing the abbreviation, not after they
    // already overshot a short one without expanding (e.g. typed "soutx").
    .filter((template) => typed.length <= template.abbreviation.length
      && template.abbreviation.startsWith(typed));

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aExact = a.abbreviation === typed ? 1 : 0;
    const bExact = b.abbreviation === typed ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    // Prefer longer abbreviations so `soutv` wins over `sout` when typing "soutv".
    if (a.abbreviation.length !== b.abbreviation.length) {
      return b.abbreviation.length - a.abbreviation.length;
    }
    return a.abbreviation.localeCompare(b.abbreviation);
  });

  // When multiple abbreviations share a prefix (sout / soutv / soutm), return
  // null from the single-expand helper path unless exact — list shows all.
  const best = candidates[0];
  return {
    from,
    to: pos,
    template: best,
    typed,
    exact: best.abbreviation === typed,
  };
}

/**
 * Match IDEA postfix form `expr.abbr` where `abbr` is a known postfix template.
 * Expression is a simple identifier or member chain (no spaces/operators).
 */
export function matchPostfixTemplate(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): LiveTemplateMatch | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const match = before.match(/([A-Za-z_$@][\w$]*(?:\.[A-Za-z_$@][\w$]*)*)\.([A-Za-z_][\w]*)$/);
  if (!match || match.index == null) return null;
  const expr = match[1];
  const typed = match[2];
  const candidates = templatesFor(language, true)
    .filter((template) => template.abbreviation.startsWith(typed));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aExact = a.abbreviation === typed ? 1 : 0;
    const bExact = b.abbreviation === typed ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.abbreviation.length - a.abbreviation.length;
  });
  const best = candidates[0];
  return {
    from: line.from + match.index,
    to: pos,
    template: best,
    expr,
    typed,
    exact: best.abbreviation === typed,
  };
}

export function listLiveTemplateCompletions(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): { from: number; to: number; matches: LiveTemplateMatch[] } | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);

  // Postfix first when the caret sits after `.abbr`.
  const postfixMatch = before.match(/([A-Za-z_$@][\w$]*(?:\.[A-Za-z_$@][\w$]*)*)\.([A-Za-z_][\w]*)$/);
  if (postfixMatch && postfixMatch.index != null) {
    const expr = postfixMatch[1];
    const typed = postfixMatch[2];
    const matches = templatesFor(language, true)
      .filter((template) => template.abbreviation.startsWith(typed))
      .map((template): LiveTemplateMatch => ({
        from: line.from + postfixMatch.index!,
        to: pos,
        template,
        expr,
        typed,
        exact: template.abbreviation === typed,
      }));
    if (matches.length) {
      return { from: line.from + postfixMatch.index, to: pos, matches };
    }
  }

  const word = before.match(/[A-Za-z_$@][\w$]*$/);
  if (!word) return null;
  const typed = word[0];
  const charBeforeWord = before.slice(0, -typed.length).slice(-1);
  if (charBeforeWord === ".") return null;
  const from = pos - typed.length;
  const matches = templatesFor(language, false)
    .filter((template) => template.abbreviation.startsWith(typed))
    .map((template): LiveTemplateMatch => ({
      from,
      to: pos,
      template,
      typed,
      exact: template.abbreviation === typed,
    }));
  if (!matches.length) return null;
  return { from, to: pos, matches };
}

/** Replace `$EXPR$` / `$EXPRTYPE$` placeholders for postfix expansion. */
export function materializeTemplateBody(template: LiveTemplate, expr?: string): string {
  let body = template.body;
  if (expr != null) {
    // Escape `$` in expression so CM snippet parser does not treat them as fields.
    const safeExpr = expr.replace(/\$/g, "\\$");
    body = body.replaceAll("$EXPR$", safeExpr);
    // Placeholder type for cast — leave as a tabstop when unknown.
    body = body.replaceAll("$EXPRTYPE$", "${Type}");
  }
  return body;
}

export function applyLiveTemplate(
  view: EditorView,
  match: LiveTemplateMatch,
): void {
  const body = materializeTemplateBody(match.template, match.expr);
  const completion: Completion = {
    label: match.template.abbreviation,
    type: "keyword",
  };
  snippet(body)(view, completion, match.from, match.to);
}

/**
 * Expand an exact live/postfix template under the caret.
 * Used by Tab when no completion popup is active (IDEA muscle memory).
 */
export function expandLiveTemplateAt(
  view: EditorView,
  language: LiveTemplateLanguage,
): boolean {
  const pos = view.state.selection.main.head;
  if (!view.state.selection.main.empty) return false;

  const postfix = matchPostfixTemplate(view.state.doc, pos, language);
  if (postfix?.exact) {
    applyLiveTemplate(view, postfix);
    return true;
  }

  const plain = matchLiveTemplateAbbreviation(view.state.doc, pos, language);
  // When several templates share a prefix, only expand on exact abbreviation.
  if (plain?.exact) {
    // Disambiguate: if another longer template also starts with this exact
    // abbr as a prefix of a longer one the user might still be typing — but
    // exact means they typed the full abbr, so expand the exact one.
    applyLiveTemplate(view, plain);
    return true;
  }
  return false;
}

function boostForMatch(match: LiveTemplateMatch): number {
  if (match.template.postfix) {
    return match.exact ? LIVE_TEMPLATE_POSTFIX_BOOST : LIVE_TEMPLATE_POSTFIX_BOOST - 50;
  }
  if (match.exact) return LIVE_TEMPLATE_EXACT_BOOST;
  // Longer remaining suffix ranks slightly lower (sout > so).
  const remaining = match.template.abbreviation.length - match.typed.length;
  return LIVE_TEMPLATE_PREFIX_BOOST - remaining;
}

function matchToCompletion(match: LiveTemplateMatch): Completion {
  const preview = materializeTemplateBody(match.template, match.expr)
    .replace(/\n/g, "↵")
    .replace(/\t/g, "  ");
  const truncated = preview.length > 60 ? `${preview.slice(0, 57)}…` : preview;
  return {
    label: match.template.abbreviation,
    detail: match.template.description,
    // Keep abbreviation as the filter label; show expansion on the right via detail.
    info: () => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-hover";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.style.marginBottom = "4px";
      title.textContent = match.template.postfix
        ? `Postfix · ${match.template.abbreviation}`
        : `Live Template · ${match.template.abbreviation}`;
      const code = document.createElement("pre");
      code.style.margin = "0";
      code.style.fontFamily = "var(--taomni-code-font-family, monospace)";
      code.style.whiteSpace = "pre-wrap";
      code.textContent = materializeTemplateBody(match.template, match.expr ?? "${expr}");
      const desc = document.createElement("div");
      desc.style.marginTop = "6px";
      desc.style.opacity = "0.85";
      desc.textContent = match.template.description;
      dom.append(title, code, desc);
      return dom;
    },
    type: "keyword",
    boost: boostForMatch(match),
    // Encode a secondary sort so exact templates win within the same boost band.
    sortText: match.exact ? `0_${match.template.abbreviation}` : `1_${match.template.abbreviation}`,
    section: match.template.postfix ? "Postfix" : "Live Templates",
    apply: (view, _completion, from, to) => {
      applyLiveTemplate(view, { ...match, from, to });
    },
    // Expose preview for tests / optionClass consumers.
    displayLabel: match.template.postfix && match.expr
      ? `${match.expr}.${match.template.abbreviation} → ${truncated}`
      : undefined,
  };
}

/**
 * Completion source that offers IDEA-style live/postfix templates for the
 * language inferred from `path`. Synchronous and local — no LSP required.
 */
export function createLiveTemplateCompletionSource(
  pathOf: () => string | null | undefined,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    // Never trigger live templates inside string literals or comments.
    if (isInsideStringOrComment(context.state, context.pos)) {
      return null;
    }

    const language = liveTemplateLanguageForPath(pathOf());
    // Require at least one character unless explicit (Ctrl+Space).
    const listed = listLiveTemplateCompletions(context.state.doc, context.pos, language);
    if (!listed) {
      if (!context.explicit) return null;
      // Explicit invoke with no prefix: show a short starter set for the language.
      const starters = templatesFor(language, false)
        .slice(0, 30)
        .map((template): LiveTemplateMatch => ({
          from: context.pos,
          to: context.pos,
          template,
          typed: "",
          exact: false,
        }));
      if (!starters.length) return null;
      return {
        from: context.pos,
        options: starters.map(matchToCompletion),
        validFor: /^[\w$]*$/,
      };
    }

    // For non-explicit automatic typing:
    // Only offer templates if:
    // 1) Postfix template (e.g. list.for), OR
    // 2) Exact match (e.g. sout, psvm, if, fori), OR
    // 3) Typed prefix is at least 2 characters long (e.g. "so" -> sout).
    // Single-character prefix (like typing "s" or "i" or "t") MUST NOT hijack autocomplete popup!
    if (!context.explicit) {
      const isPostfix = listed.matches[0]?.template.postfix ?? false;
      const hasExact = listed.matches.some((m) => m.exact);
      const longestTyped = Math.max(...listed.matches.map((m) => m.typed.length));
      if (!isPostfix && !hasExact && longestTyped < 2) {
        return null;
      }
    }

    return {
      from: listed.from,
      // For postfix, `from` spans the whole `expr.abbr`; CM filters against label
      // which is only the abbreviation, so disable client filter and re-query.
      options: listed.matches
        .sort((a, b) => boostForMatch(b) - boostForMatch(a))
        .map(matchToCompletion),
      filter: !listed.matches[0]?.template.postfix,
      validFor: listed.matches[0]?.template.postfix ? undefined : /^[\w$]*$/,
    };
  };
}
