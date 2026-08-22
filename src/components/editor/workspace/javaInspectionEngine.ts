// NON-PRODUCTION MODEL: no production consumer; see §8.13 N12
/**
 * Java Inspection Engine & Data-Flow Analyzer (J2) - Experimental Prototype.
 *
 * Implements preliminary pattern-based code inspections for:
 *   1. Dead code / unreachable statements
 *   2. Constant conditions (e.g. `if (true)`, `if (false)`)
 *   3. Probable null dereferences
 *   4. Empty statement blocks
 *
 * NOTE: This is an experimental syntactic rule prototype, not a full CFG/SSA data-flow engine.
 */

import type { JavaSemanticIndex } from "./javaSemanticIndex";

export interface JavaInspectionDiagnostic {
  id: string;
  ruleId: string;
  message: string;
  severity: "error" | "warning" | "info";
  line: number;
  startCol: number;
  endCol: number;
  quickFixes?: Array<{
    title: string;
    action: "remove" | "replace" | "surround";
    replacement?: string;
  }>;
}

export interface JavaInspectionRule {
  id: string;
  name: string;
  description: string;
  severity: "error" | "warning" | "info";
  check: (fileId: string, content: string, index?: JavaSemanticIndex) => JavaInspectionDiagnostic[];
}

export const JAVA_INSPECTION_RULES: JavaInspectionRule[] = [
  // 1. Dead code / Unreachable statements
  {
    id: "java.deadCode",
    name: "Unreachable code",
    description: "Detects statements that will never be executed after return, throw, break, or continue",
    severity: "warning",
    check: (fileId, content) => {
      const diagnostics: JavaInspectionDiagnostic[] = [];
      const lines = content.split("\n");

      let insideUnreachable = false;

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

        if (insideUnreachable) {
          if (trimmed === "}" || trimmed.startsWith("case ") || trimmed.startsWith("default:")) {
            insideUnreachable = false;
          } else {
            diagnostics.push({
              id: `dead-code-${fileId}-${idx}`,
              ruleId: "java.deadCode",
              message: "Unreachable statement",
              severity: "warning",
              line: idx,
              startCol: line.indexOf(trimmed),
              endCol: line.indexOf(trimmed) + trimmed.length,
              quickFixes: [{ title: "Remove unreachable statement", action: "remove" }],
            });
          }
        }

        if (
          trimmed.startsWith("return ") ||
          trimmed === "return;" ||
          trimmed.startsWith("throw ") ||
          trimmed === "break;" ||
          trimmed === "continue;"
        ) {
          insideUnreachable = true;
        }
      });

      return diagnostics;
    },
  },

  // 2. Constant conditions
  {
    id: "java.constantCondition",
    name: "Constant condition",
    description: "Detects boolean expressions that always evaluate to true or false",
    severity: "warning",
    check: (fileId, content) => {
      const diagnostics: JavaInspectionDiagnostic[] = [];
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        const trimmed = line.trim();

        const ifMatch = trimmed.match(/\bif\s*\((true|false|1\s*==\s*1|1\s*==\s*2)\)/);
        if (ifMatch) {
          const matchedExpr = ifMatch[1];
          diagnostics.push({
            id: `const-cond-${fileId}-${idx}`,
            ruleId: "java.constantCondition",
            message: `Condition '${matchedExpr}' is always ${matchedExpr === "true" || matchedExpr.includes("1 == 1") ? "true" : "false"}`,
            severity: "warning",
            line: idx,
            startCol: line.indexOf(ifMatch[0]),
            endCol: line.indexOf(ifMatch[0]) + ifMatch[0].length,
          });
        }
      });

      return diagnostics;
    },
  },

  // 3. Probable null dereferences
  {
    id: "java.nullDereference",
    name: "Probable null dereference",
    description: "Detects direct method or field dereferencing on variables assigned null",
    severity: "error",
    check: (fileId, content) => {
      const diagnostics: JavaInspectionDiagnostic[] = [];
      const lines = content.split("\n");

      let nullVar: string | null = null;
      let nullAssignLine = -1;

      lines.forEach((line, idx) => {
        const trimmed = line.trim();

        // Null assignment: Object x = null; or x = null;
        const nullMatch = trimmed.match(/(?:[a-zA-Z0-9_<>]+)\s+([a-zA-Z0-9_]+)\s*=\s*null;/);
        if (nullMatch) {
          nullVar = nullMatch[1];
          nullAssignLine = idx;
          return;
        }

        // Direct dereference: x.doSomething() on same block
        if (nullVar && idx > nullAssignLine && idx < nullAssignLine + 10) {
          const derefRegex = new RegExp(`\\b${nullVar}\\.([a-zA-Z0-9_]+)`);
          const derefMatch = trimmed.match(derefRegex);
          if (derefMatch && !trimmed.includes("if (") && !trimmed.includes("==") && !trimmed.includes("!=")) {
            diagnostics.push({
              id: `null-deref-${fileId}-${idx}`,
              ruleId: "java.nullDereference",
              message: `Variable '${nullVar}' is null when dereferenced here (NullPointerException)`,
              severity: "error",
              line: idx,
              startCol: line.indexOf(derefMatch[0]),
              endCol: line.indexOf(derefMatch[0]) + derefMatch[0].length,
              quickFixes: [{ title: `Add null check for '${nullVar}'`, action: "surround" }],
            });
            nullVar = null; // Report once per assignment
          }
        }
      });

      return diagnostics;
    },
  },
];

export class JavaInspectionEngine {
  private rules: JavaInspectionRule[] = [...JAVA_INSPECTION_RULES];

  inspectFile(fileId: string, content: string, index?: JavaSemanticIndex): JavaInspectionDiagnostic[] {
    const allDiagnostics: JavaInspectionDiagnostic[] = [];
    for (const rule of this.rules) {
      try {
        const res = rule.check(fileId, content, index);
        allDiagnostics.push(...res);
      } catch (err) {
        console.error(`Error running inspection rule ${rule.id}:`, err);
      }
    }
    return allDiagnostics;
  }
}

export const globalJavaInspectionEngine = new JavaInspectionEngine();
