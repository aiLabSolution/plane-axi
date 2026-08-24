import { UsageError } from "../errors.js";
import { mdToHtml } from "../markdown.js";
import { stripHtml, withHelp } from "../output.js";
import { currentWorkItem, projectPath, readBody, requireOne } from "./common.js";

async function context({ api, flags, positionals, cwd }) {
  return currentWorkItem(api, flags, cwd, positionals[0]);
}

const renderEntry = (entry) => ({
  author: entry.actor_detail?.display_name || entry.created_by_detail?.display_name || entry.actor || entry.created_by || "unknown",
  body: stripHtml(entry.comment_html || entry.comment || entry.new_value || ""),
  created_at: entry.created_at || ""
});

export async function commentList(ctx) {
  const { api, flags } = ctx;
  const { project, item } = await context(ctx);
  const ref = `${project.identifier}-${item.sequence_id}`;
  const base = `${projectPath(api, project, "/work-items/")}${item.id}`;
  const commentPage = await api.all(`${base}/comments/`);
  const comments = commentPage.results.filter((entry) => !entry.field || entry.field === "comment");
  if (!flags.all) {
    if (!comments.length) return { comments: `0 comments on ${ref}` };
    return { count: `${comments.length} of ${commentPage.total} total`, work_item: ref, comments: comments.map(renderEntry) };
  }
  const activityPage = await api.all(`${base}/activities/`);
  if (!comments.length && !activityPage.results.length) return { comments: `0 comments and 0 activities on ${ref}` };
  return {
    count: `${comments.length} of ${commentPage.total} total`,
    work_item: ref,
    comments: comments.map(renderEntry),
    activity_count: `${activityPage.results.length} of ${activityPage.total} total`,
    activities: activityPage.results.map(renderEntry)
  };
}

export async function commentAdd(ctx) {
  const { api, flags } = ctx;
  const selected = requireOne(flags, ["body", "body-file"], "comment requires --body or --body-file");
  const raw = selected === "body" ? flags.body : await readBody(flags["body-file"]);
  const html = mdToHtml(raw.trim());
  if (!html) throw new UsageError("empty comment body");
  const { project, item } = await context(ctx);
  const created = await api.post(`${projectPath(api, project, "/work-items/")}${item.id}/comments/`, { comment_html: html });
  return withHelp({ comment: { id: created?.id || null, work_item: `${project.identifier}-${item.sequence_id}` }, result: "added" }, [
    `Run \`plane-axi comment list ${project.identifier}-${item.sequence_id}\` to verify`
  ]);
}
