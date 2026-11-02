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
- `src/sql/`: Postgres's scanner (from libpg-query) as tokens with character offsets, statement splitting on the semicolons it sees, the catalog read on connect, and completion (`complete.ts`, a pure function of text, cursor and catalog).
- `src/tui/`: the TUI (`kowari` with no arguments): connection screen, workspace, result grid, the human's database session.
- `src/format.ts`: text and JSON output for results.
- `src/connections/keyring.ts`: passwords in the system keyring (`Bun.secrets`), with a D-Bus lock check so kowari never sets off an unlock prompt; `memoryKeyring` for tests.
- `src/claude/deny.ts`: checks and adds the Claude Code deny rules that keep keyring tools away from Claude.
- `src/claude/setup.ts`: `kowari setup`, which links the skill into Claude Code's config and adds the deny rules; `links.ts` is copied from komux.
- `src/connections/`: resolves the connection list for a worktree from your config, the repo's `.kowari.toml`, and the worktree's `.env`, including what Claude may do with each.
- `skills/kowari/`: the agent skill.
- `test/cli.test.ts`: runs the CLI end to end from a scratch git repo against a fixture database.
- `test/escape/`: the escape suite, its vectors, and the fixture that builds a database per test from a template.
- `spike/`: the driver comparison and the per-layer escape matrix, kept to re-run when Bun, postgres.js or Postgres changes; `screens.ts` writes TUI screenshots (`bun spike/screens.ts <dir>`) by driving the app on the test renderer and drawing each frame with headless Chrome.

## Testing

- Tests need the Postgres from `scripts/test-db` running (127.0.0.1:55433). Set `KOWARI_TEST_DATABASE_URL` to use another.
- postgres.js runs `sql.unsafe(text)` without parameters on the simple protocol, which accepts many statements. Anything that runs agent SQL passes `{ simple: false }`.
- TUI tests drive `App` on `createTestRenderer`. `waitForFrame` gives up after a number of render passes, not a time, so a frame that waits on the database needs a polling loop with real sleeps (`until` in `test/support/frames.ts`).
- The editor's highlight offsets do not count newlines; `App.highlight` converts the scanner's offsets.
- The editor's cursor and `setCursor` columns are display cells (tabs and wide characters count more than one); `App.cursorIndex` and `App.position` convert to and from string indexes.
- Tests never touch the real keyring or `~/.claude/settings.json`: pass `memoryKeyring()` and a scratch `claudeSettings` path to `App`, and a keyring to `openAgentSession`.
