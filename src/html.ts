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

  // 1. Extract fenced code blocks into placeholders
  const codeBlocks: string[] = [];
  const withPlaceholders = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const html = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(html);
    return `${PLACEHOLDER_PREFIX}${codeBlocks.length - 1}${PLACEHOLDER_SUFFIX}`;
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

      // Bullet lists: leading "- " or "* " → "• "
      s = s.replace(/^[\t ]*[-*]\s+/gm, "• ");

      return s;
    })
    .join("");
}
