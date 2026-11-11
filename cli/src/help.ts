/**
 * The command registry: the argv paths the dispatcher routes and the usage
 * lines help prints for them.
 *
 * Both surfaces render from this one table:
 *   - `jw3 --help` / `jw3 -h` prints every usage line below, in this order;
 *   - `jw3 <command> --help`, `jw3 <command> -h`, `jw3 <command> <sub> --help`
 *     print the lines of the matching entry (a bare group word, e.g.
 *     `jw3 paper --help`, prints the whole group).
 *
 * The dispatcher intercepts a help request BEFORE any route runs, so help
 * never calls MCP, a venue, or writes/migrates state (see help.test.ts). A
 * retired command has no entry here and no route in index.ts; a help path is
 * only listed when a route matches it, pinned by help.test.ts.
 */

export type CommandHelp = {
  /**
   * Every argv path that resolves to this command, space-joined, first token
   * is the command word ("scalp start"). Spaced aliases are listed too
   * ("diary note").
   */
  paths: string[];
  /** Usage lines for those paths (each starts with "jw3 "). */
  usage: string[];
};

/** Registered commands, in dispatch order (top-level help prints them in this order). */
export const COMMANDS: CommandHelp[] = [
  {
    paths: ["auth", "auth login", "auth logout", "auth status"],
    usage: [
      `jw3 auth login|logout|status [--pat …] [--url …] [--browser] [--scope "mcp:read trade:propose"] [--timeout 300]`,
    ],
  },
  {
    paths: ["markets", "markets ending"],
    usage: ["jw3 markets ending [--days 14] [--min-liq 10000] [--limit 25] [--json]"],
  },
  {
    paths: ["analyze prediction"],
    usage: ["jw3 analyze prediction <slug|conditionId|id> [--json]"],
  },
  {
    paths: ["analyze trend"],
    usage: ["jw3 analyze trend --exchange kucoin --pair BTC/USDT [--json]"],
  },
  {
    paths: ["scalp", "scalp plan", "scalp start", "scalp watch", "scalp kill"],
    usage: [
      "jw3 scalp plan --pair SOL/USDT --long|--short [--size 15] [--steps 3] [--json]",
      "jw3 scalp start --pair SOL/USDT --long|--short [--exchange kucoin] [--size 15] [--steps 3] [--lev 2] [--yes]",
      "jw3 scalp watch --pair SOL/USDT [--polls 30] [--interval 10] [--json]",
      "jw3 scalp kill --pair SOL/USDT [--exchange kucoin] [--yes]",
    ],
  },
  {
    paths: ["trail"],
    usage: [
      "jw3 trail --pair SOL/USDT --side long|short --size 1 [--exchange kucoin] [--activation-pct 0.25] [--bounceback-pct|--backoff-pct 0.08] [--polls 600] [--live] [--yes] [--json]",
    ],
  },
  {
    paths: ["bounce"],
    usage: [
      "jw3 bounce --pair SOL/USDT --side short [--exchange kucoin] [--bounce-pct 0.4] [--lookback-min 60] [--size …] [--yes] [--json]",
    ],
  },
  {
    paths: ["tick"],
    usage: ["jw3 tick --pair SOL/USDT [--seconds 15] [--json]"],
  },
  {
    paths: ["klines"],
    usage: ["jw3 klines --pair SOL/USDT [--tf 5m|15m|1h|1d] [--limit 50] [--rsi] [--vwap] [--json]"],
  },
  {
    paths: ["loop"],
    usage: ["jw3 loop --exchange kucoin --pair SOL/USDT [--long|--short] [--size 15] [--json]"],
  },
  {
    paths: ["grid", "grid plan", "grid start", "grid backtest"],
    usage: [
      "jw3 grid plan|start --pair SEI/USDT [--bias long|short|neutral] [--step-pct 0.25] [--levels 25] [--size 15] [--lev 2] [--yes]",
      "jw3 grid backtest --pair SEI/USDT [--step-pct 0.25] [--levels 25] [--contracts 19] [--lev 2] [--days 30] [--json]",
    ],
  },
  {
    paths: ["daemon"],
    usage: ["jw3 daemon --config <manifest.json> [--once] [--allow-live] [--flatten-on-shutdown] [--json]"],
  },
  {
    paths: ["watchdog", "watchdog check", "watchdog run", "watchdog resume"],
    usage: [
      "jw3 watchdog check|run|resume [--exchange kucoin] [--poll-sec 15] [--flatten] [--actor NAME] [--once] [--json]",
    ],
  },
  {
    paths: ["monitor"],
    usage: ["jw3 monitor [--exchange kucoin] [--json]"],
  },
  {
    paths: ["alert"],
    usage: [
      "jw3 alert --snapshot <path> [--prev-snapshot <path>] [--state <path>] [--policy <path>] [--transport console|file] [--out <path>] [--json]",
    ],
  },
  {
    paths: ["learning", "learning record", "learning stats"],
    usage: [
      "jw3 learning record --pair BASE/USDT --side long|short --entry <px> --exit <px> [--reason <text>] [--pnl <usd>] [--fees <usd>] [--json]",
      "jw3 learning stats [--log <path>] [--json]",
    ],
  },
  {
    paths: ["backtest live"],
    usage: [
      "jw3 backtest live --pair SOL/USDT [--days 30] [--tf 15m] [--size 15] [--leverage 20] [--mode maker|chase|taker|all] [--json]",
    ],
  },
  {
    paths: ["live"],
    usage: [
      "jw3 live --pair BASE/USDT [--exchange kucoin] [--side long|short|auto] [--risk 3] [--size 15] [--session live] [--turn t1] [--yes] [--json]",
    ],
  },
  {
    paths: ["backtest scalp"],
    usage: ["jw3 backtest scalp --pair SOL/USDT [--days 30] [--tp 0.3] [--fee maker|taker] [--size 60] [--json]"],
  },
  {
    paths: ["farm", "farm run", "farm leaderboard"],
    usage: [
      "jw3 farm run [--pairs SOL/USDT,BTC/USDT,ETH/USDT] [--days 30] [--fee maker|taker] [--size 60] [--json]",
      "jw3 farm leaderboard [--json]",
    ],
  },
  {
    paths: [
      "paper",
      "paper create",
      "paper fund",
      "paper reset",
      "paper list",
      "paper execute",
      "paper positions",
      "paper fills",
      "paper pnl",
      "paper tick",
      "paper promote",
    ],
    usage: [
      "jw3 paper create --account NAME [--equity 10000] [--json]",
      "jw3 paper fund --account NAME --amount 500 [--json]",
      "jw3 paper reset --account NAME [--json]",
      "jw3 paper list [--json]",
      "jw3 paper execute --account NAME --pair SOL/USDT --side buy|sell (--qty … | --size-usd …) --price … [--lev 1] [--tp …] [--sl …] [--fee maker|taker] [--strategy TAG] [--json]",
      "jw3 paper positions [--account NAME] [--pair …] [--strategy TAG] [--mark …] [--json]",
      "jw3 paper fills [--account NAME] [--pair …] [--strategy TAG] [--limit 50] [--json]",
      "jw3 paper pnl [--account NAME] [--json]",
      "jw3 paper tick --pair SOL/USDT --price … [--account NAME] [--fee maker|taker] [--json]",
      "jw3 paper promote --account NAME [--position-id …] [--pair …] [--exchange kucoin] [--json]",
    ],
  },
  {
    paths: ["poly", "poly scan"],
    usage: ["jw3 poly scan [--json]"],
  },
  {
    paths: ["scan", "scan fade"],
    usage: ["jw3 scan fade [--exchange kucoin] [--min-chg 3] [--limit 12] [--json]"],
  },
  {
    paths: ["forecast"],
    usage: ["jw3 forecast --pair ETH/USDT [--horizon 12] [--json]"],
  },
  {
    paths: ["intel"],
    usage: ["jw3 intel <topic> [--limit 10] [--no-cache] [--json]"],
  },
  {
    paths: ["decide"],
    usage: ["jw3 decide --pair SOL/USDT [--exchange kucoin] [--json]"],
  },
  {
    paths: ["degen", "degen record", "degen paper-stats"],
    usage: [
      "jw3 degen [--pair SOL/USDT] [--exchange kucoin] [--size 15] [--lev 2] [--max-heat 6] [--max-concurrent 2] [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--horizon 12] [--trail] [--live] [--yes] [--paper] [--json]",
      "jw3 degen record --pair SOL/USDT --outcome win|loss|stop|scratch [--pnl …] [--paper] [--json]",
      "jw3 degen paper-stats [--json]",
    ],
  },
  {
    paths: ["ttm", "ttm plan"],
    usage: [
      "jw3 ttm --pair SOL/USDT --side long|short --equity 10 --base 5 --entry … --atr-pct 0.8 [--lev 25] [--sleeve momentum] [--activation-pct 0.25] [--bounceback-pct 0.08] [--json]",
    ],
  },
  {
    paths: ["spikes"],
    usage: [
      "jw3 spikes --exchange kucoin [--pairs GRAM,SOL,ETH,XBT,SUI,DOT,DOGE,PEPE,UNI] [--cycles 1] [--json]",
    ],
  },
  {
    paths: ["connections"],
    usage: ["jw3 connections [--json]"],
  },
  {
    paths: ["diary"],
    usage: ["jw3 diary [--day YYYY-MM-DD | --start-day YYYY-MM-DD --end-day YYYY-MM-DD] [--json]"],
  },
  {
    paths: ["diary-note", "diary note"],
    usage: [`jw3 diary-note --body "..." [--day YYYY-MM-DD] [--mode append|replace] [--json]`],
  },
  {
    paths: ["daily-prep", "daily prep"],
    usage: ["jw3 daily-prep [--dry] [--day YYYY-MM-DD] [--json]"],
  },
  {
    paths: ["risk"],
    usage: ["jw3 risk [--state] [--json]"],
  },
  {
    paths: ["insights"],
    usage: ["jw3 insights [--days 30] [--notional-usd 10000] [--fee-bps 5] [--json]"],
  },
  {
    paths: ["news"],
    usage: ["jw3 news [--pair BTC] [--source CoinDesk] [--limit 6] [--window-hrs 48] [--json]"],
  },
  {
    paths: ["propose"],
    usage: [
      "jw3 propose --pair BTC/USDT --side long --entry … --stop … [--asset BTC] [--venue kucoin] [--size-usd …] [--thesis …] [--timeframe 4h] [--json]",
    ],
  },
  {
    paths: ["propose-idea", "propose idea"],
    usage: [
      `jw3 propose-idea --pair BTC/USDT --side buy --entry … --stop … --target 70000[:0.5],75000 --thesis "…" [--rationale "…"] [--json]`,
    ],
  },
  {
    paths: ["propose-bracket", "propose bracket"],
    usage: [
      `jw3 propose-bracket --exchange kucoin --pair BTC/USDT --side buy --entry-type market --amount … --stop … --tp 70000:50,75000:50 --rationale "…" [--json]`,
    ],
  },
  {
    paths: ["propose-predict", "propose predict"],
    usage: [
      `jw3 propose-predict --market-id <id> --side yes --jev-verdict "…" --rationale "…" [--json]`,
    ],
  },
  {
    paths: ["propose-close-all", "propose close-all", "propose close", "propose close all"],
    usage: [`jw3 propose-close-all --rationale "…" [--exchange kucoin] [--pair BTC/USDT] [--json]`],
  },
  {
    paths: ["market"],
    usage: ["jw3 market --exchange binance --pair BTC/USDT [--json]"],
  },
  {
    paths: ["screener"],
    usage: ["jw3 screener [--exchange binance] [--json]"],
  },
  {
    paths: ["positions"],
    usage: ["jw3 positions [--exchange kucoin] [--pair BTC/USDT] [--watch SEC] [--polls N] [--json] [--json-lines]"],
  },
  {
    paths: ["balances"],
    usage: ["jw3 balances [--exchange kucoin] [--venue hyperliquid|aster|dydx|pacifica|polymarket|all] [--json]"],
  },
  {
    paths: ["orders"],
    usage: ["jw3 orders [--exchange kucoin] [--pair BTC/USDT] [--json]"],
  },
  {
    paths: ["order"],
    usage: ["jw3 order --exchange kucoin --order-id … [--pair …] [--market spot|futures] [--json]"],
  },
  {
    paths: ["fills"],
    usage: ["jw3 fills --exchange kucoin [--pair BTC/USDT] [--market spot|futures|all] [--days 30] [--limit 50] [--json]"],
  },
  {
    paths: ["pnl"],
    usage: ["jw3 pnl --exchange kucoin [--pair BTC/USDT] [--days 30] [--limit 100] [--json]"],
  },
  {
    paths: ["pnl-reconcile", "pnl reconcile"],
    usage: ["jw3 pnl-reconcile --exchange kucoin [--days 2] [--json]"],
  },
  {
    paths: ["onchain"],
    usage: ["jw3 onchain [--chains ethereum,solana] [--json]"],
  },
  {
    paths: ["execute"],
    usage: [
      "jw3 execute --exchange kucoin --pair BTC/USDT --side buy (--amount … | --risk-usd …) [--price …] [--market futures] [--leverage …] [--margin-mode cross|isolated] [--stop …] [--tp … | --tp-legs P1:S1,P2:S2] [--chase SECS [--chase-poll S] [--chase-max N] [--chase-take]] [--idempotency-key …] [--actor …] --yes [--json]",
    ],
  },
  {
    paths: ["close"],
    usage: ["jw3 close --exchange kucoin --pair BTC/USDT --side long|short [--size …] --yes [--json]"],
  },
  {
    paths: ["exits"],
    usage: ["jw3 exits --exchange kucoin --pair BTC/USDT [--sl …] [--tp …] [--market spot|futures] [--quantity …] --yes [--json]"],
  },
  {
    paths: ["cancel-all", "cancel all"],
    usage: ["jw3 cancel-all --exchange kucoin --pair BTC/USDT [--market spot|futures] --yes [--json]"],
  },
  {
    paths: ["cancel"],
    usage: ["jw3 cancel --exchange kucoin --order-id … [--pair …] [--market spot|futures] --yes [--json]"],
  },
  {
    paths: ["reconcile"],
    usage: ["jw3 reconcile --exchange kucoin --pair BTC/USDT [--json]"],
  },
  {
    paths: ["heat"],
    usage: ["jw3 heat [--exchange kucoin] [--min-free 50] [--json]"],
  },
  {
    paths: ["reserve", "reserve sweep"],
    usage: ["jw3 reserve sweep [--exchange kucoin] [--keep 10] [--currency USDT] [--yes] [--json]"],
  },
  {
    paths: ["defi", "defi protocols", "defi markets", "defi investments", "defi positions", "defi quote-lp", "defi build"],
    usage: [
      "jw3 defi protocols [--chain ethereum] [--category lending|staking|liquidity|yield|restaking|derivatives|rwa] [--limit 20] [--json]",
      "jw3 defi markets|investments [--chain ethereum] [--protocol aave-v3] [--token USDC] [--category lending] [--min-apy 3] [--limit 20] [--json]",
      "jw3 defi positions [--wallet 0x...] [--chain ethereum] [--protocol aave-v3] [--json]",
      "jw3 defi quote-lp --investment-id <id> --amount <amount> [--token-address 0x...] [--chain ethereum] [--json]",
      "jw3 defi build --action supply|redeem|borrow|repay|claim --investment-id <id> --wallet <addr> [--amount <amount>] [--token-address 0x...] [--chain ethereum] [--slippage-bps 50] [--no-simulate] [--json]",
    ],
  },
];

/** Every registered argv path, space-joined, in registry order (for tests/docs). */
export const REGISTERED_PATHS: string[] = COMMANDS.flatMap((entry) => entry.paths);

const BY_PATH = new Map<string, CommandHelp>();
for (const entry of COMMANDS) {
  for (const path of entry.paths) BY_PATH.set(path, entry);
}

/** Longest registered path (up to three tokens) that prefixes the argv tokens. */
function exactHelp(tokens: string[]): string | undefined {
  for (let n = Math.min(tokens.length, 3); n >= 1; n--) {
    const hit = BY_PATH.get(tokens.slice(0, n).join(" "));
    if (hit) return hit.usage.join("\n");
  }
  return undefined;
}

/**
 * Usage text for a help request, or undefined when the command is not
 * registered (the dispatcher then answers Unknown command). Accepts the raw
 * argv tail; flags are ignored, so `--help`/`-h`/`--json` never take part in
 * the lookup. A bare group word (`jw3 paper --help`) prints the whole group.
 */
export function helpFor(argv: ReadonlyArray<string | undefined>): string | undefined {
  const tokens = argv.filter((t): t is string => typeof t === "string" && !t.startsWith("-"));
  if (!tokens.length) return undefined;
  const exact = exactHelp(tokens);
  if (exact) return exact;
  const group = COMMANDS.filter((entry) => entry.paths.some((p) => p.split(" ")[0] === tokens[0]));
  if (!group.length) return undefined;
  return [...new Set(group.flatMap((entry) => entry.usage))].join("\n");
}

/** The full `jw3 --help` text. Version is single-sourced from cli/package.json. */
export function renderHelp(version: string): string {
  const usage = COMMANDS.flatMap((entry) => entry.usage)
    .map((line) => `  ${line}`)
    .join("\n");
  return `jw3 — JW3.ai command line (v${version})

Usage:
${usage}

Aliases: diary note, daily prep, pnl reconcile, propose <idea|bracket|predict|close-all|close all>, cancel all — spaced forms of the hyphenated commands.
Flag aliases (same meaning everywhere the option exists): --lev|--leverage, --tf|--timeframe, --bounceback-pct|--backoff-pct.

Global:
  --url <supabase-url>   override JW3_SUPABASE_URL
  --pat <pat>            one-shot PAT (prefers JW3_MCP_PAT env)
  --json                 machine output where supported

Auth: PAT jw3_mcp_… (Settings → Harness Access) or SIWX JWT as bearer.
Stored 0600 in ~/.config/jw3/credentials.json (JW3_CONFIG_HOME override).
Secrets never print, never enter the repo.`;
}
