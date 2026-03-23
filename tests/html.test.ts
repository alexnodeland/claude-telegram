import { describe, expect, test } from "bun:test";
import { escapeHtml, fmt, markdownToTelegramHtml } from "../src/html.js";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtml("a < b > c")).toBe("a &lt; b &gt; c");
  });

  test("escapes all three in combination", () => {
    expect(escapeHtml("<script>alert('x&y')</script>")).toBe("&lt;script&gt;alert('x&amp;y')&lt;/script&gt;");
  });

  test("passes through safe text unchanged", () => {
    expect(escapeHtml("Hello world 123!")).toBe("Hello world 123!");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes multiple occurrences", () => {
    expect(escapeHtml("a&b&c")).toBe("a&amp;b&amp;c");
  });
});

describe("fmt helpers", () => {
  test("bold wraps in <b> and escapes", () => {
    expect(fmt.bold("hello")).toBe("<b>hello</b>");
    expect(fmt.bold("a < b")).toBe("<b>a &lt; b</b>");
  });

  test("italic wraps in <i> and escapes", () => {
    expect(fmt.italic("hello")).toBe("<i>hello</i>");
  });

  test("code wraps in <code> and escapes", () => {
    expect(fmt.code("let x = 1")).toBe("<code>let x = 1</code>");
    expect(fmt.code("a<b>c")).toBe("<code>a&lt;b&gt;c</code>");
  });

  test("pre wraps in <pre> and escapes", () => {
    expect(fmt.pre("line1\nline2")).toBe("<pre>line1\nline2</pre>");
  });

  test("preBlock with language wraps in <pre><code>", () => {
    const result = fmt.preBlock("const x = 1;", "typescript");
    expect(result).toBe('<pre><code class="language-typescript">const x = 1;</code></pre>');
  });

  test("preBlock without language is same as pre", () => {
    expect(fmt.preBlock("hello")).toBe("<pre>hello</pre>");
  });

  test("link wraps in <a> and escapes both text and url", () => {
    expect(fmt.link("click", "https://example.com")).toBe('<a href="https://example.com">click</a>');
    expect(fmt.link("a<b", "x&y")).toBe('<a href="x&amp;y">a&lt;b</a>');
  });

  test("strikethrough wraps in <s> and escapes", () => {
    expect(fmt.strikethrough("removed")).toBe("<s>removed</s>");
  });
});

describe("markdownToTelegramHtml", () => {
  test("converts bold", () => {
    expect(markdownToTelegramHtml("hello **world**")).toBe("hello <b>world</b>");
  });

  test("converts italic with asterisks", () => {
    expect(markdownToTelegramHtml("hello *world*")).toBe("hello <i>world</i>");
  });

  test("converts inline code", () => {
    expect(markdownToTelegramHtml("use `foo()` here")).toBe("use <code>foo()</code> here");
  });

  test("converts fenced code blocks", () => {
    const input = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(markdownToTelegramHtml(input)).toBe(
      'before\n<pre><code class="language-ts">const x = 1;</code></pre>\nafter',
    );
  });

  test("converts fenced code blocks without language", () => {
    const input = "```\nhello\n```";
    expect(markdownToTelegramHtml(input)).toBe("<pre>hello</pre>");
  });

  test("converts headers to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
  });

  test("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~removed~~")).toBe("<s>removed</s>");
  });

  test("converts links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  test("converts bullet lists", () => {
    expect(markdownToTelegramHtml("- item one\n- item two")).toBe("• item one\n• item two");
  });

  test("escapes HTML in regular text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("escapes HTML inside code blocks", () => {
    const input = "```\n<div>hi</div>\n```";
    expect(markdownToTelegramHtml(input)).toBe("<pre>&lt;div&gt;hi&lt;/div&gt;</pre>");
  });

  test("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("use `<b>tag</b>`")).toBe("use <code>&lt;b&gt;tag&lt;/b&gt;</code>");
  });

  test("handles mixed formatting", () => {
    const input = "**bold** and *italic* and `code`";
    expect(markdownToTelegramHtml(input)).toBe("<b>bold</b> and <i>italic</i> and <code>code</code>");
  });

  test("passes plain text through with only HTML escaping", () => {
    expect(markdownToTelegramHtml("hello world")).toBe("hello world");
  });

  test("converts simple table to aligned pre block", () => {
    const input = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("─");
    expect(result).not.toContain("|");
  });

  test("table columns are padded to align", () => {
    const input = "| A | BB |\n|---|----|\n| x | yy |";
    const result = markdownToTelegramHtml(input);
    // Header and data should be padded to same width (2-space column gap)
    expect(result).toContain("A  BB");
    expect(result).toContain("x  yy");
  });

  test("table with HTML special chars is escaped", () => {
    const input = "| Col |\n|-----|\n| <b> |";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("&lt;b&gt;");
    expect(result).not.toContain("<b>");
  });
});
