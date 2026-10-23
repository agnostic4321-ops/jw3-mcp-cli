# paper accounts (`jw3 paper`) — local simulated perps book

Paper-trading accounts for `jw3`: named virtual-money books in one local
JSON file, simulated fills, virtual TP/SL legs, and a promote path that
renders the live ticket **without sending it**. Zero venue contact —
paper commands never call `execute_trade`, `set_exits`, `close_position`,
`cancel_order`, or `list_open_orders` (or any other MCP tool); there is no
transport in the paper module graph at all. The guard test
(`src/paper-guard.test.ts`) fails the suite if a fund-moving tool name or
transport import ever appears in the paper sources.

This is disjoint from `degen --paper` (see `PAPER_MODE.md`): that replays
the degen loop with simulated fills into the degen learning log; `jw3
paper` is a standalone multi-account simulated book with explicit prices.

## Commands

```
jw3 paper create --account NAME [--equity 10000] [--json]
jw3 paper fund --account NAME --amount 500 [--json]
jw3 paper reset --account NAME [--json]
jw3 paper list [--json]
jw3 paper execute --account NAME --pair SOL/USDT --side buy|sell (--qty … | --size-usd …) --price … [--lev 1] [--tp …] [--sl …] [--fee maker|taker] [--strategy TAG] [--json]
jw3 paper positions [--account NAME] [--pair …] [--strategy TAG] [--mark …] [--json]
jw3 paper fills [--account NAME] [--pair …] [--strategy TAG] [--limit 50] [--json]
jw3 paper pnl [--account NAME] [--json]
jw3 paper tick --pair SOL/USDT --price … [--account NAME] [--fee maker|taker] [--json]
jw3 paper promote --account NAME [--position-id …] [--pair …] [--exchange kucoin] [--json]
```

State: `~/.config/jw3/paper-accounts.json` (`JW3_CONFIG_HOME` override).
No PAT needed — everything is local. Bad input exits 2 and writes
nothing (a rejected execute/tick leaves the file byte-identical).

## Semantics

1. **Accounts are isolated books.** `create` opens a book with virtual
   equity (default $10,000); `fund` adds virtual cash (simulated deposit);
   `reset` restores initial equity and clears positions + fills (no exit
   fills are synthesized — reset is a fresh book); `list` shows every
   book's equity/cash/locked/realized/fees/open count.
2. **Explicit prices, no feed.** `execute` and `tick` take `--price`
   because paper has no venue feed — nothing is read from any exchange,
   so a paper fill can never be mistaken for a market fill.
3. **Margin-locked accounting.** Open locks `margin = notional / lev`
   plus the entry fee out of cash; close unlocks margin plus gross pnl
   minus the exit fee. `equity = cash + locked + unrealized(marks)`.
   Opens fail loudly on insufficient cash instead of going negative.
4. **Virtual TP/SL legs.** `execute --tp/--sl` arms legs (validated to
   the correct side of entry — a leg that would fill instantly is a typo
   and is rejected). `paper tick --pair … --price …` settles every open
   position on that pair whose leg the mark touched, filling at the LEG
   level. A tick through both legs settles at SL (conservative). A
   no-touch tick writes nothing.
5. **Fees match the backtest schedule.** Maker 0.02% / taker 0.06% per
   side (same constants as `backtest scalp --fee`), rounded to cents, on
   every open and close. Realized pnl is net of the exit fee.
6. **Strategy tags.** `--strategy TAG` (`[a-zA-Z0-9_.:-]{1,40}`) sticks
   to the position and all its fills; `positions`/`fills` filter by it and
   `pnl` breaks realized pnl down per tag.
7. **Promote never sends.** `paper promote` renders the equivalent live
   `jw3 execute … --yes` ticket (side/qty/lev/stop/tp mapped from the
   paper position) and prints it with a NOT SENT banner. It performs no
   writes and no calls — going live is always the operator's explicit act.

## Worked example

```
jw3 paper create --account desk --equity 10000
jw3 paper execute --account desk --pair SOL/USDT --side buy --qty 2 --price 100 --lev 2 --tp 110 --sl 95 --fee taker --strategy fade-a
jw3 paper tick --pair SOL/USDT --price 112        # settles the TP leg @ 110
jw3 paper pnl --account desk                      # realized +$19.87, fees $0.25
jw3 paper promote --account desk --pair SOL/USDT   # live ticket preview, NOT SENT
```

## Invariants (tested)

- Paper sources contain no fund-moving tool names and no transport
  import (`paper-guard.test.ts` greps them).
- Rejected input exits 2 with the store file untouched.
- TP/SL settle at leg levels; SL wins a both-legs tick.
- Reset clears positions/fills but never reuses ids.
- `promote` output carries `sent: false` (JSON) / NOT SENT (human) and
  performs zero writes.
