# JW3 MCP + CLI

[![mcptry](https://mcptry.com/badge/io.github.agnostic4321-ops/jw3-mcp-cli.svg)](https://mcptry.com/servers/io.github.agnostic4321-ops/jw3-mcp-cli)

Listed in the official MCP Registry as `io.github.agnostic4321-ops/jw3-mcp-cli`
(remote, Streamable HTTP). Discovery (`initialize`, `tools/list`) is open;
every tool call needs OAuth sign-in or a scoped PAT.

Standalone harness repo: the MCP tool server (Supabase edge functions) and the
`jw3` command-line thin wrapper over its JSON-RPC surface.

Split out of `jw3_ai` (2026-10-26) to keep app and harness lifecycles separate.
The deployed function URLs are unchanged — same Supabase project, same slugs.

## Layout

- `cli/` — `@jw3/cli` (`jw3` / `jw3d` bins). Pure HTTP client of the
  mcp-server surface; no app imports. `pnpm --filter @jw3/cli build/test`.
- `edge-functions/` — Supabase edge functions, deployed to the same project:
  - `mcp-server` (gateway JWT off — harness PATs are the gate)
  - `mcp-auth`, `mcp-token`, `mcp-oauth` (token issuance / OAuth)

## Deploying functions

```sh
# Syncs edge-functions/{_shared,agent-chat} from the ../jw3_ai checkout
# (override with JW3_AI_DIR), runs deno check, then stages the standard
# supabase/functions layout in a temp dir and deploys.
scripts/sync-edge-shared.sh --deploy mcp-server
```

Direct `supabase functions deploy` from this root does NOT work: sources live
under `edge-functions/` (not `supabase/functions/`), and the `../_shared` +
`../agent-chat` imports only resolve after the sync step above (previously a
throwaway-symlink step — now this committed script; the copies are gitignored,
never committed). Sync-only (no deploy): run the script with no args.

`supabase/config.toml` pins the gateway flags (`verify_jwt = false` where the
harness PAT — not a JWT — is the credential).

## Parity contract

`jw3_ai/src/test/read-tool-parity.test.ts` reads this repo at the sibling path
`../jw3-mcp-cli/edge-functions/mcp-server/*` when present and skips otherwise.
Keep `read_live_datum` kinds and shared readers (`fetchOnchainSnapshot`,
`executeScreenerRead`, no inline `buildOnchainAggregate`) in sync with
`jw3_ai`'s `agent-chat/read-tools.ts` — the test enforces it locally.
