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
