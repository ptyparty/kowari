---
name: kowari
description: Queries the PostgreSQL databases of the current worktree through the `kowari` CLI, which enforces what Claude may do on each connection (none, read-only, approve-writes, write). Use whenever you need to look at or change data in a project's Postgres database — run a SELECT, list tables, describe a table's columns, constraints, indexes and foreign keys, check what a migration did, or find rows behind a bug — and when the user mentions kowari, a database connection, or a repo's `.kowari.toml`. Use it instead of psql or credentials read from `.env`.
---

# Querying Postgres with kowari

kowari resolves the connections for the worktree you run it in: the repo's `.kowari.toml`, filled in from that worktree's `.env`, plus the shared databases in the user's own config. The user decides, per connection, what you may do with it. Go through kowari rather than `psql` or the credentials in `.env`, so those decisions hold.

## Find the connection

```bash
kowari connections
```

Each line shows a name, your level in brackets, and where it points. Pick the connection by what the task needs: a `read-only` one for anything that only reads, since it cannot change data by accident. Only use a `write` connection when the task is to change data.

| Level | What happens |
|---|---|
| `none` | Every command is refused. Ask the user for access if you need it; you cannot grant it yourself. |
| `read-only` | One read-only statement per call, run in a transaction that is always rolled back. |
| `approve-writes` | Reads run; writes are refused until the user can approve them in the kowari TUI. |
| `write` | Statements run as sent and commit. |

## Run queries

```bash
kowari query local-ro "select id, status from shipment where created_at > now() - interval '1 day'"
kowari query local-ro - <<'SQL'
select ...
SQL
kowari tables local-ro
kowari describe local-ro public.shipment
```

- One statement per call. A string with several is refused, so split them.
- Results stop at 500 rows (`--max-rows N` to change it) and say so in the last line. Add a `LIMIT` or an aggregate rather than raising the cap: wide results cost context.
- Text output is aligned, with `NULL` for nulls and `\n` for newlines inside a value; `--json` gives the column types (Postgres type OIDs) and the values as JSON.
- `-C <dir>` runs against another worktree's connections.
- Exit status 0 means success, 1 a refusal or SQL error (the reason is on stderr), 2 a usage mistake.

## When kowari refuses

The message says why. Do not work around it with `psql`, `.env` credentials, or editing `.kowari.toml` or the user's kowari config: those refusals are the user's decisions.

- "Claude has no access to X": the user has not granted it. Tell them which connection you need and why.
- "X is marked read-only, but its role ... could change the database": the role behind that connection has write privileges, so kowari will not let you use it as read-only. Tell the user; the fix is in the database's grants.
- "... is not allowed on a read-only connection": your statement writes, locks, or calls a function with side effects. Rewrite it as a plain read, or ask for a writable connection.
- "X is unavailable: VAR not set": the worktree's `.env` is missing a variable. Often the worktree's stack has not been bootstrapped yet.
