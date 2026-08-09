import { Marked } from "marked";
import DOMPurify, { type Config as DomPurifyConfig } from "dompurify";

const MAIL_ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "del", "div", "em", "font", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "img", "ins", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul",
];

const MAIL_ALLOWED_ATTR = [
  "align", "alt", "axis", "bgcolor", "border", "cellpadding", "cellspacing",
  "class", "color", "colspan", "data-taomni-cid", "dir", "face", "frame",
  "headers", "height", "href", "lang", "name", "nowrap", "rel", "role",
  "rowspan", "rules", "scope", "size", "span", "src", "style", "summary",
  "target", "title", "type", "valign", "width",
];

const MAIL_MARKDOWN = new Marked({
  gfm: true,
  breaks: true,
});

const MAIL_PURIFY_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS: MAIL_ALLOWED_TAGS,
  ALLOWED_ATTR: MAIL_ALLOWED_ATTR,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onmouseenter", "onmouseleave"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "data-taomni-cid"],
  // Thunderbird-style: allow embedded cid:/data: images; remote http(s) stay for optional load.
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cid|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

/**
 * Presentation properties commonly used by HTML email (marketing + clients).
 * Intentionally excludes layout escape hatches (position fixed/absolute, z-index,
 * transform, filter, clip-path) and anything that can load remote resources via url().
 */
const SAFE_STYLE_PROPS = new Set([
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "border-width",
  "color",
  "display",
  "box-sizing",
  "clear",
  "empty-cells",
  "float",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-transform",
  "vertical-align",
  "visibility",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
]);

const LENGTH_TOKEN = /^(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|pc|in|cm|mm)?)$/i;
const LENGTH_OR_NORMAL = /^(?:normal|auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|pc|in|cm|mm)?)$/i;
const BORDER_STYLE = /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
const BORDER_WIDTH = /^(?:thin|medium|thick|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)$/i;

const REMOTE_IMAGE_PLACEHOLDER = "[remote image blocked]";

let hooksInstalled = false;

/**
 * Outlook/Word emit conditional comments and namespaced junk that breaks
 * non-Outlook renderers. Keep non-MSO branches, drop pure MSO/VML scaffolding.
 */
export function preprocessMailHtml(html: string): string {
  let out = html ?? "";
  // XML declaration / BOM-ish noise
  out = out.replace(/^\uFEFF/, "");
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, "");
  // <!--[if !mso]><!--> content <!--<![endif]-->  (and variants without the inner HTML comments)
  out = out.replace(
    /<!--\s*\[if\s*!mso[^\]]*\]\s*>(?:\s*<!--\s*>)?([\s\S]*?)(?:<!--\s*)?<!\s*\[endif\]\s*-->/gi,
    "$1",
  );
  // <!--[if !IE]> content <![endif]-->
  out = out.replace(
    /<!--\s*\[if\s*!IE[^\]]*\]\s*>(?:\s*<!--\s*>)?([\s\S]*?)(?:<!--\s*)?<!\s*\[endif\]\s*-->/gi,
    "$1",
  );
  // <!--[if mso ...]> ... <![endif]-->  (MSO-only tables, VML buttons, etc.)
  out = out.replace(/<!--\s*\[if\s*mso[\s\S]*?<!\s*\[endif\]\s*-->/gi, "");
  // Remaining IE conditionals — drop entirely (content is usually duplicated)
  out = out.replace(/<!--\s*\[if[\s\S]*?<!\s*\[endif\]\s*-->/gi, "");
  // Office namespace tags (empty wrappers)
  out = out.replace(/<\/?(?:o|w|v|x):[^>]*>/gi, "");
  // Common empty Office paragraphs left behind
  out = out.replace(/<p[^>]*>\s*(?:&nbsp;|\u00a0|\s)*<\/p>/gi, (match) => {
    // Keep real empty paragraphs that may be intentional spacing — only strip o:p residue already gone
    return match;
  });
  // Drop <xml>...</xml> Word blobs
  out = out.replace(/<xml\b[^>]*>[\s\S]*?<\/xml>/gi, "");
  // Drop <style type="text/css"><!-- ... --></style> comment wrappers later handled by style extract
  return out;
}

function remoteImagePlaceholderLabel(alt: string | null | undefined, src: string | null | undefined): string {
  const cleanAlt = (alt ?? "").trim().replace(/\s+/g, " ");
  if (cleanAlt && cleanAlt.length <= 80) return `[remote image blocked: ${cleanAlt}]`;
  try {
    if (src && /^https?:/i.test(src)) {
      const host = new URL(src).hostname;
      if (host) return `[remote image blocked · ${host}]`;
    }
  } catch {
    // ignore invalid URL
  }
  return REMOTE_IMAGE_PLACEHOLDER;
}

function installMailPurifyHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLElement) {
      const style = node.getAttribute("style");
      if (style) {
        const sanitized = sanitizeInlineStyle(style);
        if (sanitized) node.setAttribute("style", sanitized);
        else node.removeAttribute("style");
      }
      // Normalize legacy presentational attributes that browsers still honor for mail.
      normalizeLegacyPresentationalAttrs(node);
    }
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function normalizeLegacyPresentationalAttrs(node: HTMLElement): void {
  const bgcolor = node.getAttribute("bgcolor");
  if (bgcolor && isSafeCssColor(bgcolor.trim())) {
    const existing = node.getAttribute("style") ?? "";
    if (!/(?:^|;)\s*background-color\s*:/i.test(existing)) {
      node.setAttribute("style", appendStyle(existing, `background-color: ${bgcolor.trim()}`));
    }
  }
  const colorAttr = node.getAttribute("color");
  if (colorAttr && isSafeCssColor(colorAttr.trim()) && (node.tagName === "FONT" || node.tagName === "SPAN")) {
    const existing = node.getAttribute("style") ?? "";
    if (!/(?:^|;)\s*color\s*:/i.test(existing)) {
      node.setAttribute("style", appendStyle(existing, `color: ${colorAttr.trim()}`));
    }
  }
}

function appendStyle(existing: string, decl: string): string {
  const base = existing.trim().replace(/;\s*$/, "");
  return base ? `${base}; ${decl}` : decl;
}

function sanitizeInlineStyle(style: string, options?: { keepImportant?: boolean }): string {
  const keepImportant = options?.keepImportant === true;
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const colon = decl.indexOf(":");
      if (colon <= 0) return null;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const rawTail = decl.slice(colon + 1).trim();
      const important = /\s*!important\s*$/i.test(rawTail);
      const rawValue = rawTail.replace(/\s*!important\s*$/i, "").trim();
      if (!SAFE_STYLE_PROPS.has(prop) || !isSafeStyleValue(prop, rawValue)) return null;
      return `${prop}: ${rawValue}${keepImportant && important ? " !important" : ""}`;
    })
    .filter((decl): decl is string => !!decl)
    .join("; ");
}

function isSafeStyleValue(prop: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (!value || /url\s*\(|expression\s*\(|javascript:|behavior:|-moz-binding|@import|attr\s*\(/i.test(lower)) {
    return false;
  }
  // Block layout escape / stacking that can overlay the app chrome.
  if (/fixed|sticky|absolute/.test(lower) && (prop === "display" || prop.includes("position"))) {
    return false;
  }

  switch (prop) {
    case "text-align":
      return /^(left|center|right|justify|start|end)$/.test(lower);
    case "font-style":
      return /^(normal|italic|oblique)$/.test(lower);
    case "font-weight":
      return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(lower);
    case "font-variant":
      return /^(normal|small-caps)$/.test(lower);
    case "text-decoration":
    case "text-decoration-line":
      return /^(none|underline|line-through|overline)(\s+(underline|line-through|overline))*$/.test(lower);
    case "text-decoration-style":
      return /^(solid|double|dotted|dashed|wavy)$/.test(lower);
    case "text-decoration-color":
      return isSafeCssColor(value);
    case "text-transform":
      return /^(none|capitalize|uppercase|lowercase)$/.test(lower);
    case "font-family":
      return /^[\w\s,"'-]+$/.test(value) && value.length < 200;
    case "font-size":
    case "width":
    case "height":
    case "max-width":
    case "max-height":
    case "min-width":
    case "min-height":
    case "text-indent":
    case "letter-spacing":
    case "word-spacing":
    case "border-spacing":
      return LENGTH_OR_NORMAL.test(lower) || isMultiLength(lower, 1, 2);
    case "line-height":
      return LENGTH_OR_NORMAL.test(lower) || /^\d+(\.\d+)?$/.test(lower);
    case "margin":
    case "padding":
      return isMultiLength(lower, 1, 4);
    case "margin-left":
    case "margin-right":
    case "margin-top":
    case "margin-bottom":
    case "padding-left":
    case "padding-right":
    case "padding-top":
    case "padding-bottom":
      return LENGTH_TOKEN.test(lower);
    case "border-collapse":
      return /^(collapse|separate)$/.test(lower);
    case "border":
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left":
      return isSafeBorderShorthand(value);
    case "border-width":
      return isMultiToken(lower, 1, 4, (t) => BORDER_WIDTH.test(t));
    case "border-style":
      return isMultiToken(lower, 1, 4, (t) => BORDER_STYLE.test(t));
    case "border-color":
      return isMultiColor(value, 1, 4);
    case "border-top-width":
    case "border-right-width":
    case "border-bottom-width":
    case "border-left-width":
      return BORDER_WIDTH.test(lower);
    case "border-top-style":
    case "border-right-style":
    case "border-bottom-style":
    case "border-left-style":
      return BORDER_STYLE.test(lower);
    case "border-top-color":
    case "border-right-color":
    case "border-bottom-color":
    case "border-left-color":
      return isSafeCssColor(value);
    case "border-radius":
      return isMultiLength(lower.replace(/\//g, " "), 1, 8);
    case "color":
    case "background-color":
      return isSafeCssColor(value);
    case "background":
      // Color-only backgrounds (no images). Marketing mail often uses this shorthand.
      return isSafeCssColor(value) || /^(transparent|none)$/.test(lower);
    case "display":
      return /^(block|inline|inline-block|inline-table|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption|list-item|none|contents|flow-root)$/.test(lower);
    case "vertical-align":
      return /^(baseline|sub|super|top|text-top|middle|bottom|text-bottom|0|-?\d+(\.\d+)?(px|pt|em|rem|%))$/.test(lower);
    case "white-space":
      return /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/.test(lower);
    case "word-break":
      return /^(normal|break-all|keep-all|break-word)$/.test(lower);
    case "overflow-wrap":
    case "word-wrap":
      return /^(normal|break-word|anywhere)$/.test(lower);
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      return /^(visible|hidden|clip|scroll|auto)$/.test(lower);
    case "opacity":
      return /^(0|1|0?\.\d+)$/.test(lower);
    case "list-style-type":
      return /^(disc|circle|square|decimal|decimal-leading-zero|lower-roman|upper-roman|lower-alpha|upper-alpha|lower-latin|upper-latin|none)$/.test(lower);
    case "list-style-position":
      return /^(inside|outside)$/.test(lower);
    case "list-style":
      return !/url\s*\(/i.test(lower) && value.length < 80;
    case "table-layout":
      return /^(auto|fixed)$/.test(lower);
    case "empty-cells":
      return /^(show|hide)$/.test(lower);
    case "float":
      return /^(left|right|none|inline-start|inline-end)$/.test(lower);
    case "clear":
      return /^(none|left|right|both|inline-start|inline-end)$/.test(lower);
    case "box-sizing":
      return /^(border-box|content-box)$/.test(lower);
    case "visibility":
      return /^(visible|hidden|collapse)$/.test(lower);
    case "font":
      // Shorthand is hard to validate fully; allow conservative system/web-safe forms without url().
      return value.length < 120 && !/url\s*\(/i.test(lower);
    default:
      return false;
  }
}

function isMultiLength(value: string, min: number, max: number): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every((token) => LENGTH_TOKEN.test(token));
}

function isMultiToken(value: string, min: number, max: number, test: (token: string) => boolean): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every(test);
}

function isMultiColor(value: string, min: number, max: number): boolean {
  // Split carefully enough for simple hex/named colors; rgba() with commas is a single color only.
  if (/^rgba?\(/i.test(value.trim()) || /^hsla?\(/i.test(value.trim())) {
    return min <= 1 && isSafeCssColor(value);
  }
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every((token) => isSafeCssColor(token));
}

function isSafeBorderShorthand(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (!lower || lower === "none" || lower === "0") return true;
  // Allow order-independent width/style/color tokens.
  // Collapse rgba() to a single token first.
  const normalized = lower
    .replace(/rgba?\([^)]+\)/g, "§color§")
    .replace(/hsla?\([^)]+\)/g, "§color§");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((token) => {
    if (token === "§color§") return true;
    if (BORDER_WIDTH.test(token)) return true;
    if (BORDER_STYLE.test(token)) return true;
    return isSafeCssColor(token);
  });
}

function isSafeCssColor(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (/^#[0-9a-f]{3,8}$/.test(lower)) return true;
  if (/^[a-z]+$/.test(lower)) return true;
  if (/^transparent$/i.test(lower)) return true;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/.test(lower)) return true;
  if (/^rgba?\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}(\s*\/\s*(0|1|0?\.\d+|\d+%))?\s*\)$/.test(lower)) return true;
  if (/^hsla?\(\s*\d{1,3}(\.\d+)?(deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(\s*,\s*(0|1|0?\.\d+))?\s*\)$/.test(lower)) return true;
  return false;
}

/**
 * Pull presentation hints off a full HTML document's <body> before tags are
 * stripped, so marketing mails that set body bgcolor/text keep their look.
 */
export function extractMailDocumentChrome(html: string): string {
  if (typeof DOMParser === "undefined") {
    const bg = /\bbody\b[^>]*\bbgcolor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
    const text = /\bbody\b[^>]*\btext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
    const styleMatch = /\bbody\b[^>]*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
    const parts: string[] = [];
    const bgColor = bg?.[1] ?? bg?.[2] ?? bg?.[3];
    const textColor = text?.[1] ?? text?.[2] ?? text?.[3];
    if (bgColor && isSafeCssColor(bgColor)) parts.push(`background-color: ${bgColor}`);
    if (textColor && isSafeCssColor(textColor)) parts.push(`color: ${textColor}`);
    if (styleMatch) {
      const sanitized = sanitizeInlineStyle(styleMatch[1] ?? styleMatch[2] ?? "");
      if (sanitized) parts.push(sanitized);
    }
    return parts.join("; ");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  const parts: string[] = [];
  const bgcolor = body.getAttribute("bgcolor");
  if (bgcolor && isSafeCssColor(bgcolor.trim())) {
    parts.push(`background-color: ${bgcolor.trim()}`);
  }
  const text = body.getAttribute("text");
  if (text && isSafeCssColor(text.trim())) {
    parts.push(`color: ${text.trim()}`);
  }
  const style = body.getAttribute("style");
  if (style) {
    const sanitized = sanitizeInlineStyle(style);
    if (sanitized) parts.push(sanitized);
  }
  // De-dupe background-color / color if both attr + style set them.
  return sanitizeInlineStyle(parts.join("; "));
}

/** Extract `<style>` blocks before DOMPurify drops them. */
export function extractMailStyleBlocks(html: string): { html: string; styles: string } {
  if (typeof DOMParser === "undefined") {
    const styles: string[] = [];
    const stripped = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_full, css: string) => {
      styles.push(css);
      return "";
    });
    return { html: stripped, styles: styles.join("\n") };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles: string[] = [];
  doc.querySelectorAll("style").forEach((node) => {
    styles.push(node.textContent ?? "");
    node.remove();
  });
  // Drop external stylesheets — never load remote CSS into the reader.
  doc.querySelectorAll('link[rel~="stylesheet"]').forEach((node) => node.remove());
  return {
    html: doc.documentElement?.outerHTML ?? html,
    styles: styles.join("\n"),
  };
}

/**
 * Sanitize email stylesheets used by class/id driven HTML mail.
 * Keeps simple rules + @media; strips @import, url(), expressions, and unsafe props.
 */
export function sanitizeMailStylesheet(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return sanitizeCssRuleList(withoutComments).trim();
}

function sanitizeCssRuleList(css: string): string {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i]!)) i += 1;
    if (i >= n) break;

    if (css[i] === "@") {
      const headerStart = i;
      while (i < n && css[i] !== "{" && css[i] !== ";") i += 1;
      const header = css.slice(headerStart, i).trim();
      if (i < n && css[i] === ";") {
        i += 1;
        continue;
      }
      if (i >= n || css[i] !== "{") break;
      const block = readCssBraceBlock(css, i);
      i = block.end;
      if (/^@media\b/i.test(header) && isSafeMediaQuery(header)) {
        const inner = sanitizeCssRuleList(block.content);
        if (inner.trim()) out.push(`${normalizeCssWhitespace(header)}{${inner}}`);
      }
      continue;
    }

    const selectorStart = i;
    while (i < n && css[i] !== "{") {
      if (css[i] === "}" || css[i] === "@") break;
      i += 1;
    }
    if (i >= n || css[i] !== "{") {
      // Unrecoverable junk — skip one char to avoid infinite loops.
      if (i < n && css[i] !== "{") i += 1;
      continue;
    }
    const selector = css.slice(selectorStart, i).trim();
    const block = readCssBraceBlock(css, i);
    i = block.end;
    if (!isSafeCssSelector(selector)) continue;
    const decls = sanitizeInlineStyle(block.content, { keepImportant: true });
    if (!decls) continue;
    out.push(`${normalizeCssWhitespace(selector)}{${decls}}`);
  }
  return out.join("");
}

function readCssBraceBlock(css: string, openIndex: number): { content: string; end: number } {
  let depth = 0;
  let i = openIndex;
  for (; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { content: css.slice(openIndex + 1, i), end: i + 1 };
      }
    }
  }
  return { content: css.slice(openIndex + 1), end: css.length };
}

function isSafeMediaQuery(header: string): boolean {
  if (header.length > 400) return false;
  const lower = header.toLowerCase();
  if (/url\s*\(|expression|javascript:|behavior:|@import/.test(lower)) return false;
  return /^@media\b/.test(lower);
}

function isSafeCssSelector(selector: string): boolean {
  if (!selector || selector.length > 800) return false;
  const lower = selector.toLowerCase();
  if (/expression|javascript:|behavior:|-moz-binding|@import|url\s*\(|</.test(lower)) return false;
  // Reject unbalanced quotes / brackets that often signal broken or hostile input.
  if ((selector.match(/"/g) ?? []).length % 2 !== 0) return false;
  if ((selector.match(/'/g) ?? []).length % 2 !== 0) return false;
  return true;
}

function normalizeCssWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface MailDisplayDocument {
  /** Sanitized body fragment (no surrounding html/body). */
  bodyHtml: string;
  /** Sanitized CSS from original <style> blocks. */
  styles: string;
  /** Safe presentation for the document body element. */
  bodyStyle: string;
}

/**
 * Full Thunderbird-style display prep: body chrome + stylesheets + sanitized body.
 */
export function prepareMailDisplayDocument(html: string, allowRemoteImages: boolean): MailDisplayDocument {
  installMailPurifyHooks();
  const preprocessed = preprocessMailHtml(html);
  const { html: withoutStyles, styles: rawStyles } = extractMailStyleBlocks(preprocessed);
  const bodyStyle = extractMailDocumentChrome(withoutStyles);
  let bodyHtml = DOMPurify.sanitize(withoutStyles, MAIL_PURIFY_CONFIG) as unknown as string;
  if (!allowRemoteImages) {
    if (typeof DOMParser === "undefined") {
      bodyHtml = bodyHtml.replace(/<img\b[^>]*>/gi, (tag) => {
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
        const alt = altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "";
        return isRemoteMailImageSrc(src) ? remoteImagePlaceholderLabel(alt, src) : tag;
      });
    } else {
      const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
      doc.querySelectorAll("img").forEach((img) => {
        if (!isRemoteMailImageSrc(img.getAttribute("src"))) return;
        const placeholder = doc.createElement("span");
        placeholder.setAttribute("data-taomni-remote-image", "blocked");
        placeholder.className = "taomni-mail-remote-image-blocked";
        const src = img.getAttribute("src");
        const alt = img.getAttribute("alt");
        placeholder.textContent = remoteImagePlaceholderLabel(alt, src);
        if (src) placeholder.setAttribute("title", src);
        // Preserve layout footprint when width/height known so tables don't collapse as hard.
        const width = img.getAttribute("width") || img.style.width;
        const height = img.getAttribute("height") || img.style.height;
        if (width) placeholder.style.minWidth = /px|%|em|rem|pt$/i.test(width) ? width : `${width}px`;
        if (height) placeholder.style.minHeight = /px|%|em|rem|pt$/i.test(height) ? height : `${height}px`;
        img.replaceWith(placeholder);
      });
      bodyHtml = doc.body.innerHTML;
    }
  }
  return {
    bodyHtml,
    styles: sanitizeMailStylesheet(rawStyles),
    bodyStyle,
  };
}

export interface MailReaderRenderOptions {
  allowRemoteImages: boolean;
  /** Reader font size in px (from mail appearance). */
  fontSize?: number;
  /** Prefer dark paper defaults when the message has no own background. */
  preferDark?: boolean;
  /** Optional CSS font-family for body defaults. */
  fontFamily?: string;
}

function normalizeReaderOptions(
  options: boolean | MailReaderRenderOptions,
): Required<Pick<MailReaderRenderOptions, "allowRemoteImages">> & MailReaderRenderOptions {
  if (typeof options === "boolean") return { allowRemoteImages: options };
  return options;
}

function messageHasOwnBackground(bodyStyle: string): boolean {
  return /(?:^|;)\s*background(?:-color)?\s*:/i.test(bodyStyle);
}

/** Base reader chrome — light paper defaults similar to Thunderbird's message pane. */
export function buildMailReaderBaseCss(options?: {
  fontSize?: number;
  preferDark?: boolean;
  fontFamily?: string;
  forceDarkDefaults?: boolean;
}): string {
  const fontSize = Math.max(8, Math.min(32, options?.fontSize ?? 14));
  const fontFamily = options?.fontFamily?.trim()
    || `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const dark = options?.forceDarkDefaults === true;
  const fg = dark ? "#e8e6e3" : "#1a1a1a";
  const bg = dark ? "#1c1b22" : "#ffffff";
  const muted = dark ? "#c4c0ba" : "#333333";
  const link = dark ? "#8ab4f8" : "#0b57d0";
  const linkVisited = dark ? "#c58af9" : "#681da8";
  const preBg = dark ? "#2b2a33" : "#f4f4f5";
  const preBorder = dark ? "#3f3e46" : "#e4e4e7";
  const hr = dark ? "#3f3e46" : "#d4d4d8";
  const quoteBorder = dark ? "#8ab4f8" : "#729fcf";
  const blockedBg = dark ? "#2b2a33" : "#fafafa";
  const blockedFg = dark ? "#a1a1aa" : "#71717a";
  const blockedBorder = dark ? "#52525b" : "#a1a1aa";

  return `
html, body { margin: 0; padding: 0; }
body {
  font-family: ${fontFamily};
  font-size: ${fontSize}px;
  line-height: 1.5;
  color: ${fg};
  background: ${bg};
  word-wrap: break-word;
  overflow-wrap: anywhere;
  padding: 16px 20px 24px;
  -webkit-text-size-adjust: 100%;
  color-scheme: ${dark ? "dark" : "light"};
}
img { max-width: 100%; height: auto; }
a { color: ${link}; }
a:visited { color: ${linkVisited}; }
p { margin: 0 0 0.75em; }
p:last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 { margin: 0.9em 0 0.45em; line-height: 1.25; font-weight: 600; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.15em; }
ul, ol { margin: 0.5em 0 0.75em; padding-left: 1.5em; }
li { margin: 0.2em 0; }
blockquote {
  margin: 0.6em 0;
  padding: 0 0 0 0.85em;
  border-left: 2px solid ${quoteBorder};
  color: ${muted};
}
pre, code { font-family: ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, monospace; font-size: 0.92em; }
pre {
  margin: 0.6em 0;
  padding: 0.65em 0.8em;
  overflow: auto;
  background: ${preBg};
  border: 1px solid ${preBorder};
  border-radius: 4px;
  white-space: pre-wrap;
}
hr { margin: 1em 0; border: none; border-top: 1px solid ${hr}; }
table { border-collapse: collapse; border-spacing: 0; max-width: 100%; }
td, th { vertical-align: top; }
.taomni-mail-remote-image-blocked {
  display: inline-block;
  margin: 2px 0;
  padding: 3px 8px;
  border: 1px dashed ${blockedBorder};
  border-radius: 4px;
  background: ${blockedBg};
  color: ${blockedFg};
  font-size: 12px;
  line-height: 1.4;
  vertical-align: middle;
}
`.replace(/\s+/g, " ").trim();
}

/** @deprecated Use buildMailReaderBaseCss() — kept for callers expecting a constant. */
export const MAIL_READER_BASE_CSS = buildMailReaderBaseCss();

/**
 * Build a complete sandboxed document for the HTML mail reader iframe.
 * CSP + no scripts; remote images gated by allowRemoteImages.
 */
export function buildMailReaderSrcDoc(
  html: string,
  options: boolean | MailReaderRenderOptions = false,
): string {
  const opts = normalizeReaderOptions(options);
  const prepared = prepareMailDisplayDocument(html, opts.allowRemoteImages);
  const forceDarkDefaults = opts.preferDark === true && !messageHasOwnBackground(prepared.bodyStyle);
  const baseCss = buildMailReaderBaseCss({
    fontSize: opts.fontSize,
    preferDark: opts.preferDark,
    fontFamily: opts.fontFamily,
    forceDarkDefaults,
  });
  const imgSrc = opts.allowRemoteImages
    ? "img-src data: blob: cid: http: https:"
    : "img-src data: blob: cid:";
  const csp = [
    "default-src 'none'",
    imgSrc,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
  ].join("; ");

  const styleBlocks = [
    `<style>${baseCss}</style>`,
    prepared.styles ? `<style>${prepared.styles}</style>` : "",
  ].filter(Boolean).join("");

  const bodyAttr = prepared.bodyStyle
    ? ` style="${escapeHtml(prepared.bodyStyle)}"`
    : "";

  return [
    "<!DOCTYPE html>",
    `<html lang="en"${forceDarkDefaults ? ' data-taomni-reader="dark"' : ' data-taomni-reader="light"'}>`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    styleBlocks,
    "</head>",
    `<body${bodyAttr}>${prepared.bodyHtml}</body>`,
    "</html>",
  ].join("");
}

/** Remote content that should stay blocked until the user opts in (Thunderbird privacy model). */
export function isRemoteMailImageSrc(src: string | null | undefined): boolean {
  const value = (src ?? "").trim();
  if (!value) return false;
  if (/^(cid:|data:|blob:|file:)/i.test(value)) return false;
  return /^(https?:|\/\/)/i.test(value);
}

export function mailHtmlHasRemoteImages(html: string | null | undefined): boolean {
  const value = html?.trim();
  if (!value) return false;
  if (typeof DOMParser === "undefined") {
    return /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(value);
  }
  const doc = new DOMParser().parseFromString(value, "text/html");
  return Array.from(doc.querySelectorAll("img")).some((img) => isRemoteMailImageSrc(img.getAttribute("src")));
}

/**
 * Sanitize HTML for the message reader (fragment form, for non-iframe consumers).
 * When allowRemoteImages is false, only remote http(s) images are blocked —
 * embedded cid:/data: images remain visible (Thunderbird-aligned).
 */
export function sanitizeMailDisplayHtml(html: string, allowRemoteImages: boolean): string {
  const prepared = prepareMailDisplayDocument(html, allowRemoteImages);
  let out = prepared.bodyHtml;
  if (prepared.bodyStyle) {
    out = `<div class="taomni-mail-body-root" style="${escapeHtml(prepared.bodyStyle)}">${out}</div>`;
  }
  if (prepared.styles) {
    out = `<style>${prepared.styles}</style>${out}`;
  }
  return out;
}

export function sanitizeMailComposeHtml(html: string): string {
  installMailPurifyHooks();
  const sanitized = DOMPurify.sanitize(html, MAIL_PURIFY_CONFIG) as unknown as string;
  return sanitized.trim() || "<p><br></p>";
}

/**
 * Convert Markdown clipboard text to portable, email-safe HTML.
 *
 * This deliberately uses a mail-specific renderer rather than the chat
 * renderer: compose HTML must survive outside Taomni and use the mail
 * sanitizer/style policy as its final security boundary.
 */
export function markdownToMailHtml(markdown: string): string {
  const source = markdown.replace(/\r\n?/g, "\n");
  if (!source.trim()) return "<p><br></p>";
  const rendered = MAIL_MARKDOWN.parse(source) as string;
  const styled = addMailMarkdownStyles(rendered);
  return sanitizeMailComposeHtml(styled);
}

function addMailMarkdownStyles(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("blockquote").forEach((node) => {
    appendNodeStyle(node, "border-left: 2px solid #729fcf; margin: 0.6em 0; padding-left: 0.85em; color: #333333;");
  });
  doc.querySelectorAll("pre").forEach((node) => {
    appendNodeStyle(node, "margin: 0.6em 0; padding: 0.65em 0.8em; overflow: auto; background: #f4f4f5; color: #1f2937; white-space: pre-wrap; word-break: break-word;");
  });
  doc.querySelectorAll("pre code").forEach((node) => {
    appendNodeStyle(node, "font-family: ui-monospace, Consolas, monospace; font-size: 0.92em;");
  });
  doc.querySelectorAll("code:not(pre code)").forEach((node) => {
    appendNodeStyle(node, "font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; background: #f4f4f5; padding: 0.05em 0.35em;");
  });
  doc.querySelectorAll("table").forEach((node) => {
    appendNodeStyle(node, "border-collapse: collapse; border-spacing: 0; max-width: 100%;");
  });
  doc.querySelectorAll("th, td").forEach((node) => {
    appendNodeStyle(node, "border: 1px solid #d4d4d8; padding: 0.25em 0.5em; vertical-align: top; text-align: left;");
  });
  doc.querySelectorAll("th").forEach((node) => appendNodeStyle(node, "background: #f4f4f5; font-weight: 600;"));
  doc.querySelectorAll("hr").forEach((node) => appendNodeStyle(node, "margin: 1em 0; border: none; border-top: 1px solid #d4d4d8;"));
  return doc.body.innerHTML;
}

function appendNodeStyle(node: Element, style: string): void {
  const existing = node.getAttribute("style")?.trim();
  node.setAttribute("style", existing ? `${existing}; ${style}` : style);
}

/** Build a compose-time inline image that previews via data URL and sends as cid: */
export function buildInlineImageHtml(opts: {
  contentId: string;
  dataUrl: string;
  alt?: string;
}): string {
  const contentId = opts.contentId.trim();
  const dataUrl = opts.dataUrl.trim();
  const alt = opts.alt?.trim() || "image";
  return `<img src="${escapeHtml(dataUrl)}" data-taomni-cid="${escapeHtml(contentId)}" alt="${escapeHtml(alt)}">`;
}

/** Rewrite compose previews (data URL + data-taomni-cid) to cid: for MIME send. */
export function prepareMailHtmlForSend(html: string): string {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof DOMParser === "undefined") {
    return sanitized.replace(
      /<img\b([^>]*?)\bsrc=(["'])data:[^"']*\2([^>]*?)\bdata-taomni-cid=(["'])([^"']+)\4([^>]*)>/gi,
      (_full, before: string, _q1: string, mid: string, _q2: string, cid: string, after: string) =>
        `<img${before}src="cid:${cid}"${mid}${after}>`.replace(/\sdata-taomni-cid=(["'])[^"']+\1/i, ""),
    );
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  doc.querySelectorAll("img[data-taomni-cid]").forEach((img) => {
    const cid = img.getAttribute("data-taomni-cid")?.trim();
    if (!cid) return;
    img.setAttribute("src", `cid:${cid}`);
    img.removeAttribute("data-taomni-cid");
  });
  return doc.body.innerHTML.trim() || "<p><br></p>";
}

export function plainTextToMailHtml(text: string): string {
  const escaped = escapeHtml(text || "");
  if (!escaped) return "<p><br></p>";
  return `<p>${escaped.replace(/\r?\n/g, "<br>")}</p>`;
}

export function mailHtmlToPlainText(html: string): string {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof document === "undefined") {
    return sanitized.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  }
  const container = document.createElement("div");
  container.innerHTML = sanitized;
  return collectPlainText(container).replace(/\n{3,}/g, "\n\n").trim();
}

function collectPlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) {
    return Array.from(node.childNodes).map(collectPlainText).join("");
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  const text = Array.from(node.childNodes).map(collectPlainText).join("");
  if (tag === "li") return `* ${text.trim()}\n`;
  if (["p", "div", "blockquote", "tr", "table", "ul", "ol", "pre", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  if (tag === "td" || tag === "th") return `${text.trim()}\t`;
  return text;
}

export function hasRichMailFormatting(html: string): boolean {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof DOMParser === "undefined") {
    return /<(b|strong|i|em|u|a|ul|ol|li|table|blockquote|font|h[1-6]|img)\b/i.test(sanitized)
      || /\sstyle=/.test(sanitized);
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  return Array.from(doc.body.querySelectorAll("*")).some((node) => {
    const tag = node.tagName.toLowerCase();
    if (!["p", "div", "br", "span"].includes(tag)) return true;
    return node.hasAttribute("style") || node.hasAttribute("align");
  });
}

export function signatureToMailHtml(signature: string | null | undefined): string {
  const clean = signature?.trimEnd();
  if (!clean) return "";
  return `<p><br>-- <br>${escapeHtml(clean).replace(/\r?\n/g, "<br>")}</p>`;
}

export function buildReplyHtml(intro: string, original: { html?: string | null; text?: string | null }, signature?: string | null): string {
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>${escapeHtml(intro)}</p><blockquote type="cite" style="border-left: 2px solid #729fcf; margin-left: 0.8em; padding-left: 0.8em;">${originalHtml}</blockquote>`;
}

export function buildForwardHtml(headerLines: string[], original: { html?: string | null; text?: string | null }, signature?: string | null): string {
  const header = headerLines.map(escapeHtml).join("<br>");
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>---------- Forwarded message ----------<br>${header}</p>${originalHtml}`;
}

export function quotePlainText(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
