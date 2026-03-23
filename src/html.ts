/**
 * HTML escape and formatting utilities for Telegram's HTML parse mode.
 *
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a>, <s>, <u>, <tg-spoiler>.
 * Only three characters require escaping: & < >
 */

/** Escape text for safe inclusion in Telegram HTML messages. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Formatting helpers — each auto-escapes content. */
export const fmt = {
  bold: (text: string) => `<b>${escapeHtml(text)}</b>`,
  italic: (text: string) => `<i>${escapeHtml(text)}</i>`,
  code: (text: string) => `<code>${escapeHtml(text)}</code>`,
  pre: (text: string) => `<pre>${escapeHtml(text)}</pre>`,
  preBlock: (text: string, language?: string) =>
    language
      ? `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`
      : `<pre>${escapeHtml(text)}</pre>`,
  link: (text: string, url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`,
  strikethrough: (text: string) => `<s>${escapeHtml(text)}</s>`,
};

/**
 * Convert Markdown (Claude's output format) to Telegram-compatible HTML.
 *
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, and headers. Content is HTML-escaped before conversion so the
 * resulting string is safe to send with parse_mode: "HTML".
 */
export function markdownToTelegramHtml(md: string): string {
  const PLACEHOLDER_PREFIX = "\u2060CBLK";
  const PLACEHOLDER_SUFFIX = "CBLK\u2060";

  // 1. Extract fenced code blocks and tables into placeholders
  const codeBlocks: string[] = [];
  let withPlaceholders = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const html = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(html);
    return `${PLACEHOLDER_PREFIX}${codeBlocks.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // 1b. Extract Markdown tables into <pre> placeholders
  withPlaceholders = withPlaceholders.replace(/(?:^|\n)(\|.+\|(?:\r?\n\|.+\|)*)/g, (_match, tableBlock: string) => {
    const html = convertMarkdownTable(tableBlock);
    codeBlocks.push(html);
    return `\n${PLACEHOLDER_PREFIX}${codeBlocks.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // 2. Process non-code-block text
  const placeholderRe = new RegExp(`(${PLACEHOLDER_PREFIX}\\d+${PLACEHOLDER_SUFFIX})`, "g");
  const matchRe = new RegExp(`^${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}$`);

  const processed = withPlaceholders
    .split(placeholderRe)
    .map((segment) => {
      const cbMatch = segment.match(matchRe);
      if (cbMatch) return codeBlocks[Number(cbMatch[1])];
      return convertInlineFormatting(segment);
    })
    .join("");

  return processed;
}

/** Convert inline Markdown formatting in a text segment (no fenced code blocks). */
function convertInlineFormatting(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);

  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      let s = escapeHtml(part);

      // Headers → bold
      s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes: string, content: string) => `<b>${content}</b>`);

      // Bold: **text** or __text__
      s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      s = s.replace(/__(.+?)__/g, "<b>$1</b>");

      // Italic: *text* or _text_
      s = s.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<i>$1</i>");
      s = s.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");

      // Strikethrough: ~~text~~
      s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

      // Links: [text](url)
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

      // Numbered lists: leading "1. " → keep number with period
      s = s.replace(/^[\t ]*(\d+)\.\s+/gm, "$1. ");

      // Bullet lists: leading "- " or "* " → "• "
      s = s.replace(/^[\t ]*[-*]\s+/gm, "• ");

      // Blockquotes: leading "> " → <blockquote>
      // Collect consecutive quoted lines into a single blockquote
      s = s.replace(/(?:^&gt; (.+)$(?:\n|$))+/gm, (match) => {
        const inner = match
          .split("\n")
          .map((line) => line.replace(/^&gt; /, ""))
          .filter((line) => line !== "")
          .join("\n");
        return `<blockquote>${inner}</blockquote>\n`;
      });

      return s;
    })
    .join("");
}

/** Convert a Markdown table to an aligned monospace <pre> block. */
function convertMarkdownTable(tableText: string): string {
  const rows = tableText.split(/\r?\n/).filter((r) => r.includes("|"));

  // Parse cells from each row
  const parsed = rows.map((row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim()),
  );

  // Filter out separator rows (--- or :---: etc.)
  const dataRows = parsed.filter((cells) => !cells.every((c) => /^[:\-\s]+$/.test(c)));
  if (dataRows.length === 0) return `<pre>${escapeHtml(tableText)}</pre>`;

  // Calculate max width per column
  const colCount = Math.max(...dataRows.map((r) => r.length));
  const widths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of dataRows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? "").length);
    }
  }

  // Build aligned rows
  const lines = dataRows.map((row, rowIdx) => {
    const padded = widths.map((w, i) => (row[i] ?? "").padEnd(w)).join("  ");
    // Add a separator line after the header
    if (rowIdx === 0 && dataRows.length > 1) {
      const sep = widths.map((w) => "─".repeat(w)).join("──");
      return `${padded}\n${sep}`;
    }
    return padded;
  });

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}
