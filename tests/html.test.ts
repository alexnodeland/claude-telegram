import { describe, expect, test } from "bun:test";
import { escapeHtml, fmt } from "../src/html.js";

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
