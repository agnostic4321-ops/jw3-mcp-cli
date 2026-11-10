#!/bin/sh
# sync-edge-shared.sh — committed tide-over for harness _shared/agent-chat resolution.
#
# The functions under edge-functions/ import ../_shared/* and
# ../agent-chat/*, whose canonical home is the jw3_ai checkout
# (jw3_ai/supabase/functions/{_shared,agent-chat}). Those dirs are NOT
# vendored here: this script materializes them as gitignored copies so that
# `deno check`, `deno test`, and `supabase functions deploy` all resolve the
# same modules the app repo typechecks — including the open_orders,
# propose_diary_note, and news-brief-params surface. It replaces the previous
# throwaway-symlink step with a committed, repeatable one (copies, not
# symlinks: the Supabase bundler only sees real files under the staged tree).
#
#   scripts/sync-edge-shared.sh                 # sync + deno check (default)
#   scripts/sync-edge-shared.sh --deploy [fn…]  # sync + check + deploy
#                                               # (default fn: mcp-server)
#
# Env: JW3_AI_DIR (default: ../jw3_ai sibling checkout),
#      PROJECT_REF (default: the pinned Supabase project ref).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="${JW3_AI_DIR:-$ROOT/../jw3_ai}"
PROJECT_REF="${PROJECT_REF:-nzhbfeahymmyqerzjgbt}"

for d in "$SRC/supabase/functions/_shared" "$SRC/supabase/functions/agent-chat"; do
  if [ ! -d "$d" ]; then
    echo "❌ missing source dir: $d" >&2
    echo "   set JW3_AI_DIR to the jw3_ai checkout and retry." >&2
    exit 1
  fi
done

echo "→ syncing _shared + agent-chat from $SRC"
for name in _shared agent-chat; do
  rm -rf "$ROOT/edge-functions/$name"
  mkdir -p "$ROOT/edge-functions/$name"
  cp -R "$SRC/supabase/functions/$name/." "$ROOT/edge-functions/$name/"
  # Test suites ride with the app repo; they are not part of the deploy bundle.
  find "$ROOT/edge-functions/$name" -name '*_test.ts' -delete
done

# Hash-parity: the materialized copies must be byte-identical to the
# canonical sources (minus the stripped *_test.ts). A silent drift here
# ships a stale harness surface, so fail closed instead of deploying it.
for name in _shared agent-chat; do
  if ! diff -rq -x '*_test.ts' -x '.DS_Store' \
    "$SRC/supabase/functions/$name" "$ROOT/edge-functions/$name"; then
    echo "❌ $name drift: materialized edge-functions/$name differs from $SRC/supabase/functions/$name" >&2
    echo "   (excluding *_test.ts, which sync strips). Re-run the sync; if the" >&2
    echo "   source moved on purpose, this gate confirms you saw the diff." >&2
    exit 1
  fi
done
echo "✅ hash-parity clean (edge-functions/{_shared,agent-chat} match the jw3_ai checkout)"

# The committed tools ride these shared modules — fail closed if a source
# edit renames them instead of deploying a silently-stale surface.
grep -q "executeOpenOrdersRead" "$ROOT/edge-functions/agent-chat/read-tools.ts" \
  || { echo "❌ agent-chat/read-tools.ts lacks executeOpenOrdersRead (open_orders)"; exit 1; }
grep -q "NEWS_BRIEF_PARAMETERS" "$ROOT/edge-functions/agent-chat/news-brief.ts" \
  || { echo "❌ agent-chat/news-brief.ts lacks NEWS_BRIEF_PARAMETERS (news params)"; exit 1; }
grep -q "propose_diary_note" "$ROOT/edge-functions/mcp-server/tools.ts" \
  || { echo "❌ mcp-server/tools.ts lacks propose_diary_note (diary-note)"; exit 1; }
echo "✅ shared surface present (open_orders + diary-note + news-params)"

echo "→ deno check (harness functions)"
for fn in mcp-server mcp-auth mcp-oauth mcp-token; do
  deno check "$ROOT/edge-functions/$fn/index.ts"
done
echo "✅ deno check clean"

if [ "${1:-}" != "--deploy" ]; then
  echo "synced (deploy with: $0 --deploy [fn…])"
  exit 0
fi
shift

# Supabase deploys from <workdir>/supabase/functions/<name>, but this repo
# keeps sources under edge-functions/ (config under supabase/). Stage the
# standard layout in a temp dir so the repo layout never has to move.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/jw3-mcp-deploy.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/supabase/functions"
cp "$ROOT/supabase/config.toml" "$STAGE/supabase/config.toml"
# NOTE: no trailing slash on the source — on macOS `cp -R src/ dst` copies
# the CONTENTS, which would flatten every function into one dir.
for name in mcp-server mcp-auth mcp-oauth mcp-token _shared agent-chat; do
  cp -R "$ROOT/edge-functions/$name" "$STAGE/supabase/functions/"
done

if [ "$#" -eq 0 ]; then
  set -- mcp-server
fi
echo "→ supabase functions deploy $* (project $PROJECT_REF)"
supabase functions deploy --workdir "$STAGE" --project-ref "$PROJECT_REF" -- "$@"
