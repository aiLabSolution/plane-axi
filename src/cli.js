import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlaneApi } from "./api.js";
import { envConfig } from "./config.js";
import { AxiError, UsageError } from "./errors.js";
import { emit, emitError } from "./output.js";
import * as commands from "./commands/index.js";

const flag = (description, options = {}) => ({ description, ...options });
const projectFlag = flag("Project UUID, identifier, or exact name", { alias: "p" });

export const COMMAND_METADATA = {
  "project list": spec("List workspace projects", "plane-axi project list", commands.projectList, {}, [], ["plane-axi project list", "PLANE_WORKSPACE=team plane-axi project list"]),
  "project view": spec("Show a project", "plane-axi project view <ref>", commands.projectView, {}, ["ref"], ["plane-axi project view LABS", "plane-axi project view \"Lab Solutions\""]),
  "project create": spec("Create a project", "plane-axi project create --name <name> --identifier <id>", commands.projectCreate, {
    name: flag("Project name", { required: true }), identifier: flag("Short project identifier", { required: true }), description: flag("Project description")
  }, [], ["plane-axi project create --name \"Lab Solutions\" --identifier LABS", "plane-axi project create --name \"Client Portal\" --identifier PORTAL --description \"Customer work\""]),
  "use": spec("Select the directory-scoped default project", "plane-axi use <project>", commands.useProject, {}, ["project"], ["plane-axi use LABS", "plane-axi use \"Lab Solutions\""]),
  "me": spec("Show the authenticated Plane user", "plane-axi me", commands.me, {}, [], ["plane-axi me", "PLANE_WORKSPACE=team plane-axi me"]),
  "wi list": spec("List work items", "plane-axi wi list [flags]", commands.wiList, {
    project: projectFlag, state: flag("Filter by state UUID, name, or group"), priority: flag("Filter by urgent|high|medium|low|none"),
    assignee: flag("Filter by member UUID, name, or email"), limit: flag("Maximum rows", { default: "50" }),
    fields: flag("Comma-separated output fields"), all: flag("Return all matching rows", { boolean: true })
  }, [], ["plane-axi wi list", "plane-axi wi list --state completed --priority high", "plane-axi wi list --fields seq,title,assignee"]),
  "wi view": spec("Show a work item", "plane-axi wi view <ref> [--full]", commands.wiView, { project: projectFlag, full: flag("Show the complete body", { boolean: true }) }, ["ref"], ["plane-axi wi view LABS-42", "plane-axi wi view LABS-42 --full"]),
  "wi create": spec("Create a work item", "plane-axi wi create --title <title> [flags]", commands.wiCreate, {
    project: projectFlag, title: flag("Work item title", { required: true }), body: flag("Markdown body text", { allowEmpty: true }),
    "body-file": flag("Markdown body file, or '-' for stdin"), priority: flag("Priority enum"),
    state: flag("State UUID or name"), assignee: flag("Member UUID, name, or email"), label: flag("Label UUID or name"), parent: flag("Parent work item reference")
  }, [], ["plane-axi wi create --title \"Fix authentication\"", "plane-axi wi create --title \"Ship fix\" --priority high --state started", "plane-axi wi create --title \"PRD\" --body-file slice.md"]),
  "wi update": spec("Update a work item", "plane-axi wi update <ref> [flags]", commands.wiUpdate, {
    project: projectFlag, title: flag("New title"), body: flag("New markdown body text", { allowEmpty: true }),
    "body-file": flag("New markdown body file, or '-' for stdin"), priority: flag("New priority"), state: flag("New state UUID or name")
  }, ["ref"], ["plane-axi wi update LABS-42 --priority urgent", "plane-axi wi update LABS-42 --state completed", "plane-axi wi update LABS-42 --body-file slice.md"]),
  "wi assign": spec("Replace work item assignees", "plane-axi wi assign <ref> <member>...", commands.wiAssign, { project: projectFlag }, ["ref", "member..."], ["plane-axi wi assign LABS-42 alice@example.com", "plane-axi wi assign LABS-42 alice@example.com bob@example.com"]),
  "wi close": spec("Move a work item to the first completed state", "plane-axi wi close <ref>", commands.wiClose, { project: projectFlag }, ["ref"], ["plane-axi wi close LABS-42", "plane-axi wi close <uuid> --project LABS"]),
  "wi delete": spec("Delete a work item", "plane-axi wi delete <ref> --yes", commands.wiDelete, { project: projectFlag, yes: flag("Confirm deletion", { boolean: true }) }, ["ref"], ["plane-axi wi delete LABS-42 --yes", "plane-axi wi delete <uuid> --project LABS --yes"]),
  "wi search": spec("Search work items across the workspace", "plane-axi wi search <query> [--limit <n>|--all]", commands.wiSearch, {
    limit: flag("Maximum rows", { default: "50" }), all: flag("Return all matches", { boolean: true })
  }, ["query..."], ["plane-axi wi search authentication bug", "plane-axi wi search onboarding --all"]),
  "comment list": spec("List comments or all activity", "plane-axi comment list <wi-ref> [--all]", commands.commentList, { project: projectFlag, all: flag("Include all activity", { boolean: true }) }, ["wi-ref"], ["plane-axi comment list LABS-42", "plane-axi comment list LABS-42 --all"]),
  "comment add": spec("Add a comment", "plane-axi comment add <wi-ref> (--body <text>|--body-file <path|->)", commands.commentAdd, { project: projectFlag, body: flag("Markdown comment text"), "body-file": flag("Markdown comment file, or '-' for stdin") }, ["wi-ref"], ["plane-axi comment add LABS-42 --body \"Fixed in staging\"", "plane-axi comment add LABS-42 --body-file note.md", "cat note.md | plane-axi comment add LABS-42 --body-file -"]),
  "cycle list": spec("List project cycles", "plane-axi cycle list [--project <ref>]", commands.listNamed("cycles", "cycles"), { project: projectFlag }, [], ["plane-axi cycle list", "plane-axi cycle list --project LABS"]),
  "cycle view": spec("Show a cycle", "plane-axi cycle view <ref>", commands.viewNamed("cycles", "cycle"), { project: projectFlag }, ["ref"], ["plane-axi cycle view \"Sprint 12\"", "plane-axi cycle view <uuid> --project LABS"]),
  "cycle create": spec("Create a cycle", "plane-axi cycle create --name <name> [flags]", commands.createNamed("cycles", "cycle"), { project: projectFlag, name: flag("Cycle name", { required: true }), start: flag("Start date (YYYY-MM-DD)"), end: flag("End date (YYYY-MM-DD)") }, [], ["plane-axi cycle create --name \"Sprint 12\"", "plane-axi cycle create --name \"Sprint 12\" --start 2026-07-20 --end 2026-08-02"]),
  "module list": spec("List project modules", "plane-axi module list [--project <ref>]", commands.listNamed("modules", "modules"), { project: projectFlag }, [], ["plane-axi module list", "plane-axi module list --project LABS"]),
  "module view": spec("Show a module", "plane-axi module view <ref>", commands.viewNamed("modules", "module"), { project: projectFlag }, ["ref"], ["plane-axi module view Billing", "plane-axi module view <uuid> --project LABS"]),
  "module create": spec("Create a module", "plane-axi module create --name <name> [flags]", commands.createNamed("modules", "module"), { project: projectFlag, name: flag("Module name", { required: true }), start: flag("Start date (YYYY-MM-DD)"), end: flag("Target date (YYYY-MM-DD)"), description: flag("Description") }, [], ["plane-axi module create --name Billing", "plane-axi module create --name Billing --end 2026-09-01"]),
  "state list": spec("List project workflow states", "plane-axi state list [--project <ref>]", commands.stateList, { project: projectFlag }, [], ["plane-axi state list", "plane-axi state list --project LABS"]),
  "label list": spec("List project labels", "plane-axi label list [--project <ref>]", commands.labelList, { project: projectFlag }, [], ["plane-axi label list", "plane-axi label list --project LABS"]),
  "member list": spec("List workspace members", "plane-axi member list", commands.memberList, {}, [], ["plane-axi member list", "PLANE_WORKSPACE=team plane-axi member list"]),
  "render": spec("Render a markdown body to HTML (no network)", "plane-axi render (--body <text>|--body-file <path|->)", commands.render, {
    body: flag("Markdown body text", { allowEmpty: true }), "body-file": flag("Markdown body file, or '-' for stdin")
  }, [], ["plane-axi render --body \"Some **bold** text\"", "plane-axi render --body-file slice.md", "cat slice.md | plane-axi render --body-file -"]),
  "next": spec("List ready ∧ unclaimed work items, stage-ordered", "plane-axi next [--stage <s>] [--ready-state <name>]", commands.nextSlice, {
    project: projectFlag, stage: flag("Restrict to a stage, e.g. S2"), "ready-state": flag("Ready state name", { default: "ready-for-agent" }),
    "include-claimed": flag("Also show assigned items", { boolean: true }), limit: flag("Cap the number shown")
  }, [], ["plane-axi next", "plane-axi next --stage S2", "plane-axi next --limit 5"]),
  "claim": spec("Claim a work item (TTL'd advisory lock) and flag it taken", "plane-axi claim <ref> [--task <t>] [--ttl <min>] [--start]", commands.claim, {
    project: projectFlag, task: flag("Sub-task / files this claim covers"), ttl: flag("Claim lifetime in minutes", { default: "90" }),
    agent: flag("Agent identity (default: session id / host:pid)"), force: flag("Claim even if another agent holds a live claim (shared item)", { boolean: true }),
    start: flag("Also transition the item to 'In Progress'", { boolean: true }), "start-state": flag("Transition to this state instead of 'In Progress' (implies --start)"),
    "ready-state": flag("Expected ready state name", { default: "ready-for-agent" })
  }, ["ref"], ["plane-axi claim LABS-42 --task \"auth thread\"", "plane-axi claim LABS-42 --task \"...\" --start"]),
  "status": spec("Show claim ownership of a work item", "plane-axi status <ref>", commands.claimStatus, { project: projectFlag }, ["ref"], ["plane-axi status LABS-42"]),
  "heartbeat": spec("Extend your claim's TTL (task carries over)", "plane-axi heartbeat <ref> [--ttl <min>]", commands.heartbeat, {
    project: projectFlag, ttl: flag("Claim lifetime in minutes", { default: "90" }), agent: flag("Agent identity (default: session id / host:pid)")
  }, ["ref"], ["plane-axi heartbeat LABS-42", "plane-axi heartbeat LABS-42 --ttl 120"]),
  "release": spec("Release your claim (unassign if no other live claim remains)", "plane-axi release <ref>", commands.release, {
    project: projectFlag, agent: flag("Agent identity (default: session id / host:pid)"), "keep-assignee": flag("Release the claim but stay assigned", { boolean: true })
  }, ["ref"], ["plane-axi release LABS-42", "plane-axi release LABS-42 --keep-assignee"]),
  "api": spec("Call a Plane API path directly", "plane-axi api <METHOD> <path> [--input <json>]", commands.rawApi, { input: flag("JSON request body") }, ["METHOD", "path"], ["plane-axi api GET /users/me/", "plane-axi api POST /workspaces/example/projects/ --input '{\"name\":\"Test\"}'"]),
  "setup": spec("Install session hooks or the generated skill", "plane-axi setup [--app <app>] [--scope <scope>] [--skill]", commands.setup, {
    app: flag("claude|codex|opencode|all", { default: "all", choices: ["claude", "codex", "opencode", "all"] }),
    scope: flag("project|user", { default: "project", choices: ["project", "user"] }), skill: flag("Install the generated Agent Skill", { boolean: true })
  }, [], ["plane-axi setup", "plane-axi setup --app codex --scope user", "plane-axi setup --skill"]),
  "snapshot": spec("Print compact SessionStart context", "plane-axi snapshot", commands.snapshot, {}, [], ["plane-axi snapshot", "cd <repo> && plane-axi snapshot"])
};

function spec(description, usage, handler, flags, positionals, examples) {
  return { description, usage, handler, flags, positionals, examples };
}

const GROUPS = new Set(["project", "wi", "comment", "cycle", "module", "state", "label", "member"]);
const RENAMED = { status: "state", name: "title" };

function commandHelp(key, command) {
  return {
    command: key,
    description: command.description,
    usage: command.usage,
    flags: [
      ...Object.entries(command.flags).map(([name, meta]) => ({
        flag: `--${name}${meta.alias ? `, -${meta.alias}` : ""}`,
        required: Boolean(meta.required),
        description: `${meta.description}${meta.default ? ` [default: ${meta.default}]` : ""}`
      })),
      { flag: "--help", required: false, description: "Show this command reference" }
    ],
    examples: command.examples
  };
}

function topHelp() {
  return {
    bin: "plane-axi",
    description: "Manage Plane.so projects and work items from the current workspace",
    commands: Object.entries(COMMAND_METADATA).map(([name, meta]) => ({ command: name, description: meta.description })),
    help: ["Run `plane-axi <command> --help` for flags and examples"]
  };
}

function groupHelp(group) {
  const commands = Object.entries(COMMAND_METADATA).filter(([name]) => name.startsWith(`${group} `));
  return {
    bin: "plane-axi",
    group,
    commands: commands.map(([name, meta]) => ({ command: name, description: meta.description })),
    help: [`Run \`plane-axi ${group} <subcommand> --help\` for flags and examples`]
  };
}

function resolveCommand(args) {
  if (!args.length) return { key: null, rest: [] };
  if (args[0] === "--help" || args[0] === "-h") return { key: "--help", rest: [] };
  const isGroup = GROUPS.has(args[0]);
  const key = isGroup ? `${args[0]} ${args[1] || ""}`.trim() : args[0];
  const consumed = isGroup ? 2 : 1;
  if (!Object.hasOwn(COMMAND_METADATA, key)) {
    if (isGroup && args.some((token) => token === "--help" || token === "-h")) {
      return { key: "--group-help", rest: [], group: args[0] };
    }
    const candidates = Object.keys(COMMAND_METADATA).filter((name) => name.startsWith(`${args[0]} `));
    if (candidates.length) throw new UsageError(`missing or unknown subcommand for ${args[0]}`, `Valid commands: ${candidates.join(", ")}`);
    throw new UsageError(`unknown command ${args[0]}`, "Run `plane-axi --help` to see commands");
  }
  return { key, rest: args.slice(consumed) };
}

function parseFlags(key, command, args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true, flags: {}, positionals: [] };
  const flags = {};
  const positionals = [];
  const aliases = new Map(Object.entries(command.flags).filter(([, meta]) => meta.alias).map(([name, meta]) => [meta.alias, name]));
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.startsWith("-")) {
      const long = token.startsWith("--");
      const equal = long ? token.indexOf("=") : -1;
      let name = long ? token.slice(2, equal === -1 ? undefined : equal) : aliases.get(token.slice(1));
      if (!name || !Object.hasOwn(command.flags, name)) {
        const raw = long ? token.slice(2).split("=")[0] : token.slice(1);
        if (RENAMED[raw] && command.flags[RENAMED[raw]]) throw new UsageError(`--${raw} was renamed; use --${RENAMED[raw]} instead`);
        const valid = [...Object.keys(command.flags).map((entry) => `--${entry}`), "--help"].join(", ");
        throw new UsageError(`unknown flag ${token} for \`${key}\``, `Valid flags for \`${key}\`: ${valid}`);
      }
      const meta = command.flags[name];
      if (meta.boolean) {
        if (equal !== -1) throw new UsageError(`--${name} does not take a value`, `Use \`--${name}\``);
        flags[name] = true;
      }
      else {
        const value = equal === -1 ? args[++index] : token.slice(equal + 1);
        // A bare "-" is the conventional stdin marker (e.g. --body-file -), not a flag.
        if (value === undefined || (equal === -1 && value.startsWith("-") && value !== "-")) throw new UsageError(`--${name} requires a value`, `Run \`plane-axi ${key} --help\``);
        if (value === "" && !meta.allowEmpty) throw new UsageError(`--${name} requires a non-empty value`, `Run \`plane-axi ${key} --help\``);
        if (meta.choices && !meta.choices.includes(value)) throw new UsageError(`invalid --${name} value ${value}`, `Use one of: ${meta.choices.join(", ")}`);
        flags[name] = value;
      }
    } else positionals.push(token);
  }
  for (const [name, meta] of Object.entries(command.flags)) {
    if (meta.required && flags[name] === undefined) throw new UsageError(`--${name} is required`, `Run \`plane-axi ${key} --help\``);
  }
  const variadic = command.positionals.at(-1)?.endsWith("...");
  const minimum = command.positionals.filter((name) => !name.endsWith("...")).length + (variadic ? 1 : 0);
  if (positionals.length < minimum) throw new UsageError(`missing argument ${command.positionals[positionals.length]?.replace("...", "") || "value"}`, `Usage: ${command.usage}`);
  if (!variadic && positionals.length > command.positionals.length) throw new UsageError(`unexpected argument ${positionals[command.positionals.length]}`, `Usage: ${command.usage}`);
  return { flags, positionals, help: false };
}

export async function run(args, options = {}) {
  const { key, rest, group } = resolveCommand(args);
  if (key === "--help") return topHelp();
  if (key === "--group-help") return groupHelp(group);
  const api = options.api || new PlaneApi(options.config || envConfig(), options.fetch);
  const cwd = options.cwd || process.cwd();
  const executable = options.executable || path.resolve(process.argv[1] || fileURLToPath(new URL("../bin/plane-axi.js", import.meta.url)));
  if (key === null) return commands.home({ api, cwd, executable });
  const command = COMMAND_METADATA[key];
  const parsed = parseFlags(key, command, rest);
  if (parsed.help) return commandHelp(key, command);
  return command.handler({ api, cwd, executable, ...parsed });
}

export async function main(args, options = {}) {
  try {
    const result = await run(args, options);
    if (typeof result === "string") process.stdout.write(`${result}\n`);
    else if (result !== null && result !== undefined) emit(result);
    return 0;
  } catch (error) {
    const translated = error instanceof AxiError ? error : new AxiError(error?.message || "unexpected error");
    emitError(translated);
    return translated.exitCode;
  }
}

export const _internals = { parseFlags, resolveCommand, commandHelp, topHelp, groupHelp };
