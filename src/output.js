import { encode } from "./toon.js";

export function emit(value) {
  const text = encode(value);
  if (text) process.stdout.write(`${text}\n`);
}

function scrubSurrogates(value) {
  let output = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    output += char.length === 1 && code >= 0xd800 && code <= 0xdfff ? "�" : char;
  }
  return output;
}

export function emitError(error) {
  const message = scrubSurrogates(error?.message ?? "unexpected error");
  const payload = { error: message };
  if (error?.help) payload.help = (Array.isArray(error.help) ? error.help : [error.help]).map(scrubSurrogates);
  try {
    emit(payload);
  } catch {
    process.stdout.write(`error: ${JSON.stringify(message)}\n`);
  }
}

export function withHelp(payload, hints = []) {
  return hints.length ? { ...payload, help: hints } : payload;
}

const BLOCK_CLOSERS = /<\/(?:p|li|h[1-6]|div|blockquote|tr|ul|ol|pre)\s*>/gi;

export function stripHtml(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li(?:\s[^>]*)?>/gi, "- ")
    .replace(BLOCK_CLOSERS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(value, limit = 1000) {
  const text = String(value ?? "");
  if (text.length <= limit) return { text, truncated: false, total: text.length };
  let cut = limit;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: `${text.slice(0, cut)}\n... (truncated, ${text.length} chars total)`, truncated: true, total: text.length };
}

export function htmlParagraph(text) {
  const escaped = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
  return `<p>${escaped}</p>`;
}
