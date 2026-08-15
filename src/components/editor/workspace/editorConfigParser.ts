/**
 * Lightweight .editorconfig parser and section glob matcher.
 * Follows EditorConfig specification for core whitespace and formatting properties.
 */

export interface EditorConfigProperties {
  indent_style?: "tab" | "space";
  indent_size?: number | "tab";
  tab_width?: number;
  end_of_line?: "lf" | "crlf" | "cr";
  charset?: "utf-8" | "utf-8-bom" | "utf-16be" | "utf-16le" | "latin1";
  trim_trailing_whitespace?: boolean;
  insert_final_newline?: boolean;
}

export interface ParsedEditorConfigFile {
  isRoot: boolean;
  sections: Array<{
    pattern: string;
    properties: EditorConfigProperties;
  }>;
}

/**
 * Convert EditorConfig glob pattern to RegExp.
 * Handles *, **, ?, [seq], and {alt1,alt2} syntax.
 */
export function globToRegex(glob: string): RegExp {
  let regexStr = "^";
  let i = 0;
  const n = glob.length;

  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
      } else {
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (c === "{") {
      const closing = glob.indexOf("}", i);
      if (closing !== -1) {
        const alts = glob.slice(i + 1, closing).split(",").map((alt) => alt.trim());
        regexStr += `(${alts.map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = closing + 1;
      } else {
        regexStr += "\\{";
        i += 1;
      }
    } else if (c === "[") {
      const closing = glob.indexOf("]", i);
      if (closing !== -1) {
        const inner = glob.slice(i + 1, closing);
        if (inner.startsWith("!")) {
          regexStr += `[^${inner.slice(1)}]`;
        } else {
          regexStr += `[${inner}]`;
        }
        i = closing + 1;
      } else {
        regexStr += "\\[";
        i += 1;
      }
    } else if (/[.+^$()|\\]/.test(c)) {
      regexStr += `\\${c}`;
      i += 1;
    } else {
      regexStr += c;
      i += 1;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Parse the content of a single .editorconfig file.
 */
export function parseEditorConfigFile(content: string): ParsedEditorConfigFile {
  const lines = content.split(/\r?\n/);
  let isRoot = false;
  const sections: Array<{ pattern: string; properties: EditorConfigProperties }> = [];
  let currentSection: { pattern: string; properties: EditorConfigProperties } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    // Check for [section]
    const sectionMatch = line.match(/^\[(.*)\]$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        pattern: sectionMatch[1].trim(),
        properties: {},
      };
      continue;
    }

    // Key-value pair
    const eqIdx = line.indexOf("=");
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim().toLowerCase();
      const value = line.slice(eqIdx + 1).trim().toLowerCase();

      if (!currentSection && key === "root") {
        isRoot = value === "true";
        continue;
      }

      if (currentSection) {
        switch (key) {
          case "indent_style":
            if (value === "tab" || value === "space") {
              currentSection.properties.indent_style = value;
            }
            break;
          case "indent_size":
            if (value === "tab") {
              currentSection.properties.indent_size = "tab";
            } else {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) currentSection.properties.indent_size = num;
            }
            break;
          case "tab_width": {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) currentSection.properties.tab_width = num;
            break;
          }
          case "end_of_line":
            if (value === "lf" || value === "crlf" || value === "cr") {
              currentSection.properties.end_of_line = value;
            }
            break;
          case "charset":
            if (value === "utf-8" || value === "utf-8-bom" || value === "utf-16be" || value === "utf-16le" || value === "latin1") {
              currentSection.properties.charset = value;
            }
            break;
          case "trim_trailing_whitespace":
            currentSection.properties.trim_trailing_whitespace = value === "true";
            break;
          case "insert_final_newline":
            currentSection.properties.insert_final_newline = value === "true";
            break;
        }
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return { isRoot, sections };
}

/**
 * Match a relative file path against parsed .editorconfig sections and merge matched properties.
 */
export function matchEditorConfig(
  parsed: ParsedEditorConfigFile,
  relativeFilePath: string,
): EditorConfigProperties {
  const normalizedPath = relativeFilePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const merged: EditorConfigProperties = {};

  for (const section of parsed.sections) {
    // A pattern without slash matches only basename or relative path
    const pattern = section.pattern;
    const regex = globToRegex(pattern);

    const matchesFullPath = regex.test(normalizedPath);
    const matchesBasename = !pattern.includes("/") && regex.test(normalizedPath.split("/").pop() ?? "");

    if (matchesFullPath || matchesBasename) {
      Object.assign(merged, section.properties);
    }
  }

  return merged;
}
