---
name: kowari
description: Queries the PostgreSQL databases of the current worktree through the `kowari` CLI, which enforces what Claude may do on each connection (none, read-only, approve-writes, write). Use whenever you need to look at or change data in a project's Postgres database — run a SELECT, list tables, describe a table's columns, constraints, indexes and foreign keys, check what a migration did, or find rows behind a bug — and when the user mentions kowari, a database connection, or a repo's `.kowari.toml`. Use it instead of psql or credentials read from `.env`.
---

# Querying Postgres with kowari

kowari carries its own guide. Start by reading its index:

```bash
kowari guide index
```

The index links to the other pages; `kowari guide <page>` prints one. Read the pages your task needs as you reach them.
