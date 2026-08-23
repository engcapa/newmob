// NON-PRODUCTION FIXTURE (experimental): moved out of production per §8.17.9 N12 — no production import permitted; see ./README.md in this directory
/**
 * Surround With & Generate Code Template Model (E1.3).
 *
 * Implements IntelliJ IDEA's Surround With (Ctrl+Alt+T) and Generate Code (Alt+Insert)
 * for Java and TypeScript with template variables, indentation, and preview.
 */

export interface SurroundTemplate {
  id: string;
  name: string;
  category: "Control" | "Exception" | "Concurrency" | "Custom";
  languages: string[];
  prefix: (indent: string) => string;
  suffix: (indent: string) => string;
  cursorOffsetFromPrefix?: number;
}

export const SURROUND_TEMPLATES: SurroundTemplate[] = [
  {
    id: "surround.if",
    name: "if (expr) { ... }",
    category: "Control",
    languages: ["java", "typescript", "javascript", "c", "cpp", "csharp", "go", "rust"],
    prefix: (indent) => `${indent}if (condition) {\n`,
    suffix: (indent) => `\n${indent}}`,
  },
  {
    id: "surround.ifElse",
    name: "if (expr) { ... } else { ... }",
    category: "Control",
    languages: ["java", "typescript", "javascript", "c", "cpp", "csharp", "go", "rust"],
    prefix: (indent) => `${indent}if (condition) {\n`,
    suffix: (indent) => `\n${indent}} else {\n${indent}  \n${indent}}`,
  },
  {
    id: "surround.tryCatch",
    name: "try { ... } catch (Exception e)",
    category: "Exception",
    languages: ["java", "csharp"],
    prefix: (indent) => `${indent}try {\n`,
    suffix: (indent) => `\n${indent}} catch (Exception e) {\n${indent}  e.printStackTrace();\n${indent}}`,
  },
  {
    id: "surround.tryFinally",
    name: "try { ... } finally { ... }",
    category: "Exception",
    languages: ["java", "typescript", "javascript", "csharp", "python"],
    prefix: (indent) => `${indent}try {\n`,
    suffix: (indent) => `\n${indent}} finally {\n${indent}  \n${indent}}`,
  },
  {
    id: "surround.while",
    name: "while (expr) { ... }",
    category: "Control",
    languages: ["java", "typescript", "javascript", "c", "cpp", "csharp", "go", "rust"],
    prefix: (indent) => `${indent}while (condition) {\n`,
    suffix: (indent) => `\n${indent}}`,
  },
  {
    id: "surround.for",
    name: "for (int i = 0; ...) { ... }",
    category: "Control",
    languages: ["java", "c", "cpp", "csharp"],
    prefix: (indent) => `${indent}for (int i = 0; i < max; i++) {\n`,
    suffix: (indent) => `\n${indent}}`,
  },
  {
    id: "surround.synchronized",
    name: "synchronized (lock) { ... }",
    category: "Concurrency",
    languages: ["java"],
    prefix: (indent) => `${indent}synchronized (lock) {\n`,
    suffix: (indent) => `\n${indent}}`,
  },
];

export interface FieldDescriptor {
  name: string;
  type: string;
  isFinal?: boolean;
}

export type GenerateKind =
  | "constructor"
  | "getters"
  | "setters"
  | "gettersAndSetters"
  | "equalsAndHashCode"
  | "toString"
  | "overrideMethod";

/**
 * Indent block text with additional indentation spaces or tabs.
 */
export function indentText(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

/**
 * Apply Surround With template to selected text.
 */
export function applySurround(
  selectedText: string,
  template: SurroundTemplate,
  indentUnit: string = "  ",
): string {
  const baseIndentMatch = selectedText.match(/^\s*/);
  const baseIndent = baseIndentMatch ? baseIndentMatch[0] : "";
  const prefix = template.prefix(baseIndent);
  const indentedInner = indentText(selectedText, indentUnit);
  const suffix = template.suffix(baseIndent);

  return `${prefix}${indentedInner}${suffix}`;
}

/**
 * Generate Java code constructs for a class (Constructor, Getters, Setters, toString, equals/hashCode).
 */
export function generateJavaCode(
  kind: GenerateKind,
  className: string,
  fields: FieldDescriptor[],
  indent: string = "    ",
): string {
  switch (kind) {
    case "constructor": {
      const params = fields.map((f) => `${f.type} ${f.name}`).join(", ");
      const assignments = fields
        .map((f) => `${indent}${indent}this.${f.name} = ${f.name};`)
        .join("\n");
      return `${indent}public ${className}(${params}) {\n${assignments}\n${indent}}`;
    }

    case "getters": {
      return fields
        .map((f) => {
          const capitalized = f.name.charAt(0).toUpperCase() + f.name.slice(1);
          return `${indent}public ${f.type} get${capitalized}() {\n${indent}${indent}return this.${f.name};\n${indent}}`;
        })
        .join("\n\n");
    }

    case "setters": {
      return fields
        .map((f) => {
          const capitalized = f.name.charAt(0).toUpperCase() + f.name.slice(1);
          return `${indent}public void set${capitalized}(${f.type} ${f.name}) {\n${indent}${indent}this.${f.name} = ${f.name};\n${indent}}`;
        })
        .join("\n\n");
    }

    case "gettersAndSetters": {
      const g = generateJavaCode("getters", className, fields, indent);
      const s = generateJavaCode("setters", className, fields, indent);
      return `${g}\n\n${s}`;
    }

    case "toString": {
      const fieldStrs = fields.map((f) => `"${f.name}=" + ${f.name}`).join(' + ", " + ');
      const body = `${indent}${indent}return "${className}{" +\n${indent}${indent}${indent}${fieldStrs} +\n${indent}${indent}${indent}'}';`;
      return `${indent}@Override\n${indent}public String toString() {\n${body}\n${indent}}`;
    }

    case "equalsAndHashCode": {
      const equalsBody = [
        `${indent}${indent}if (this == o) return true;`,
        `${indent}${indent}if (o == null || getClass() != o.getClass()) return false;`,
        `${indent}${indent}${className} that = (${className}) o;`,
        `${indent}${indent}return java.util.Objects.equals(this.${fields.map((f) => f.name).join(", that.")});`,
      ].join("\n");

      const equalsMethod = `${indent}@Override\n${indent}public boolean equals(Object o) {\n${equalsBody}\n${indent}}`;
      const hashParams = fields.map((f) => f.name).join(", ");
      const hashMethod = `${indent}@Override\n${indent}public int hashCode() {\n${indent}${indent}return java.util.Objects.hash(${hashParams});\n${indent}}`;

      return `${equalsMethod}\n\n${hashMethod}`;
    }

    case "overrideMethod":
      return `${indent}@Override\n${indent}public void execute() {\n${indent}${indent}// TODO: implement method\n${indent}}`;
  }
}
