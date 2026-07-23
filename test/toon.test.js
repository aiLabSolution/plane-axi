import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "../src/toon.js";

test("encodes a uniform object array as a TOON table", () => {
  assert.equal(encode({ tasks: [
    { id: 1, title: "Fix auth", status: "open" },
    { id: 2, title: "Ship docs", status: "closed" }
  ] }), "tasks[2]{id,title,status}:\n  1,Fix auth,open\n  2,Ship docs,closed");
});

test("quotes ambiguous strings and escapes the normative control set", () => {
  assert.equal(encode({
    empty: "", numeric: "05", truthy: "true", colon: "a:b", comma: "a,b",
    control: "line\nnext\tend", hyphen: "-draft"
  }), 'empty: ""\nnumeric: "05"\ntruthy: "true"\ncolon: "a:b"\ncomma: "a,b"\ncontrol: "line\\nnext\\tend"\nhyphen: "-draft"');
});

test("encodes primitive, mixed, nested, and empty arrays", () => {
  assert.equal(encode({ values: [1, 2], empty: [], mixed: [1, { a: 2 }], nested: [[1, 2], [3]] }),
    "values[2]: 1,2\nempty: []\nmixed[2]:\n  - 1\n  - a: 2\nnested[2]:\n  - [2]: 1,2\n  - [1]: 3");
});

test("normalizes numbers and JavaScript host types", () => {
  assert.equal(encode({ negativeZero: -0, millionth: 1e-6, tiny: 1e-7, invalid: Infinity, emoji: "👋" }),
    "negativeZero: 0\nmillionth: 0.000001\ntiny: 1e-7\ninvalid: null\nemoji: 👋");
});

test("uses no trailing newline", () => assert.equal(encode({ ok: true }).endsWith("\n"), false));

test("rejects lone surrogate strings", () => assert.throws(() => encode({ bad: "\ud800" }), /lone surrogate/));

test("a non-tabular array in a list item's first field indents its children beyond sibling fields", () => {
  const result = encode({ items: [{ tags: [1, { extra: true }], name: "A" }] });
  assert.equal(result, "items[1]:\n  - tags[2]:\n      - 1\n      - extra: true\n    name: A");
});
