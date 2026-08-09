import { describe, expect, it } from "vitest";
import {
  buildInlineImageHtml,
  buildMailReaderSrcDoc,
  buildReplyHtml,
  hasRichMailFormatting,
  markdownToMailHtml,
  isRemoteMailImageSrc,
  mailHtmlHasRemoteImages,
  mailHtmlToPlainText,
  plainTextToMailHtml,
  prepareMailDisplayDocument,
  prepareMailHtmlForSend,
  preprocessMailHtml,
  sanitizeMailComposeHtml,
  sanitizeMailDisplayHtml,
  sanitizeMailStylesheet,
} from "./mailHtml";

describe("mailHtml", () => {
  it("sanitizes unsafe tags, attributes, and inline styles while keeping safe formatting", () => {
    const html = sanitizeMailComposeHtml(`
      <p onclick="alert(1)" style="color: #123456; position: fixed; background-image: url(javascript:alert(1))">
        Hello <strong>team</strong><script>alert(1)</script>
      </p>
      <a href="https://example.com" onmouseover="alert(1)">link</a>
    `);

    expect(html).toContain("Hello <strong>team</strong>");
    expect(html).toContain("style=\"color: #123456\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("position");
    expect(html).not.toContain("background-image");
  });

  it("blocks only remote images for display until explicitly allowed (Thunderbird-style)", () => {
    const mixed = [
      "<p>before",
      "<img src=\"https://example.com/a.png\" alt=\"remote\">",
      "<img src=\"cid:logo@inline.local\" alt=\"embedded\">",
      "<img src=\"data:image/png;base64,aaaa\" alt=\"data\">",
      "after</p>",
    ].join("");

    const blocked = sanitizeMailDisplayHtml(mixed, false);
    const allowed = sanitizeMailDisplayHtml(mixed, true);

    expect(blocked).toContain("remote image blocked");
    expect(blocked).not.toMatch(/<img[^>]+src=["']https:\/\/example\.com\/a\.png/i);
    expect(blocked).toContain("cid:logo@inline.local");
    expect(blocked).toContain("data:image/png;base64,aaaa");
    expect(allowed).toContain("https://example.com/a.png");
    expect(allowed).toContain("cid:logo@inline.local");
    expect(isRemoteMailImageSrc("https://cdn.example/x.png")).toBe(true);
    expect(isRemoteMailImageSrc("cid:logo@inline.local")).toBe(false);
    expect(isRemoteMailImageSrc("data:image/png;base64,aa")).toBe(false);
    expect(mailHtmlHasRemoteImages(mixed)).toBe(true);
    expect(mailHtmlHasRemoteImages("<p><img src=\"cid:x@y\"></p>")).toBe(false);
  });

  it("preserves compose CID/data images and safe inserted table styles", () => {
    const html = sanitizeMailComposeHtml(`
      <p><img src="cid:logo-1@inline.local" alt="logo"></p>
      <p><img src="data:image/png;base64,abcd" data-taomni-cid="paste-1@inline.local" alt="pasted"></p>
      <table style="border-collapse: collapse; position: fixed">
        <tbody><tr><td style="border: 1px solid #9ca3af; padding: 4px 8px; background-image: url(javascript:alert(1))">Cell</td></tr></tbody>
      </table>
    `);

    expect(html).toContain("src=\"cid:logo-1@inline.local\"");
    expect(html).toContain("data:image/png;base64,abcd");
    expect(html).toContain("data-taomni-cid=\"paste-1@inline.local\"");
    expect(html).toContain("border-collapse: collapse");
    expect(html).toContain("border: 1px solid #9ca3af");
    expect(html).toContain("padding: 4px 8px");
    expect(html).not.toContain("position");
    expect(html).not.toContain("background-image");
  });

  it("keeps marketing-mail layout styles and body chrome for the reader", () => {
    const html = sanitizeMailDisplayHtml(`
      <html><body bgcolor="#f5f5f5" text="#222222" style="margin: 0; padding: 0">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; margin: 0 auto; background-color: #ffffff">
          <tr>
            <td bgcolor="#0b57d0" style="padding: 20px 40px; width: 100%; max-width: 600px; line-height: 1.4; vertical-align: middle">
              <h1 style="margin: 0; color: #ffffff; font-size: 22px">Launch</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px; border-top: 1px solid #e5e7eb">
              Hello <strong>team</strong>
            </td>
          </tr>
        </table>
      </body></html>
    `, true);

    expect(html).toContain("taomni-mail-body-root");
    expect(html).toContain("background-color: #f5f5f5");
    expect(html).toContain("color: #222222");
    expect(html).toContain("width: 600px");
    expect(html).toContain("margin: 0 auto");
    expect(html).toContain("padding: 20px 40px");
    expect(html).toContain("line-height: 1.4");
    expect(html).toContain("vertical-align: middle");
    expect(html).toContain("border-top: 1px solid #e5e7eb");
    expect(html).toContain("background-color: #0b57d0");
    expect(html).toContain("cellpadding=\"0\"");
    expect(html).toContain("cellspacing=\"0\"");
  });

  it("builds preview HTML and rewrites data-taomni-cid images to cid for send", () => {
    const preview = buildInlineImageHtml({
      contentId: "logo-1@inline.local",
      dataUrl: "data:image/png;base64,abcd",
      alt: "logo",
    });
    expect(preview).toContain("data:image/png;base64,abcd");
    expect(preview).toContain("data-taomni-cid=\"logo-1@inline.local\"");

    const forSend = prepareMailHtmlForSend(`<p>${preview}</p>`);
    expect(forSend).toContain("src=\"cid:logo-1@inline.local\"");
    expect(forSend).not.toContain("data:image");
    expect(forSend).not.toContain("data-taomni-cid");
  });

  it("renders Markdown as sanitized portable mail HTML", () => {
    const html = markdownToMailHtml([
      "# Hello",
      "",
      "A **bold** item and [safe link](https://example.com).",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "<script>alert(1)</script>",
      "[bad](javascript:alert(1))",
    ].join("\n"));

    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table");
    expect(html).toContain("<pre");
    expect(html).toContain("const answer = 42;");
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("border-collapse");
  });

  it("normalizes bare carriage returns in plain text", () => {
    expect(markdownToMailHtml("one\rtwo")).toContain("one<br>two");
  });

  it("round-trips plain text through mail HTML and extracts readable text from lists and paragraphs", () => {
    expect(plainTextToMailHtml("Hello\nWorld")).toBe("<p>Hello<br>World</p>");

    const text = mailHtmlToPlainText("<p>Hello<br>World</p><ul><li>One</li><li>Two</li></ul>");
    expect(text).toBe("Hello\nWorld\n* One\n* Two");
  });

  it("detects whether auto send mode should include an HTML body", () => {
    expect(hasRichMailFormatting("<p>Hello<br>World</p>")).toBe(false);
    expect(hasRichMailFormatting("<p><strong>Hello</strong></p>")).toBe(true);
    expect(hasRichMailFormatting("<p style=\"color: #111111\">Hello</p>")).toBe(true);
    expect(hasRichMailFormatting("<ul><li>Hello</li></ul>")).toBe(true);
  });

  it("builds a sanitized Thunderbird-style reply quote that preserves original HTML", () => {
    const html = buildReplyHtml(
      "On July 2, Alice wrote:",
      { html: "<p><b>Hello</b><script>alert(1)</script></p>" },
      "Best,\nMe",
    );

    expect(html).toContain("-- <br>Best,<br>Me");
    expect(html).toContain("On July 2, Alice wrote:");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<b>Hello</b>");
    expect(html).not.toContain("script");
  });

  it("sanitizes email stylesheets while keeping class rules and @media", () => {
    const css = sanitizeMailStylesheet(`
      @import url("https://evil.example/x.css");
      .hero { background-color: #0b57d0; color: #fff !important; padding: 20px; }
      .hero a { color: #fff; text-decoration: none; }
      @media only screen and (max-width: 600px) {
        .hero { width: 100% !important; padding: 12px; }
      }
      .bad { background-image: url(https://evil.example/x.png); position: fixed; }
    `);

    expect(css).toContain(".hero{");
    expect(css).toContain("background-color: #0b57d0");
    expect(css).toContain("color: #fff !important");
    expect(css).toContain("@media only screen and (max-width: 600px)");
    expect(css).toContain("width: 100% !important");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("background-image");
    expect(css).not.toContain("position");
  });

  it("builds an isolated reader srcdoc with styles, body chrome, and CSP", () => {
    const src = buildMailReaderSrcDoc(`
      <html>
        <head>
          <style>
            .card { background-color: #f8fafc; padding: 16px; border: 1px solid #e2e8f0; float: left; }
          </style>
          <script>alert(1)</script>
        </head>
        <body bgcolor="#eeeeee" style="margin: 0">
          <div class="card">Styled card content</div>
          <img src="https://cdn.example/track.png" alt="remote">
        </body>
      </html>
    `, false);

    expect(src).toContain("Content-Security-Policy");
    expect(src).toContain("script-src 'none'");
    expect(src).toContain("img-src data: blob: cid:");
    expect(src).not.toContain("http: https:");
    expect(src).toContain(".card{");
    expect(src).toContain("float: left");
    expect(src).toContain("background-color: #eeeeee");
    expect(src).toContain("Styled card content");
    expect(src).toContain("remote image blocked");
    expect(src).not.toContain("<script");
    expect(src).not.toMatch(/<img[^>]+src=["']https:\/\/cdn\.example/i);

    const prepared = prepareMailDisplayDocument(`
      <style>.x{color:#111}</style><p class="x">Hi</p>
    `, true);
    expect(prepared.styles).toContain(".x{color: #111}");
    expect(prepared.bodyHtml).toContain("Hi");
  });

  it("preprocesses Outlook/MSO conditional comments and office tags", () => {
    const raw = `
      <?xml version="1.0"?>
      <!--[if mso]><table><tr><td>MSO only</td></tr></table><![endif]-->
      <!--[if !mso]><!--><div class="web">Visible web content</div><!--<![endif]-->
      <p><o:p>&nbsp;</o:p>Hello</p>
      <xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml>
    `;
    const cleaned = preprocessMailHtml(raw);
    expect(cleaned).toContain("Visible web content");
    expect(cleaned).toContain("Hello");
    expect(cleaned).not.toContain("MSO only");
    expect(cleaned).not.toContain("<o:p>");
    expect(cleaned).not.toContain("<xml>");
    expect(cleaned).not.toContain("<?xml");

    const display = sanitizeMailDisplayHtml(raw, true);
    expect(display).toContain("Visible web content");
    expect(display).not.toContain("MSO only");
  });

  it("labels blocked remote images with alt text or host", () => {
    const blocked = sanitizeMailDisplayHtml(
      '<p><img src="https://cdn.example/track.png" alt="Tracker pixel" width="1" height="1"></p>',
      false,
    );
    expect(blocked).toContain("remote image blocked");
    expect(blocked).toContain("Tracker pixel");
    expect(blocked).not.toMatch(/<img[^>]+src=["']https:\/\/cdn\.example/i);
    // Full URL may remain only as title tooltip for the placeholder.
    expect(blocked).toContain('data-taomni-remote-image="blocked"');
  });

  it("uses dark paper defaults only when preferDark and message has no own background", () => {
    const darkSimple = buildMailReaderSrcDoc("<p>Hello</p>", {
      allowRemoteImages: false,
      preferDark: true,
      fontSize: 16,
    });
    expect(darkSimple).toContain("font-size: 16px");
    expect(darkSimple).toContain("data-taomni-reader=\"dark\"");
    expect(darkSimple).toContain("background: #1c1b22");

    const darkBranded = buildMailReaderSrcDoc(
      '<body bgcolor="#ffffff" style="background-color: #ffffff"><p>Brand</p></body>',
      { allowRemoteImages: false, preferDark: true },
    );
    expect(darkBranded).toContain("data-taomni-reader=\"light\"");
    expect(darkBranded).toContain("background-color: #ffffff");
  });
});
