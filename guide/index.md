# Querying Postgres with kowari

kowari resolves the connections for the worktree you run it in: the repo's `.kowari.toml`, filled in from that worktree's `.env`, plus the shared databases in the user's own config. The user decides, per connection, what you may do with it. Go through kowari rather than `psql` or the credentials in `.env`, so those decisions hold.

This guide is split into pages. Each link below names one: `kowari guide query` prints `query.md`. Read the pages the task needs, not all of them.

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

## Pages

- [Running queries](query.md): `kowari query`, `tables` and `describe`, the row cap, output formats and exit statuses.
- [When kowari refuses](refusals.md): what each refusal means and what to tell the user. Read it whenever a command is refused, before trying anything else.
