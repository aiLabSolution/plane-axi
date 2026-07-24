import test from "node:test";
import assert from "node:assert/strict";
import { emitError, stripHtml, truncate } from "../src/output.js";
import { encode } from "../src/toon.js";

function captureStdout(fn) {
  let out = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return out;
}

test("stripHtml separates block-level elements and renders list bullets", () => {
  const html = "<h1>Title</h1><ul><li>First item</li><li>Second item</li></ul><p>Para</p>";
  assert.equal(stripHtml(html), "Title\n- First item\n- Second item\n\nPara");
});

test("stripHtml collapses runs of 3+ newlines produced by nested block closers", () => {
  assert.equal(stripHtml("<div><ul><li>A</li></ul></div><p>B</p>"), "- A\n\nB");
});

test("stripHtml does not turn <link>/<listing> tags into stray bullets", () => {
  assert.equal(stripHtml('<p>See <link href="style.css"> here</p>'), "See  here");
  assert.equal(stripHtml("<p>Old <listing>code</listing> tag</p>"), "Old code tag");
});

test("stripHtml still renders <li> tags with attributes as bullets", () => {
  assert.equal(stripHtml('<ul><li class="x">A</li><li id="y">B</li></ul>'), "- A\n- B");
});

test("stripHtml removes an unterminated trailing tag so no <script fragment survives", () => {
  assert.equal(stripHtml("Read the <script"), "Read the");
  assert.equal(stripHtml("<p>ok</p><script src=evil"), "ok");
  assert.doesNotMatch(stripHtml("hi <img src=x onerror=alert(1)"), /</);
});

test("stripHtml keeps stripping when tag removal would otherwise reconstruct a tag", () => {
  assert.doesNotMatch(stripHtml("<scr<span>ipt>x</scr<span>ipt>"), /<script/i);
});

test("stripHtml preserves legitimately escaped angle brackets as literal text", () => {
  assert.equal(stripHtml("<p>use &lt;script&gt; carefully</p>"), "use <script> carefully");
});

test("truncate backs the cut off by one unit when a surrogate pair straddles the limit", () => {
  const text = `${"a".repeat(999)}\u{1F600}${"b".repeat(50)}`;
  const result = truncate(text, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.total, text.length);
  assert.equal(result.text.startsWith("a".repeat(999)), true);
  assert.doesNotThrow(() => encode({ body: result.text }));
});

test("truncate does not touch the cut when it does not split a surrogate pair", () => {
  const text = "a".repeat(1005);
  const result = truncate(text, 1000);
  assert.equal(result.text.startsWith(`${"a".repeat(1000)}\n`), true);
});

test("emitError scrubs lone surrogates from the message and help", () => {
  const out = captureStdout(() => emitError({ message: "bad \ud800 body", help: ["see \udc00 detail"] }));
  assert.doesNotMatch(out, /[\ud800-\udfff]/);
  assert.match(out, /�/);
});

test("emitError never throws even for a hostile lone-surrogate-only message", () => {
  assert.doesNotThrow(() => captureStdout(() => emitError({ message: "\ud800\ud800" })));
});
