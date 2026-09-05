/**
 * ED-TEMPLATE-001: File and Code Templates minimal Java slice.
 * Provides template evaluation, package deduction from source roots,
 * Java identifier validation, and safe resource creation plans.
 */

export type JavaTemplateKind = "class" | "interface" | "record" | "enum" | "annotation";

export interface JavaTemplateDefinition {
  kind: JavaTemplateKind;
  title: string;
  templateText: string;
}

export const DEFAULT_JAVA_TEMPLATES: Record<JavaTemplateKind, string> = {
  class: `package \${PACKAGE_NAME};

public class \${NAME} {
}
`,
  interface: `package \${PACKAGE_NAME};

public interface \${NAME} {
}
`,
  record: `package \${PACKAGE_NAME};

public record \${NAME}() {
}
`,
  enum: `package \${PACKAGE_NAME};

public enum \${NAME} {
}
`,
  annotation: `package \${PACKAGE_NAME};

public @interface \${NAME} {
}
`,
};

const JAVA_RESERVED_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "final", "finally", "float", "for", "goto", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "native", "new", "package",
  "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient",
  "try", "void", "volatile", "while", "record", "sealed", "non-sealed", "permits",
  "yield", "var",
]);

/**
 * Validates whether a given string is a valid Java type identifier.
 */
export function validateJavaIdentifier(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: "Name cannot be empty" };
  }

  if (JAVA_RESERVED_KEYWORDS.has(trimmed)) {
    return { valid: false, error: `'${trimmed}' is a reserved Java keyword` };
  }

  const idPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!idPattern.test(trimmed)) {
    return { valid: false, error: `'${trimmed}' is not a valid Java identifier` };
  }

  return { valid: true };
}

/**
 * Derives the Java package name given the target directory and known source roots.
 */
export function derivePackageName(
  targetDirectory: string,
  sourceRoots: readonly string[],
): string {
  const normTarget = normalizePath(targetDirectory);
  for (const root of sourceRoots) {
    const normRoot = normalizePath(root);
    if (normTarget === normRoot) {
      return "";
    }
    if (normTarget.startsWith(normRoot + "/")) {
      const rel = normTarget.slice(normRoot.length + 1);
      return rel.split("/").filter(Boolean).join(".");
    }
  }
  return "";
}

export const ALLOWED_TEMPLATE_VARIABLES = [
  "NAME",
  "PACKAGE_NAME",
  "DATE",
  "TIME",
  "YEAR",
  "USER",
  "PROJECT_NAME",
] as const;

export type AllowedTemplateVariable = (typeof ALLOWED_TEMPLATE_VARIABLES)[number];
const ALLOWED_VARIABLE_SET = new Set<string>(ALLOWED_TEMPLATE_VARIABLES);

/**
 * Validates template variables against the allowed list and safe character rules.
 */
export function validateTemplateVariables(
  customVariables?: Record<string, string>,
): { valid: boolean; error?: string } {
  if (!customVariables) return { valid: true };
  for (const [key, value] of Object.entries(customVariables)) {
    if (!ALLOWED_VARIABLE_SET.has(key)) {
      return {
        valid: false,
        error: `Untrusted template variable '\${${key}}' is not allowed`,
      };
    }
    if (/[\0\x08\x1b]/.test(value)) {
      return {
        valid: false,
        error: `Template variable '\${${key}}' contains unsafe control characters`,
      };
    }
  }
  return { valid: true };
}

export interface EvaluateTemplateVariables {
  name: string;
  packageName: string;
  date?: string;
  time?: string;
  year?: string;
  user?: string;
  projectName?: string;
  customVariables?: Record<string, string>;
}

/**
 * Evaluates template text by substituting safe variables.
 */
export function renderJavaTemplate(
  templateText: string,
  vars: EvaluateTemplateVariables,
): string {
  const varCheck = validateTemplateVariables(vars.customVariables);
  if (!varCheck.valid) {
    throw new Error(varCheck.error);
  }

  const now = new Date();
  const safeVars: Record<string, string> = {
    NAME: vars.name,
    PACKAGE_NAME: vars.packageName,
    DATE: vars.date ?? now.toISOString().split("T")[0],
    TIME: vars.time ?? now.toTimeString().split(" ")[0] ?? "00:00:00",
    YEAR: vars.year ?? String(now.getFullYear()),
    USER: vars.user ?? "developer",
    PROJECT_NAME: vars.projectName ?? "Taomni",
    ...(vars.customVariables ?? {}),
  };

  let rendered = templateText;

  // Handle conditional package header: if package is empty, remove the package line cleanly
  if (!vars.packageName) {
    rendered = rendered.replace(/^package\s+\$\{PACKAGE_NAME\};?\r?\n\r?\n?/m, "");
  }

  for (const [key, val] of Object.entries(safeVars)) {
    const sanitizedVal = sanitizeTemplateValue(val);
    const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
    rendered = rendered.replace(pattern, sanitizedVal);
  }

  return rendered;
}

export interface PlanTemplateCreationParams {
  kind: JavaTemplateKind;
  name: string;
  targetDirectory: string;
  sourceRoots: readonly string[];
  existingFiles: readonly string[];
  customTemplate?: string;
  customVariables?: Record<string, string>;
  projectFactsStatus?: string;
  requireReadyFacts?: boolean;
}

export type PlanTemplateCreationResult =
  | {
      valid: true;
      kind: JavaTemplateKind;
      targetPath: string;
      className: string;
      packageName: string;
      content: string;
    }
  | {
      valid: false;
      error: string;
      conflictPath?: string;
    };

/**
 * Computes a complete Java file creation plan with conflict check, variable allowlisting,
 * and project-facts status validation.
 */
export function planJavaTemplateCreation(
  params: PlanTemplateCreationParams,
): PlanTemplateCreationResult {
  const idCheck = validateJavaIdentifier(params.name);
  if (!idCheck.valid) {
    return { valid: false, error: idCheck.error || "Invalid class name" };
  }

  // Contract: only ready source-root/package facts
  if (params.requireReadyFacts && params.projectFactsStatus && params.projectFactsStatus !== "ready") {
    return {
      valid: false,
      error: `Cannot plan file creation: project facts status is '${params.projectFactsStatus}' (ready status required)`,
    };
  }

  // Untrusted variable check
  if (params.customVariables) {
    const varCheck = validateTemplateVariables(params.customVariables);
    if (!varCheck.valid) {
      return { valid: false, error: varCheck.error ?? "Untrusted template variable" };
    }
  }

  const className = params.name.trim();
  const targetDir = normalizePath(params.targetDirectory);
  const targetPath = `${targetDir}/${className}.java`;

  // Conflict check
  const normalizedExisting = new Set(params.existingFiles.map(normalizePath));
  if (normalizedExisting.has(targetPath)) {
    return {
      valid: false,
      error: `File already exists at ${targetPath}`,
      conflictPath: targetPath,
    };
  }

  // Only derive package from source roots if facts are ready (or not explicitly unready)
  const isFactsReady = !params.projectFactsStatus || params.projectFactsStatus === "ready";
  const effectiveSourceRoots = isFactsReady ? params.sourceRoots : [];
  const packageName = derivePackageName(targetDir, effectiveSourceRoots);

  const template = params.customTemplate ?? DEFAULT_JAVA_TEMPLATES[params.kind];
  let content: string;
  try {
    content = renderJavaTemplate(template, {
      name: className,
      packageName,
      customVariables: params.customVariables,
    });
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to render template",
    };
  }

  return {
    valid: true,
    kind: params.kind,
    targetPath,
    className,
    packageName,
    content,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sanitizeTemplateValue(val: string): string {
  // Prevent escape injection
  return val.replace(/[\0\x08]/g, "");
}
