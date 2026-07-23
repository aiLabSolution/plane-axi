import { mdToHtml } from "../markdown.js";
import { readBody, requireOne } from "./common.js";

// Returns the rendered HTML as a plain string (not an object) — main() prints string
// results raw instead of TOON-encoding them, so this previews exactly what description_html
// / comment_html would be.
export async function render({ flags }) {
  const selected = requireOne(flags, ["body", "body-file"], "render requires --body or --body-file");
  const raw = selected === "body" ? flags.body : await readBody(flags["body-file"]);
  // Trim to match the send paths (wi create/update, comment add all render raw.trim()), so
  // a preview is byte-for-byte what would actually be sent.
  return mdToHtml(raw.trim());
}
