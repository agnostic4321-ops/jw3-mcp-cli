# degen paper mode (`--paper`) — spec

Paper-trading mode for `jw3 degen`: the full degen loop runs against a
**simulated book** and records its fills to the **Diary without venue
contact**, so a strategy proves itself before real money is risked.
No live trades: paper paths never call `execute_trade`, `set_exits`,
`close_position`, `cancel_order`, or `list_open_orders`.

## Commands

```
jw3 degen [--pair SOL/USDT] [--exchange kucoin] [--size 15] [--lev 2]
  [--max-heat 6] [--max-concurrent 2] [--activation-pct 0.25]
  [--bounceback-pct 0.08] [--polls 600] [--horizon 12] [--paper] [--json]
jw3 degen record --pair SOL/USDT --outcome win|loss|stop|scratch [--pnl …] [--paper] [--json]
jw3 degen paper-stats [--json]
```

## Semantics

1. **Identical pipeline.** `--paper` runs the same stages as live —
   volatility screen (`screenRow`), oracle confirm (`flat` = no trade,
   never a smaller trade), heat governor (`checkHeat`), ATR-derived plan
   (`planScalp`), step-2 averaging math — through the same pure functions.
   A paper pass means the live loop would have passed with the same tape.
2. **One ledger.** Paper state lives in the paper.ts ledger, not in
   degen-owned files: the `degen` account inside
   `~/.config/jw3/paper-accounts.json` (`JW3_CONFIG_HOME` override),
   positions + fills with strategy `degen`. Proving never consumes live
   heat or blocks live fire — the paper heat governor derives from the
   paper account (open paper stops, the day's sl fills) instead of a
   paper heat file. Legacy `degen-paper-heat.json` /
   `degen-paper-learning.jsonl` / `degen_paper_*.json` files are migrated
   once (run states → positions, matched `record` lines → closes) and
   renamed to `.migrated`; nothing writes them after that.
   Same caps, same halve-after-stop / flat-after-two / cooldown rules.
3. **Simulated fills, zero venue contact.** On a pass, a paper position
   opens in the `degen` paper account at plan prices (step-1 size at the
   touch price, taker fee, TP at the step-1 target, paper stop at the kill
   line). The ONLY network write is
   `propose_trade` (Diary setup, `trade:propose` scope — never
   `trade:execute`), with a `[PAPER]` thesis carrying entry/stop/size/TP/kill
   and the paper position/fill ids. No PAT → paper still records locally and says
   so; the local paper ledger is the source of truth, the Diary row is
   visibility. A `propose_trade` failure warns but never loses the local fill.
4. **Refused combinations (exit 2).** `--paper --yes`, `--paper --live`,
   `--paper --trail` are rejected: paper never fires, never arms a live
   trail, never needs `--yes` (nothing moves). Because `--yes` is refused,
   paper can never be one flag-flip away from real money.
5. **Close the loop.** `degen record --paper --outcome … [--pnl …]` closes
   the paper position in the `degen` account (exit derived from the
   recorded pnl at zero fee, entry when none) and applies stop counting
   (sl fills, plus red closes) / halve / cooldown to the paper book.
6. **Score the book.** `degen paper-stats` scores the `degen` account's
   fills: opens vs tp/sl/close outcomes, net USD, open risk. GO/NO-GO is
   a human call — paper-stats reports, never fires.

## Paper ledger schema (positions, not log lines)

- open: `openPaperPosition` with strategy `degen`, qty = step-1 sizeUsd /
  step-1 price, taker fee, tp = step-1 target, sl = kill line
- close: `closePaperPosition` by outcome — win → `tp`, stop/loss → `sl`,
  scratch → `close` (fee-free; pnl from the derived exit)
- heat: `paperHeatOf` derives opens / stops-today / heatUsd /
  lastStopAt from the account each run — no heat file

## Invariants (tested)

- Paper run makes zero fund-moving calls AND zero venue reads
  (`list_open_orders` included) — the only allowed tool call is
  `propose_trade`.
- `--paper --yes|--live|--trail` → exit 2, nothing written.
- Paper ledger path never equals the live heat/log paths.
- Live `degen record` never touches the paper book and vice versa.

## Non-goals / follow-ups

- No server changes in this wave: no new MCP tool, no migration. A future
  `record_paper_fill` MCP tool could write `diary_entries` directly
  (`perp_fill`, `exchange: "paper"` — the diary-sync record path already
  accepts freeform exchanges); until then `propose_trade` is the Diary
  surface and the local paper ledger is the backtest source of truth.
- No auto-close / mark-to-market on paper positions: outcomes are recorded by
  hand (`degen record --paper`), same as the live loop.
- No venue short-stop arming in paper either (TP-only doctrine carries over).
