const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC_LIKE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

function normalize(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toJSON();
  if (value instanceof Set) return [...value].map(normalize);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), normalize(v)]));
  if (value && typeof value.toJSON === "function") return normalize(value.toJSON());
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function escapeString(value) {
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === "\\") output += "\\\\";
    else if (char === '"') output += '\\"';
    else if (char === "\n") output += "\\n";
    else if (char === "\r") output += "\\r";
    else if (char === "\t") output += "\\t";
    else if (code <= 0x1f) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new TypeError("TOON cannot encode a lone surrogate");
    else output += char;
  }
  return output;
}

function assertUnicodeScalars(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new TypeError("TOON cannot encode a lone surrogate");
  }
}

function encodeKey(value) {
  const key = String(value);
  return SAFE_KEY.test(key) ? key : `"${escapeString(key)}"`;
}

function encodeNumber(value) {
  if (!Number.isFinite(value)) return "null";
  if (Object.is(value, -0)) return "0";
  const absolute = Math.abs(value);
  if (value === 0 || (absolute >= 1e-6 && absolute < 1e21)) {
    const raw = String(value);
    if (!/[eE]/.test(raw)) return raw;
    const [mantissa, exponentText] = raw.toLowerCase().split("e");
    const exponent = Number(exponentText);
    const negative = mantissa.startsWith("-");
    const digits = mantissa.replace("-", "").replace(".", "");
    const dot = mantissa.replace("-", "").indexOf(".");
    const decimalPosition = (dot === -1 ? digits.length : dot) + exponent;
    const plain = decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
    return `${negative ? "-" : ""}${plain}`;
  }
  return String(value).replace("E", "e").replace(/e(-?)(\d+)$/, (_, minus, n) => `e${minus || "+"}${n}`);
}

function needsQuote(value, delimiter) {
  return value.length === 0
    || value.trim() !== value
    || value === "true" || value === "false" || value === "null"
    || NUMERIC_LIKE.test(value)
    || /[:"\\[\]{}]/.test(value)
    || /[\u0000-\u001f]/.test(value)
    || value.includes(delimiter)
    || value.startsWith("-");
}

function encodePrimitive(value, delimiter = ",") {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return encodeNumber(value);
  const string = String(value);
  assertUnicodeScalars(string);
  return needsQuote(string, delimiter) ? `"${escapeString(string)}"` : string;
}

function isPrimitive(value) {
  return value === null || !["object", "function"].includes(typeof value);
}

function tabularFields(array) {
  if (!array.length || array.some((item) => !item || Array.isArray(item) || typeof item !== "object")) return null;
  const fields = Object.keys(array[0]);
  if (!fields.length) return null;
  const expected = new Set(fields);
  for (const item of array) {
    const keys = Object.keys(item);
    if (keys.length !== fields.length || keys.some((key) => !expected.has(key))) return null;
    if (keys.some((key) => !isPrimitive(item[key]))) return null;
  }
  return fields;
}

function arrayHeader(key, length, delimiter, fields) {
  const marker = delimiter === "," ? "" : delimiter;
  const prefix = key === null ? "" : encodeKey(key);
  const columns = fields ? `{${fields.map(encodeKey).join(delimiter)}}` : "";
  return `${prefix}[${length}${marker}]${columns}:`;
}

function encodeArray(array, key, depth, options, lines, listPrefix = "") {
  const indent = " ".repeat(depth * options.indentSize);
  if (array.length === 0 && !listPrefix) {
    lines.push(key === null ? "[]" : `${indent}${encodeKey(key)}: []`);
    return;
  }
  if (array.every(isPrimitive)) {
    const values = array.map((value) => encodePrimitive(value, options.delimiter)).join(options.delimiter);
    lines.push(`${indent}${listPrefix}${arrayHeader(key, array.length, options.delimiter)}${values ? ` ${values}` : ""}`);
    return;
  }
  const fields = tabularFields(array);
  if (fields && !listPrefix) {
    lines.push(`${indent}${arrayHeader(key, array.length, options.delimiter, fields)}`);
    for (const item of array) {
      lines.push(`${" ".repeat((depth + 1) * options.indentSize)}${fields.map((field) => encodePrimitive(item[field], options.delimiter)).join(options.delimiter)}`);
    }
    return;
  }
  lines.push(`${indent}${listPrefix}${arrayHeader(key, array.length, options.delimiter)}`);
  for (const item of array) encodeListItem(item, depth + 1, options, lines);
}

function encodeListItem(value, depth, options, lines) {
  const indent = " ".repeat(depth * options.indentSize);
  if (isPrimitive(value)) {
    lines.push(`${indent}- ${encodePrimitive(value, options.delimiter)}`);
  } else if (Array.isArray(value)) {
    if (value.every(isPrimitive)) {
      const header = arrayHeader(null, value.length, options.delimiter);
      const values = value.map((item) => encodePrimitive(item, options.delimiter)).join(options.delimiter);
      lines.push(`${indent}- ${header}${values ? ` ${values}` : ""}`);
    } else {
      lines.push(`${indent}- ${arrayHeader(null, value.length, options.delimiter)}`);
      for (const item of value) encodeListItem(item, depth + 1, options, lines);
    }
  } else {
    const entries = Object.entries(value);
    if (!entries.length) {
      lines.push(`${indent}-`);
      return;
    }
    const [firstKey, firstValue] = entries[0];
    if (isPrimitive(firstValue)) {
      lines.push(`${indent}- ${encodeKey(firstKey)}: ${encodePrimitive(firstValue, options.delimiter)}`);
    } else if (Array.isArray(firstValue) && tabularFields(firstValue)) {
      const fields = tabularFields(firstValue);
      lines.push(`${indent}- ${arrayHeader(firstKey, firstValue.length, options.delimiter, fields)}`);
      for (const item of firstValue) {
        lines.push(`${" ".repeat((depth + 2) * options.indentSize)}${fields.map((field) => encodePrimitive(item[field], options.delimiter)).join(options.delimiter)}`);
      }
    } else if (Array.isArray(firstValue)) {
      if (firstValue.every(isPrimitive)) {
        encodeArray(firstValue, firstKey, depth, options, lines, "- ");
      } else {
        lines.push(`${indent}- ${arrayHeader(firstKey, firstValue.length, options.delimiter)}`);
        for (const item of firstValue) encodeListItem(item, depth + 2, options, lines);
      }
    } else {
      lines.push(`${indent}- ${encodeKey(firstKey)}:`);
      encodeObject(firstValue, depth + 2, options, lines);
    }
    for (const [key, item] of entries.slice(1)) encodeField(key, item, depth + 1, options, lines);
  }
}

function encodeField(key, value, depth, options, lines) {
  const indent = " ".repeat(depth * options.indentSize);
  if (isPrimitive(value)) lines.push(`${indent}${encodeKey(key)}: ${encodePrimitive(value, options.delimiter)}`);
  else if (Array.isArray(value)) encodeArray(value, key, depth, options, lines);
  else {
    lines.push(`${indent}${encodeKey(key)}:`);
    encodeObject(value, depth + 1, options, lines);
  }
}

function encodeObject(object, depth, options, lines) {
  for (const [key, value] of Object.entries(object)) encodeField(key, value, depth, options, lines);
}

export function encode(value, { indentSize = 2, delimiter = "," } = {}) {
  if (![",", "\t", "|"].includes(delimiter)) throw new TypeError("delimiter must be comma, tab, or pipe");
  const normalized = normalize(value);
  const options = { indentSize, delimiter };
  const lines = [];
  if (Array.isArray(normalized)) encodeArray(normalized, null, 0, options, lines);
  else if (normalized && typeof normalized === "object") encodeObject(normalized, 0, options, lines);
  else lines.push(encodePrimitive(normalized, delimiter));
  return lines.join("\n");
}

export const _internals = { encodeKey, encodePrimitive, encodeNumber, needsQuote, normalize, tabularFields };
