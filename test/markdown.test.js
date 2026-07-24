// Ported 1:1 from lis-control/scripts/test_plane_issue.py (TestInline/TestBlocks/
// TestPrdTemplate) — same expected strings, since behavior parity with the Python
// renderer is the point of this module.
import test from "node:test";
import assert from "node:assert/strict";
import { mdToHtml, _internals } from "../src/markdown.js";

const { inline } = _internals;

// --------------------------------------------------------------------------- TestInline
test("inline escapes text metachars", () => {
  assert.equal(inline("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("inline renders bold", () => {
  assert.equal(inline("a **bold** b"), "a <strong>bold</strong> b");
});

test("inline code is escaped and not styled", () => {
  // markup inside a code span must be escaped and left untouched by bold/link passes
  assert.equal(inline("use `a < b && **x**`"), "use <code>a &lt; b &amp;&amp; **x**</code>");
});

test("inline link allowed scheme", () => {
  assert.equal(inline("see [docs](https://x.test/a)"), 'see <a href="https://x.test/a">docs</a>');
});

test("inline link rejects javascript scheme", () => {
  // unsafe scheme → render the literal markdown, never an <a>
  const out = inline("[x](javascript:alert(1))");
  assert.doesNotMatch(out, /<a/);
  assert.match(out, /\[x\]\(javascript:alert\(1\)\)/);
});

test("inline link relative and anchor ok", () => {
  assert.match(inline("[d](/docs)"), /<a href="\/docs">/);
  assert.match(inline("[s](#sec)"), /<a href="#sec">/);
});

test("inline link rejects protocol relative", () => {
  // //host is an off-site/open-redirect href the allowlist must not wave through
  const out = inline("[x](//evil.example/login)");
  assert.doesNotMatch(out, /<a/);
  assert.match(out, /\[x\]\(\/\/evil\.example\/login\)/);
});

test("inline bold does not corrupt link url", () => {
  // ** inside a URL must not be rewritten into the href by the bold pass
  const out = inline("[x](https://a.test/**b**/c)");
  assert.match(out, /href="https:\/\/a\.test\/\*\*b\*\*\/c"/);
  assert.doesNotMatch(out, /<strong>/);
});

test("inline quote is escaped", () => {
  assert.equal(inline('say "hi"'), "say &quot;hi&quot;");
});

// --------------------------------------------------------------------------- TestBlocks
test("blocks render headings", () => {
  assert.equal(mdToHtml("## What to build"), "<h2>What to build</h2>");
  assert.equal(mdToHtml("###### deep"), "<h6>deep</h6>");
});

test("blocks paragraph preserves linebreaks", () => {
  assert.equal(mdToHtml("line one\nline two"), "<p>line one<br>line two</p>");
});

test("blocks blank line splits paragraphs", () => {
  assert.equal(mdToHtml("a\n\nb"), "<p>a</p>\n<p>b</p>");
});

test("blocks unordered list", () => {
  assert.equal(mdToHtml("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
});

test("blocks ordered list", () => {
  assert.equal(mdToHtml("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
});

test("blocks task items", () => {
  const html = mdToHtml("- [ ] todo\n- [x] done");
  assert.equal(html, "<ul><li>☐ todo</li><li>☑ done</li></ul>");
});

test("blocks nested unordered list", () => {
  const html = mdToHtml("- top\n  - sub a\n  - sub b\n- next");
  assert.equal(html, "<ul><li>top<ul><li>sub a</li><li>sub b</li></ul></li>"
    + "<li>next</li></ul>");
});

test("blocks nested ordered under unordered", () => {
  const html = mdToHtml("- top\n  1. first\n  2. second");
  assert.equal(html, "<ul><li>top<ol><li>first</li><li>second</li></ol></li></ul>");
});

test("blocks nested task items", () => {
  const html = mdToHtml("- AC\n  - [ ] sub-check");
  assert.match(html, /<li>AC<ul><li>☐ sub-check<\/li><\/ul><\/li>/);
});

test("blocks list kind switch starts new list", () => {
  const html = mdToHtml("- a\n1. b");
  assert.equal(html, "<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
});

test("blocks fenced code block escaped no inline", () => {
  const html = mdToHtml("```\n<tag> **not bold** `not code`\n```");
  assert.match(html, /<pre><code>/);
  assert.match(html, /&lt;tag&gt; \*\*not bold\*\* `not code`/);
  assert.doesNotMatch(html, /<strong>/);
});

test("blocks fenced code language class", () => {
  assert.match(mdToHtml("```python\nx=1\n```"), /<code class="language-python">/);
});

test("blocks fenced code language attr breakout is escaped", () => {
  // a crafted ```lang info-string must not break out of the class="..." attribute
  const html = mdToHtml('```js" onmouseover="alert(1)\nx\n```');
  assert.doesNotMatch(html, /onmouseover="alert\(1\)"/);
  assert.match(html, /&quot;/);
  // the only literal double-quotes left are the attribute delimiters themselves
  assert.equal((html.match(/"/g) || []).length, 2);
});

test("blocks horizontal rule", () => {
  assert.equal(mdToHtml("---"), "<hr>");
});

test("blocks blockquote", () => {
  assert.equal(mdToHtml("> a\n> b"), "<blockquote>a<br>b</blockquote>");
});

test("blocks heading breaks paragraph", () => {
  assert.equal(mdToHtml("text\n## H"), "<p>text</p>\n<h2>H</h2>");
});

test("blocks no raw html injection", () => {
  // a literal <script> in body text must be escaped, never emitted as a tag: assert the exact
  // escaped output rather than the absence of one substring (a stronger check, and no filtering
  // regex for CodeQL's js/bad-tag-filter to mistake for a sanitizer).
  assert.equal(mdToHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

// --------------------------------------------------------------------------- TestPrdTemplate
const PRD_BODY = "## Parent\n\nLIS-22\n\n"
  + "## What to build\n\n"
  + "An end-to-end ERBA EC90 channel that ingests `ASTM E1381` frames.\n"
  + "See [the spec](https://example.test/astm).\n\n"
  + "## Acceptance criteria\n\n"
  + "- [ ] Frames parse\n  - [ ] checksums verified\n- [ ] Results normalize\n"
  + "- [x] Already done\n\n"
  + "## Blocked by\n\n- None - can start immediately\n";

test("prd template renders expected structure", () => {
  const html = mdToHtml(PRD_BODY);
  for (const frag of [
    "<h2>Parent</h2>", "<h2>What to build</h2>",
    "<code>ASTM E1381</code>", '<a href="https://example.test/astm">',
    "<li>☐ Frames parse<ul><li>☐ checksums verified</li></ul></li>",
    "<li>☑ Already done</li>", "<h2>Blocked by</h2>"
  ]) assert.match(html, new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("prd template round-trips without raising", () => {
  assert.ok(mdToHtml(PRD_BODY));
});
