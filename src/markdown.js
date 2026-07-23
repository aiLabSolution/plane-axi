// Markdown → Plane-friendly rich-text HTML (description_html / comment_html).
// Faithful JS port of lis-control/scripts/plane_issue.py's md_to_html/_inline/_esc/_link/
// _render_li. Coverage is deliberately small (matches the PRD/slice body template): ATX
// headings, unordered/ordered lists with one nesting level, task items, fenced code
// blocks, blockquotes, --- rules, blank-line paragraphs, inline **bold**/`code`/[links].
// Anything else passes through as literal text — never as raw HTML.

function esc(s) {
  // Escape HTML metacharacters for text AND double-quoted-attribute contexts. Quotes are
  // escaped too so author text can never break out of an attribute (e.g. a fenced-code
  // ```lang string that lands in class="..."). Never raw markup.
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function link(full, text, url) {
  // Both text/url are already esc()'d by the caller. Reject protocol-relative (//host)
  // and any non-allowlisted scheme — render the literal markdown instead of an <a>
  // (no javascript:/data:/off-site smuggling).
  if (url.startsWith("//") || !/^(?:https?:|mailto:|\/|#|\.)/i.test(url)) return full;
  return `<a href="${url}">${text}</a>`;
}

function inline(text) {
  // Render inline markdown on a single segment. Escapes first, so input is plain text.
  text = text.replace(/\x00/g, ""); // NUL is our link sentinel; never allow it from input
  const out = [];
  // Split out `code` spans so their contents are never treated as bold/link markup.
  for (const part of text.split(/(`[^`]+`)/)) {
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(`<code>${esc(part.slice(1, -1))}</code>`);
      continue;
    }
    let seg = esc(part);
    // Stash rendered links behind sentinels BEFORE the bold pass, so `**` inside a URL
    // can't be rewritten into the href. Link text excludes brackets to bound
    // backtracking on pathological input (e.g. a long run of '[').
    const links = [];
    seg = seg.replace(/\[([^\][]+)\]\(([^)\s[]+)\)/g, (full, t, u) => {
      links.push(link(full, t, u));
      return `\x00${links.length - 1}\x00`;
    });
    seg = seg.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    seg = seg.replace(/\x00(\d+)\x00/g, (_, index) => links[Number(index)]);
    out.push(seg);
  }
  return out.join("");
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const HR_RE = /^(---+|\*\*\*+|___+)$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;

function isBlockStart(line) {
  const s = line.trim();
  return s.startsWith("```") || s.startsWith(">")
    || HEAD_RE.test(line) || LIST_RE.test(line) || HR_RE.test(s);
}

function isOrdered(marker) {
  return /^\d+\./.test(marker);
}

function renderLi(content) {
  // One list item's inner HTML, with [ ]/[x] task-box support.
  const tm = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (tm) {
    const box = tm[1].toLowerCase() === "x" ? "☑ " : "☐ ";
    return box + inline(tm[2]);
  }
  return inline(content);
}

export function mdToHtml(md) {
  // Render a markdown body to Plane-friendly description_html.
  const lines = String(md).replace(/\x00/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.trim();

    if (s.startsWith("```")) {                                   // fenced code
      const lang = s.slice(3).trim();
      i += 1;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i += 1; }
      i += 1; // consume the closing fence (or fall off the end)
      const cls = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${cls}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (!s) { i += 1; continue; }                                 // blank line

    let m = HEAD_RE.exec(line);                                   // heading
    if (m) {
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2].trim())}</h${lvl}>`);
      i += 1; continue;
    }

    if (HR_RE.test(s)) { out.push("<hr>"); i += 1; continue; }     // horizontal rule

    if (s.startsWith(">")) {                                       // blockquote
      const buf = [];
      while (i < lines.length && lines[i].replace(/^\s+/, "").startsWith(">")) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    m = LIST_RE.exec(line);                                        // list (ul / ol, 1 nest level)
    if (m) {
      const base = m[1].length;
      const ordered = isOrdered(m[2]);
      const tag = ordered ? "ol" : "ul";
      const items = []; // [itemHtml, subHtmls, subOrdered]
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (!lm) break;
        const ind = lm[1].length;
        const lordered = isOrdered(lm[2]);
        if (ind > base && items.length) {                         // nested under previous item
          items[items.length - 1][1].push(renderLi(lm[3]));
          items[items.length - 1][2] = lordered;
        } else if (ind === base && lordered === ordered) {         // sibling
          items.push([renderLi(lm[3]), [], false]);
        } else {                                                   // dedent / kind switch → new block
          break;
        }
        i += 1;
      }
      const rendered = items.map(([itemHtml, subs, subOrdered]) => {
        let html = itemHtml;
        if (subs.length) {
          const stag = subOrdered ? "ol" : "ul";
          html += `<${stag}>${subs.map((sub) => `<li>${sub}</li>`).join("")}</${stag}>`;
        }
        return `<li>${html}</li>`;
      });
      out.push(`<${tag}>${rendered.join("")}</${tag}>`);
      continue;
    }

    const buf = [];                                                // paragraph
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i += 1; }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }

  return out.join("\n");
}

export const _internals = { esc, link, inline, renderLi };
