# When kowari refuses

The message says why. Do not work around it with `psql`, `.env` credentials, or editing `.kowari.toml` or the user's kowari config: those refusals are the user's decisions.

- "Claude has no access to X": the user has not granted it. Tell them which connection you need and why. Inside komux, kowari asks the user about a local connection they have not decided on, in a form, and waits up to 100 seconds for an answer. Never answer that form yourself; it is the user's decision. If the question timed out, tell the user and run the command again when they are ready.
- "the user declined Claude access to X": they answered no. Do not ask kowari again; tell the user what you needed it for.
- "X is marked read-only, but its role ... could change the database": the role behind that connection has write privileges, so kowari will not let you use it as read-only. Tell the user; the fix is in the database's grants.
- "... is not allowed on a read-only connection": your statement writes, locks, or calls a function with side effects. Rewrite it as a plain read, or ask for a writable connection.
- "X is unavailable: VAR not set": the worktree's `.env` is missing a variable. Often the worktree's stack has not been bootstrapped yet.
