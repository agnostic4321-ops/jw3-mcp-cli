# @jw3/cli — JW3.ai command line (v0.1.0)

Thin wrapper over the `mcp-server` JSON-RPC surface. Read-only by
default; `propose` queues Diary setups for in-app approve-and-sign,
while `execute` / `close` / `exits` / `cancel` / `grid start` move real
money behind `--yes` plus server-side gates. Never touches keys.

Zero dependencies — Node 20+ builtins only (`fetch`, `node:util`,
`node:fs`). Isolated from the app bundle: own `tsconfig.json`,
excluded from `tsconfig.app.json` typecheck and the root vitest run
(`src/**` only); covered by root eslint like everything else.

## Run without installing

```bash
node cli/dist/index.js --help
# after `tsc -p cli/tsconfig.json`
```

## Commands

Common commands — complete list is `jw3 --help` (source of truth).

```bash
jw3 auth login|logout|status [--pat …] [--url …] [--browser] [--scope "mcp:read trade:propose"] [--timeout 300]
jw3 markets ending [--days 14] [--min-liq 10000] [--limit 25] [--json]
jw3 analyze prediction <slug|conditionId|id> [--json]
jw3 analyze trend --exchange kucoin --pair BTC/USDT [--json]
jw3 scan fade [--exchange kucoin] [--min-chg 3] [--limit 12] [--json]
jw3 forecast --pair ETH/USDT [--horizon 12] [--json]
jw3 intel <topic> [--limit 10] [--no-cache] [--json]
jw3 spikes --exchange kucoin [--pairs GRAM,SOL,ETH,XBT,SUI,DOT,DOGE,PEPE,UNI] [--cycles 1] [--json]
jw3 scalp plan --pair SOL/USDT --long|--short [--size 15] [--steps 3] [--json]
jw3 degen [--pair SOL/USDT] [--exchange kucoin] [--size 15] [--lev 2] [--max-heat 6] [--max-concurrent 2] [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--horizon 12] [--trail] [--live] [--yes] [--paper] [--json]
jw3 degen record --pair SOL/USDT --outcome win|loss|stop|scratch [--pnl …] [--paper] [--json]
jw3 degen paper-stats [--json]
jw3 ttm --pair SOL/USDT --side long|short --equity 10 --base 5 --entry … --atr-pct 0.8 [--lev 25] [--sleeve momentum] [--activation-pct 0.25] [--bounceback-pct 0.08] [--json]
jw3 trail --pair SOL/USDT --side long|short --size 1 [--exchange kucoin] [--activation-pct 0.25] [--bounceback-pct|--backoff-pct 0.08] [--polls 600] [--live] [--yes] [--json]
jw3 tick --pair SOL/USDT [--seconds 15] [--json]
jw3 vote --pair SOL/USDT [--exchange kucoin] [--horizon 12] [--json]
jw3 vote stats [--json]
jw3 vote record --pair SOL/USDT --outcome long|short|flat [--json]
jw3 grid plan|start --pair SEI/USDT [--bias long|short|neutral] [--step-pct 0.25] [--levels 25] [--size 15] [--lev 2] [--yes]
jw3 grid backtest --pair SEI/USDT [--step-pct 0.25] [--levels 25] [--contracts 19] [--lev 2] [--days 30] [--json]
jw3 backtest scalp --pair SOL/USDT [--days 30] [--tp 0.3] [--fee maker|taker] [--size 60] [--json]
jw3 poly scan [--json]
jw3 connections [--json]
jw3 diary [--day YYYY-MM-DD | --start-day YYYY-MM-DD --end-day YYYY-MM-DD] [--json]
jw3 daily-prep [--dry] [--day YYYY-MM-DD] [--json]
jw3 risk [--state] [--json]
jw3 propose --pair BTC/USDT --side long --entry … --stop … [--asset BTC] [--venue kucoin] [--size-usd …] [--thesis …] [--timeframe 4h] [--json]
jw3 market --exchange binance --pair BTC/USDT [--json]
jw3 screener [--exchange binance] [--json]
jw3 positions [--exchange kucoin] [--pair BTC/USDT] [--watch SEC] [--polls N] [--json] [--json-lines]
jw3 balances [--exchange kucoin] [--venue hyperliquid|aster|dydx|pacifica|polymarket|all] [--json]
jw3 orders [--exchange kucoin] [--pair BTC/USDT] [--json]
jw3 order --exchange kucoin --order-id … [--pair …] [--market spot|futures] [--json]
jw3 fills --exchange kucoin [--pair BTC/USDT] [--market spot|futures|all] [--days 30] [--limit 50] [--json]
jw3 pnl --exchange kucoin [--pair BTC/USDT] [--days 30] [--limit 100] [--json]
jw3 onchain [--chains ethereum,solana] [--json]
jw3 execute --exchange kucoin --pair BTC/USDT --side buy (--amount … | --risk-usd …) [--price …] [--market futures] [--leverage …] [--margin-mode cross|isolated] [--stop …] [--tp … | --tp-legs P1:S1,P2:S2] [--chase SECS [--chase-poll S] [--chase-max N] [--chase-take]] [--idempotency-key …] [--actor …] --yes [--json]
jw3 close --exchange kucoin --pair BTC/USDT --side long|short [--size …] --yes [--json]
jw3 exits --exchange kucoin --pair BTC/USDT [--sl …] [--tp …] [--market spot|futures] [--quantity …] --yes [--json]
jw3 cancel --exchange kucoin --order-id … [--pair …] [--market spot|futures] --yes [--json]
jw3 cancel-all --exchange kucoin --pair BTC/USDT [--market spot|futures] --yes [--json]
jw3 reconcile --exchange kucoin --pair BTC/USDT [--json]
jw3 supervise --trail SOL/USDT:long:1 [--loop kucoin:SOL/USDT] [--config manifest.json] [--once] [--json]
jw3d supervise …                   same supervisor via the jw3d alias (24/7 entrypoint)
```

- `markets ending` is unauthenticated (public Gamma read, same
  upstream `polymarket-proxy` fronts). Payouts shown are arithmetic
  `(1-p)/p`, not model edge.
- `analyze` needs a PAT and posts the same market+brief snapshot the
  in-app `JevPolymarketSection` sends to `analyze_market`
  (family `prediction`). Fail-closed: no PAT, no call, no verdict.
- `analyze trend` runs the JEV 7-timeframe verdict on a CEX pair via
  `analyze_market` with a server-built snapshot (family `cex`).
- `scan fade` crosses the MCP screener (gainers) with the public KuCoin
  futures tape (60×1h volumes + funding) and ranks exhaustion setups both
  ways: shorts (`fade-short` faded + near high / `strong` expanding /
  `late` >15% off high) and longs (`dip-long` sell-vol faded + near low /
  `capitulation` expanding dump / `extended` already bounced >15%).
  Columns include ATR% — the volatility all sizing derives from.
- `scalp plan` derives the whole mechanic from measured klines instead of
  fixed numbers: TP% = ATR×0.4 clamped 0.3–0.5, step spacing = ATR×0.9
  clamped 0.6–1.5%, sizes 1/1/2, averaged entry, moving TP, kill line one
  step past the last fill with its dollar cost. Plan only — never sends.
- `degen` unifies the aggressive-scalp loop in one command (dry-run
  default): volatility screen (fade-short/dip-long + measured ATR) →
  oracle confirm (Kronos+Laya ballot, flat = no trade) → heat-cap
  governor ($6 cap, max 2 concurrent, halve after one stop, flat after
  two, 1h cooldown) → 2-step scalp plan → step-2 resting average level
  with TP recalculated on the averaged entry → trail-entry ticket
  (`--trail` runs the supervisor inline) → JSONL learning-log
  (FINETUNE-READY at 100/200 windows). `--yes` fires step-1 + stages
  step-2 + arms TP-only exits; `degen record` closes the loop into
  heat + log. Shorts never arm an SL leg (TP-only + kill watch).
  `--paper` runs the same loop against a separate paper book
  (`degen-paper-heat.json` / `degen-paper-learning.jsonl`): simulated
  fills at plan prices, zero venue contact, Diary mirror via
  `propose_trade` ([PAPER] setup, propose scope only — never executes).
  Refuses `--yes`/`--live`/`--trail`. `degen record --paper` closes paper
  positions; `degen paper-stats` scores the book. Full spec:
  `cli/PAPER_MODE.md`.
- `trail` guards an open futures position with a ratcheting close-stop
  (public KuCoin futures ticker only — one GET per 3s poll, max 3600
  polls, no auth reads): entry is the first good mark, the stop arms on
  a +0.25% favorable move (default), tracks the peak, and market-closes
  on a 0.08% bounceback off the peak (defaults overridable). Dry-run
  default — a trigger logs WOULD-CLOSE and keeps state; `--yes` fires a
  real `close_position` (needs the `trade:execute` scope) and clears the
  per-base state file in `os.tmpdir()` on success. `--live` swaps the 3s
  REST marks for one public tickerV2 WS push (sub-second intra-poll stop
  trips, REST fallback when the feed goes stale); `tick` streams that
  same push for N seconds and reports push-rate vs one REST round trip.
- `spikes` is the spike monitor promoted into the CLI (public KuCoin
  futures REST only — ticker + depth20 + 1m klines, no auth, no trades):
  per-symbol baselines (120× 1m lots, trigger = max(3×med, p90, floor))
  then N snapshot cycles firing VOL_SPIKE, PRICE_THRUST, BOOK_IMBALANCE
  (|I| ≥ 0.40 top-5), SPREAD_WIDE (5bps majors / 10bps GRAM) and WALL
  (level ≥ 6× side median + min). Gaps record as GAP, never interpolated.
- `forecast` runs the public 15m KuCoin futures tape (400 bars, auto-paged)
  through the pretrained Kronos-small K-line foundation model on local CPU
  (~/kronos venv, no finetuning): direction + expected move % over the
  horizon (default 12 bars). No auth, no trades — oracle output only, and
  a single-window direction check is noise, not edge.
- `intel <topic>` is the web/social research brief (agent-reach incarnation,
  keyless, cached 15m per topic): topic-matched headlines off crypto RSS
  (Cointelegraph, CoinDesk, Decrypt) + social sentiment (StockTwits open
  tape + heuristic headline gauge — X search is login-gated, output says
  so) + funding/news catalysts (keyword-classified) with CoinGecko market
  context and a Fear & Greed gauge. Read-only, never trades.
- `vote` takes one confidence-weighted ballot across three skills — JEV
  trend (weight 1.0), Kronos oracle (0.5), RF-DETR chart-vision (0,
  abstains until wired) — and records it locally; `vote record` scores
  the latest open ballot against the realized outcome and auto-tunes each
  voting skill's weight off its rolling 20-ballot hit-rate (≥60% promote,
  ≤40% demote, min 5 samples, persisted in ~/.config/jw3/vote.json);
  `vote stats` shows weights and hit-rates. Read-only, never trades.
- `decide --pair X` builds one market-state JSON (trailing-24h tape stats
  off 60×1h futures klines, JEV 7-timeframe features, top-5 book imbalance
  + spread) and hands it to the Laya decide bridge (pure-stdlib v0 rules:
  JEV 1.0, tape 0.6, book 0.5, |score| ≥ 0.35 decides, else flat) for a
  long/short/flat choice with calibrated confidence. JEV attaches only
  when authenticated, otherwise the verdict caps at 0.65 confidence and
  says so. Read-only, never trades.
- `grid plan|start --bias long|short|neutral` builds a directional ladder
  (long seeds LONG covering every sell level, short mirrors, neutral runs
  flat) with live margin-vs-free check; `start --yes` fires the seed then
  all 50 limits and writes state for the refill watch.
- `grid backtest` replays 15m klines (200/request venue cap, auto-paged)
  through all three biases: fills, realized, inventory, range breaks,
  max adverse excursion. Closes-only, fee-flat, no spread — evidence, not
  promise.
- `connections`, `diary`, `daily-prep`, `risk` are authenticated MCP
  reads (`list_connections`, `read_diary_day`, `daily_prep`,
  `read_risk_limits`); `daily-prep` writes the diary brief unless
  `--dry`.
- `poly scan` lists the live short-horizon Polymarket windows
  (public Gamma read, no auth).
- `propose` queues a Diary setup via `propose_trade` for in-app
  approve-and-sign — never executes. Needs the `trade:propose` PAT
  scope or the server refuses (surfaced, not hidden).
- `positions` reads open derivatives positions (`read_live_datum` with
  venue exits); `--pair` filters client-side (canonical BTC/USDT form,
  XBT/flat/dashed all match), `--watch SEC` re-polls every SEC seconds
  (`--polls N` bounds it, `--json`/`--json-lines` emit one JSON object
  per line for piping). Read-only — never places, never closes.
- `execute`, `close`, `exits`, `cancel`, `cancel-all` move real money. Each prints a
  preview and sends nothing without `--yes`; the server re-checks
  YOLO eligibility, kill switch, caps and the fee-aware stop gate —
  a CLI yes never overrides a server no. They need the
  `trade:execute` scope:
  `jw3 auth login --browser --scope "mcp:read trade:propose trade:execute"`
  (mint requires kill switch off and autonomy != propose_only).
- `cancel-all` lists the pair's open orders (`--pair` required, never
  book-wide) and fans out one `cancel_order` per id, sequentially,
  re-checking the pair client-side so a venue that ignores the filter
  can't wipe the wrong book. A risk-limits kill-check
  (`checkLoopKill`/`loopKillReason`: kill switch → breaker → daily-loss
  cap → max trades) runs first and is disclosed, never blocking —
  cancels reduce risk. Scope refusal stops the fan-out.
- Spaced forms work for every hyphenated command (`diary note`,
  `daily prep`, `pnl reconcile`,
  `propose idea|bracket|predict|close-all`, `cancel all`); flag
  aliases `--lev|--leverage`, `--tf|--timeframe`,
  `--bounceback-pct|--backoff-pct` are accepted everywhere those options
  exist.
- `reconcile` audits one pair's local state (scalp/grid/trail files)
  against venue truth and reports strays. Read-only, never trades.
- `supervise` (`jw3d supervise`) is the 24/7 CLI supervisor: boot-time
  stale-order reconcile (read-only, offline-safe), one restarted child per
  `--trail PAIR:SIDE:SIZE` / `--loop EXCHANGE:PAIR` (or `--config`
  manifest.json), restart-with-backoff to `--max-restarts`, heartbeat file
  (`~/.config/jw3/supervise-heartbeat.json` every `--heartbeat-sec`,
  default 15s), size-capped log rotation (`~/.config/jw3/logs/`,
  5 MiB x 5). Children spawn WITHOUT `--yes` (dry-run) unless `--allow-live`
  plus manifest `yes: true`; `--once` prints the boot report + heartbeat
  with no processes spawned (cron-safe). Boot reconcile scans the OS
  tmpdir state files (`--state-dir` overrides the scan; trail children
  always write the OS tmpdir). Note: a kill -9 leaves a fresh unfinished
  trail state that refuses restart for up to 15 min (no-double-fire gate);
  raise `--max-restarts` to ride out the grace or remove the state by hand.

## Auth

PAT `jw3_mcp_…` (Settings → Harness Access) or SIWX JWT as bearer.
Precedence: `JW3_MCP_PAT` env > `~/.config/jw3/`
`credentials.json` (0600, `JW3_CONFIG_HOME` override). `--pat` is
debug-only: the secret leaks via shell history and the process list, so
the defaults are pipe (`echo "$PAT" | jw3 auth login`), env, or browser
login (`jw3 auth login --browser`). `login` verifies via `initialize`
before storing; `status` never prints the secret.
Endpoint defaults to the prod Supabase project
(`JW3_SUPABASE_URL` override).

Backups: `~/.config/jw3` holds secrets (`credentials.json`), so exclude
it from dotfile sync, Time Machine, and repo backups - or at minimum
exclude `credentials.json` (and any `*.key` / `*.pat` files). On a new
machine re-run `jw3 auth login` instead of copying the file.

## Verify

```bash
cd cli && npm test   # tsc build + node --test dist/
```

## Launch + auth

```bash
cd ~/Desktop/jw3-mcp-cli/cli
npm run build
node dist/index.js --help
node dist/index.js auth login --browser   # opens the app, Approve, done
node dist/index.js auth status            # verifies against prod
```

`--browser` is OAuth 2.1 + PKCE against the existing `mcp-oauth`
server: no paste, the PAT arrives via the code exchange and is stored
0600. Default scope `mcp:read trade:propose` (`--scope` overrides,
`--timeout` defaults 300s). Fallback without a browser:
`node dist/index.js auth login` (PAT at the prompt) or
`echo "$PAT" | node dist/index.js auth login`.

Non-interactive: `echo "$PAT" | node dist/index.js auth login`.
One-shot without storing: `JW3_MCP_PAT=… node dist/index.js risk`.
`--pat` also works one-shot but is debug-only (shell history, `ps`).
Optional global link: `npm link` (needs Node on PATH), then `jw3 …`
directly.
