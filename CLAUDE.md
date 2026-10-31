Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/agent/gate.ts`: parses a statement with libpg-query and refuses anything that is not one read-only statement.
- `src/agent/role-check.ts`: lists what the connected role could use to change the database; any problem refuses the connection to Claude.
- `src/agent/read-only.ts`: opens an agent read-only connection and runs each statement through the gate, a read-only transaction that always rolls back, and the row and byte caps.
- `src/cli.ts`: the `kowari` CLI Claude uses (`connections`, `query`, `tables`, `describe`); every command obeys the connection's agent level.
- `src/agent/session.ts`: opens a connection for Claude according to its agent level; `catalog.ts` has the table listing and description queries.
- `src/format.ts`: text and JSON output for results.
- `src/connections/`: resolves the connection list for a worktree from your config, the repo's `.kowari.toml`, and the worktree's `.env`, including what Claude may do with each.
- `skills/kowari/`: the agent skill.
- `test/cli.test.ts`: runs the CLI end to end from a scratch git repo against a fixture database.
- `test/escape/`: the escape suite, its vectors, and the fixture that builds a database per test from a template.
- `spike/`: the driver comparison and the per-layer escape matrix, kept to re-run when Bun, postgres.js or Postgres changes.

## Testing

- Tests need the Postgres from `scripts/test-db` running (127.0.0.1:55433). Set `KOWARI_TEST_DATABASE_URL` to use another.
- postgres.js runs `sql.unsafe(text)` without parameters on the simple protocol, which accepts many statements. Anything that runs agent SQL passes `{ simple: false }`.
