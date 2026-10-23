# JW3 MCP + CLI

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
supabase link --project-ref nzhbfeahymmyqerzjgbt
supabase functions deploy mcp-server
```

`supabase/config.toml` pins the gateway flags (`verify_jwt = false` where the
harness PAT — not a JWT — is the credential).

## Parity contract

`jw3_ai/src/test/read-tool-parity.test.ts` reads this repo at the sibling path
`../jw3-mcp-cli/edge-functions/mcp-server/*` when present and skips otherwise.
Keep `read_live_datum` kinds and shared readers (`fetchOnchainSnapshot`,
`executeScreenerRead`, no inline `buildOnchainAggregate`) in sync with
`jw3_ai`'s `agent-chat/read-tools.ts` — the test enforces it locally.
