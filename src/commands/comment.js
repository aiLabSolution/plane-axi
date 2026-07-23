import { readFile } from "node:fs/promises";
import { findProjectConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { htmlParagraph, stripHtml, withHelp } from "../output.js";
import { resolveWorkItem } from "../resolve.js";
import { projectPath, requireOne } from "./common.js";

async function context({ api, flags, positionals, cwd }) {
  const projectHint = flags.project || (await findProjectConfig(cwd))?.project;
  return resolveWorkItem(api, positionals[0], projectHint);
}

export async function commentList(ctx) {
  const { api, flags } = ctx;
  const { project, item } = await context(ctx);
  const suffix = flags.all ? "activities" : "comments";
  const { results, total } = await api.all(`${projectPath(api, project, "/work-items/")}${item.id}/${suffix}/`);
  const comments = flags.all ? results : results.filter((entry) => !entry.field || entry.field === "comment");
  if (!comments.length) return { comments: `0 ${flags.all ? "activities" : "comments"} on ${project.identifier}-${item.sequence_id}` };
  return { count: `${comments.length} of ${total} total`, work_item: `${project.identifier}-${item.sequence_id}`, comments: comments.map((entry) => ({
    author: entry.actor_detail?.display_name || entry.created_by_detail?.display_name || entry.actor || entry.created_by || "unknown",
    body: stripHtml(entry.comment_html || entry.comment || entry.new_value || ""),
    created_at: entry.created_at || ""
  })) };
}

export async function commentAdd(ctx) {
  const { api, flags } = ctx;
  const selected = requireOne(flags, ["body", "body-file"], "comment requires --body or --body-file");
  const body = selected === "body" ? flags.body : await readFile(flags["body-file"], "utf8").catch(() => {
    throw new UsageError(`cannot read body file ${flags["body-file"]}`, "Check that the path exists and is readable");
  });
  const { project, item } = await context(ctx);
  const created = await api.post(`${projectPath(api, project, "/work-items/")}${item.id}/comments/`, { comment_html: htmlParagraph(body) });
  return withHelp({ comment: { id: created?.id || null, work_item: `${project.identifier}-${item.sequence_id}` }, result: "added" }, [
    `Run \`plane-axi comment list ${project.identifier}-${item.sequence_id}\` to verify`
  ]);
}
