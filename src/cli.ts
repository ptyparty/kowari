#!/usr/bin/env bun
import { describeTable, listTables } from "./agent/catalog.ts";
import { defaultAgentLimits, type AgentResult } from "./agent/read-only.ts";
import { openAgentSession, type AgentSession } from "./agent/session.ts";
import { describeTarget, resolveConnections, type Resolution } from "./connections/resolve.ts";
import { formatRows, rowsAsJson } from "./format.ts";
import { guideCommand } from "./guide.ts";

const usage = `Usage:
  kowari                              Open the kowari TUI for this worktree (in a terminal; otherwise prints this)
  kowari connections                  List the connections for this worktree, and what Claude may do with each
  kowari query <connection> [sql|-]   Run one statement (from stdin when sql is - or missing)
  kowari tables <connection>          List tables and views
  kowari describe <connection> <table>
                                      Columns, constraints, indexes, and foreign keys pointing at a table
  kowari guide [page]                 Print a page of the guide for agents querying through kowari;
                                      index (the default) links to the rest
  kowari setup [--yes|--remove]       List kowari's skill and keyring deny rules in Claude Code's config,
                                      set up what is missing, or remove the skill

Options:
  -C <dir>          Run as if started in <dir> (picks the worktree, its .env and .kowari.toml)
  --json            Print JSON instead of text
  --max-rows <n>    Stop after n rows (default ${defaultAgentLimits.maxRows})

connections, query, tables and describe are for Claude: they obey each connection's agent level.
A connection Claude has no access to is refused, read-only connections
run through every read-only layer, and writes on approve-writes
connections are refused until the kowari TUI can approve them.

Connections come from ~/.config/kowari/connections.toml (yours, with the
grants) and .kowari.toml at the worktree root, filled in from its .env.`;

type Options = { cwd: string; json: boolean; maxRows: number; args: string[] };

class UsageError extends Error {}

await main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${usage}`);
      process.exit(2);
    }
    console.error(`kowari: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  const [command, ...rest] = options.args;

  switch (command) {
    case "connections":
      return listConnections(options, rest);
    case "query":
      return withSession(options, rest[0], async (session) => {
        const text = await statementText(rest.slice(1));
        return printResult(session.query(text), options);
      });
    case "tables":
      return withSession(options, rest[0], (session) => printResult(listTables(session.query), options));
    case "describe":
      if (!rest[1]) throw new UsageError("describe needs a table name");
      return withSession(options, rest[0], (session) => printDescription(session, rest[1]!, options));
    case undefined:
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(usage);
        return 0;
      }
      return (await import("./tui/main.ts")).runTui(options.cwd);
    case "guide":
      return guideCommand("kowari", rest);
    case "setup":
      return (await import("./claude/setup.ts")).setupCommand(rest);
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      return 0;
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

function parseOptions(argv: string[]): Options {
  const options: Options = { cwd: process.cwd(), json: false, maxRows: defaultAgentLimits.maxRows, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") options.json = true;
    else if (arg === "-C") options.cwd = required(argv[++i], "-C needs a directory");
    else if (arg === "--max-rows") {
      const n = Number(required(argv[++i], "--max-rows needs a number"));
      if (!Number.isInteger(n) || n <= 0) throw new UsageError("--max-rows needs a positive whole number");
      options.maxRows = n;
    } else options.args.push(arg);
  }
  return options;
}

function required(value: string | undefined, message: string): string {
  if (value === undefined) throw new UsageError(message);
  return value;
}

async function listConnections(options: Options, rest: string[]): Promise<number> {
  if (rest.length > 0) throw new UsageError("connections takes no arguments");
  const resolution = await resolveConnections({ cwd: options.cwd });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          worktree: resolution.worktree.root,
          repo: resolution.worktree.identity,
          connections: resolution.connections.map((c) => ({
            name: c.name,
            source: c.source,
            agent: c.agent,
            agentNote: c.agentNote,
            target: describeTarget(c),
          })),
          problems: resolution.problems,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`worktree ${resolution.worktree.root}${resolution.worktree.identity ? ` (${resolution.worktree.identity})` : ""}`);
  if (resolution.connections.length === 0) console.log("no connections defined");
  for (const c of resolution.connections) {
    console.log(`${c.name}  [${c.agent}]  ${describeTarget(c)}  from ${c.source === "user" ? "your config" : ".kowari.toml"}`);
    if (c.agentNote) console.log(`  note: ${c.agentNote}`);
  }
  printProblems(resolution);
  return 0;
}

function printProblems(resolution: Resolution): void {
  for (const problem of resolution.problems) console.error(`warning: ${problem}`);
}

async function withSession(
  options: Options,
  name: string | undefined,
  run: (session: AgentSession) => Promise<number>,
): Promise<number> {
  if (!name) throw new UsageError("which connection? (kowari connections lists them)");
  const resolution = await resolveConnections({ cwd: options.cwd });
  const connection = resolution.connections.find((c) => c.name === name);
  if (!connection) {
    const known = resolution.connections.map((c) => c.name).join(", ") || "none";
    console.error(`kowari: no connection named ${name} in this worktree (known: ${known})`);
    return 1;
  }

  let outcome;
  try {
    outcome = await openAgentSession(connection, { ...defaultAgentLimits, maxRows: options.maxRows });
  } catch (e) {
    console.error(`kowari: could not connect to ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (outcome.kind === "refused") {
    console.error(`kowari: refused: ${outcome.reason}`);
    return 1;
  }

  try {
    return await run(outcome.session);
  } finally {
    await outcome.session.close();
  }
}

async function statementText(args: string[]): Promise<string> {
  if (args.length > 1) throw new UsageError("quote the statement as one argument, or pass - and send it on stdin");
  const text = args[0] === undefined || args[0] === "-" ? await Bun.stdin.text() : args[0];
  if (text.trim() === "") throw new UsageError("no statement given");
  return text;
}

async function printResult(pending: Promise<AgentResult>, options: Options): Promise<number> {
  const result = await pending;
  if (result.kind !== "rows") return printFailure(result);
  console.log(options.json ? JSON.stringify(rowsAsJson(result)) : formatRows(result));
  return 0;
}

function printFailure(result: Exclude<AgentResult, { kind: "rows" }>): number {
  console.error(result.kind === "refused" ? `kowari: refused: ${result.reason}` : `kowari: error: ${result.message}`);
  return 1;
}

async function printDescription(session: AgentSession, table: string, options: Options): Promise<number> {
  const description = await describeTable(session.query, table);
  if ("kind" in description) return printFailure(description as Exclude<AgentResult, { kind: "rows" }>);
  if ("missing" in description) {
    console.error(`kowari: no table or view named ${description.missing}`);
    return 1;
  }

  const failed = description.find((s) => s.result.kind !== "rows");
  if (failed) return printFailure(failed.result as Exclude<AgentResult, { kind: "rows" }>);

  if (options.json) {
    const sections = Object.fromEntries(
      description.map((s) => [s.title, s.result.kind === "rows" ? rowsAsJson(s.result) : null]),
    );
    console.log(JSON.stringify({ table, ...sections }));
    return 0;
  }

  const blocks = description.map((s) => `## ${s.title}\n${s.result.kind === "rows" ? formatRows(s.result) : ""}`);
  console.log(`# ${table}\n\n${blocks.join("\n\n")}`);
  return 0;
}
