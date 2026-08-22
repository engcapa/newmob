// NON-PRODUCTION MODEL: no production consumer; see §8.13 N12
/**
 * Structural Search & Replace Model (A1) - Experimental Template Search Prototype.
 *
 * Implements template-based search and replacement with variable placeholders.
 * NOTE: This is an experimental text/pattern template prototype, not full AST structural search.
 */

export interface StructuralVariable {
  name: string; // e.g. "$expr$", "$method$", "$type$"
  typeConstraint?: string;
  textPattern?: RegExp;
}

export interface StructuralPattern {
  id: string;
  name: string;
  template: string; // e.g. "$obj$.$method$($args$)"
  replacement?: string;
  variables: StructuralVariable[];
  language: string;
}

export interface StructuralMatch {
  startOffset: number;
  endOffset: number;
  matchedText: string;
  capturedVariables: Record<string, string>;
}

/**
 * Match structural pattern against source code text.
 */
export function matchStructuralPattern(
  content: string,
  pattern: StructuralPattern,
): StructuralMatch[] {
  const matches: StructuralMatch[] = [];

  // Match variables enclosed in $...$
  const varNames: string[] = [];
  const parts = pattern.template.split(/(\$[a-zA-Z0-9_]+\$)/g);

  let regexStr = "";
  for (const part of parts) {
    if (part.startsWith("$") && part.endsWith("$")) {
      const varName = part.slice(1, -1);
      varNames.push(varName);
      regexStr += `([^,()]+(?:\\([^)]*\\))?|"[^"]*"|'[^']*')`;
    } else {
      regexStr += part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    }
  }

  const matcher = new RegExp(regexStr, "g");
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(content)) !== null) {
    const captured: Record<string, string> = {};
    for (let i = 0; i < varNames.length; i++) {
      captured[`$${varNames[i]}$`] = match[i + 1]?.trim() ?? "";
    }

    matches.push({
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      matchedText: match[0],
      capturedVariables: captured,
    });
  }

  return matches;
}

/**
 * Replace structural matches using replacement template.
 */
export function replaceStructuralPattern(
  content: string,
  pattern: StructuralPattern,
): string {
  if (!pattern.replacement) return content;

  const matches = matchStructuralPattern(content, pattern);
  if (matches.length === 0) return content;

  let result = "";
  let lastIndex = 0;

  for (const m of matches) {
    result += content.slice(lastIndex, m.startOffset);

    let replaced = pattern.replacement;
    for (const [varName, val] of Object.entries(m.capturedVariables)) {
      replaced = replaced.split(varName).join(val);
    }
    result += replaced;
    lastIndex = m.endOffset;
  }

  result += content.slice(lastIndex);
  return result;
}
