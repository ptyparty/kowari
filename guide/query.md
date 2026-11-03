# Running queries

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
- Exit status 0 means success, 1 a refusal or SQL error (the reason is on stderr), 2 a usage mistake. On a refusal, read [When kowari refuses](refusals.md).
