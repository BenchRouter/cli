# CLI follow-ups

These commands require server-side user authentication or APIs that do not exist
yet. Do not add client-only placeholders.

- User session: `login`, `logout`, `whoami` with a user-scoped `br_cli_` token.
- Repository management: `repo list`, `repo connect`, `repo upgrade`.
- Route management: `route list`, `route show`, `route archive`, `route unarchive`.
- Eval control: `eval run`, `eval list`, and `eval show`.
- Baseline changes: `route baseline set`.
- Billing: `billing status` and a browser-assisted `billing top-up`.
- API keys: `key list`, `key create`, and `key revoke`.
- Admin catalog work: `catalog review`, `catalog activity`, and identity mappings.

The server owns policy, routing, billing, and catalog mutations. The CLI should
remain a thin command, file-write, and presentation layer.

Before the CLI package ships, update the BenchRouter server's generated setup
packet and setup prompt so every generated command uses `@benchrouter/cli`.
