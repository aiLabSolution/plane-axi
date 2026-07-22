import { encode } from "./toon.js";

export function emit(value) {
  const text = encode(value);
  if (text) process.stdout.write(`${text}\n`);
}

export function emitError(error) {
  const payload = { error: error.message };
  if (error.help) payload.help = Array.isArray(error.help) ? error.help : [error.help];
  emit(payload);
}

export function withHelp(payload, hints = []) {
  return hints.length ? { ...payload, help: hints } : payload;
}

export function stripHtml(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .trim();
}

export function truncate(value, limit = 1000) {
  const text = String(value ?? "");
  return text.length <= limit
    ? { text, truncated: false, total: text.length }
    : { text: `${text.slice(0, limit)}\n... (truncated, ${text.length} chars total)`, truncated: true, total: text.length };
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
